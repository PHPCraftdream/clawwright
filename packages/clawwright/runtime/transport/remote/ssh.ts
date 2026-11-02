// Target is a remote host reached over SSH.
//
// Commands are passed as an argument array all the way through: ssh joins them into a
// single remote command line, so anything containing spaces is quoted here rather than
// hoping the remote shell agrees with us.

import { listFilesVia } from "../../../security/transport-listing.ts";
import { shellQuote } from "../../../core/io/shell.ts";
import type { CommandFailure, ExecOptions, ExecResult, Transport } from "../exec.ts";
import { spawnLocal, isWrapperFailureCode, composeExecFailure, TransportUnreachableError } from "../exec.ts";
import { existsVia, privateWriteCommand, publishCommand, withEnvPrefix } from "../quoting.ts";

/** Lines ssh writes for its own connection failures (exit 255 alone is ambiguous). */
const SSH_OWN_FAILURE = [
  /^ssh: /m,
  /Connection refused/,
  /Connection timed out/,
  /Operation timed out/,
  /Could not resolve hostname/,
  /Permission denied \(/,
  /Host key verification failed/,
  /kex_exchange_identification/,
  /No route to host/,
];

/** Whether ssh failed for its own reason rather than the remote command's exit status. */
function isSshOwnFailure(code: number, stderr: string): boolean {
  if (isWrapperFailureCode(code)) return true;
  return code === 255 && SSH_OWN_FAILURE.some((pattern) => pattern.test(stderr));
}

/** Killing the local ssh client does not stop the remote command: without a pty sshd sends it no
 *  signal. The deadline is therefore also enforced on the target — by `timeout` where it exists
 *  (it signals the whole process group), else by a watchdog in plain sh (macOS has no `timeout`)
 *  — and keeps working once the connection is gone. The watchdog keeps stdin (fd 3: a background
 *  job would get /dev/null) and detaches its own output so ssh does not wait on it. It runs the
 *  command as a process-group leader (`setsid`, else job control) and signals the group so the
 *  command's children die too. Where neither works (job control needs a tty on dash) it signals the
 *  command's process tree, walked once via `ps` before the first signal. */
function withRemoteDeadline(remote: string, timeoutMs: number | undefined): string {
  if (timeoutMs === undefined) return remote;
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const tree =
    "d() { echo $1; for c in $(ps -A -o pid= -o ppid= 2>/dev/null | while read a b; do [ \"$b\" = \"$1\" ] && echo $a; done); do d $c; done; }; ";
  const watchdog =
    "if command -v setsid >/dev/null 2>&1; then g=setsid; else g=; set -m 2>/dev/null; fi; " +
    `${tree}exec 3<&0; $g ${remote} <&3 3<&- & p=$!; set +m 2>/dev/null; ` +
    `( sleep ${seconds}; kill -TERM -- -$p 2>/dev/null || { t=$(d $p); kill -TERM $t 2>/dev/null; }; ` +
    "sleep 5; kill -KILL -- -$p 2>/dev/null || kill -KILL $t $p 2>/dev/null ) >/dev/null 2>&1 </dev/null & w=$!; " +
    "wait $p; r=$?; kill $w 2>/dev/null; exit $r";
  return `if command -v timeout >/dev/null 2>&1; then exec timeout -k 5 ${seconds} ${remote}; fi; ${watchdog}`;
}

export class SshTransport implements Transport {
  readonly description: string;
  readonly cancellation = "local-only" as const;
  #host: string;

  constructor(host: string) {
    this.#host = host;
    this.description = `ssh:${host}`;
  }

  /** Minimal single-quote quoting for the remote shell. */
  static quote(argument: string): string {
    return shellQuote(argument);
  }

  async exec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    const [head, rest] = withEnvPrefix(command, args, options.env, options.unsetEnv);
    const remote = withRemoteDeadline([head, ...rest].map(SshTransport.quote).join(" "), options.timeoutMs);
    const sshArgs = [this.#host, remote];
    let result: ExecResult;
    try {
      // allowFailure is forced: stderr must be seen before the failure can be classified.
      result = await spawnLocal("ssh", sshArgs, { ...options, allowFailure: true });
    } catch (error) {
      throw new TransportUnreachableError(
        `${this.description}: ssh failed before reaching the target — ${(error as Error).message}`,
        "check that ssh is installed and on PATH",
      );
    }
    // Our own deadline killing ssh can look exactly like ssh's own connection failure —
    // isSshOwnFailure can't tell them apart. result.timedOut can, checked first.
    if (result.timedOut === true) {
      if (options.allowFailure === true) return result;
      const error = composeExecFailure("ssh", sshArgs, result) as CommandFailure;
      error.timedOut = true;
      throw error;
    }
    if (isSshOwnFailure(result.code, result.stderr)) {
      const detail = result.stderr.trim() || result.stdout.trim() || "no output";
      throw new TransportUnreachableError(
        `${this.description} is unreachable — ssh exited ${result.code}: ${detail}`,
        "check OC_SSH_HOST — test the connection with `ssh -o BatchMode=yes <host> true`",
      );
    }
    if (result.code !== 0 && options.allowFailure !== true) throw composeExecFailure("ssh", sshArgs, result);
    return result;
  }

  async readFile(path: string): Promise<string> {
    const result = await this.exec("cat", [path]);
    return result.stdout;
  }

  async writeFile(path: string, content: string | Uint8Array, mode?: string): Promise<void> {
    const [command, args] = publishCommand(path);
    await this.exec(command, args, { input: content });
    if (mode !== undefined) await this.exec("chmod", [mode, path]);
  }

  writePrivateFile(path: string, content: string | Uint8Array): Promise<void> {
    const [command, args] = privateWriteCommand(path);
    return this.exec(command, args, { input: content }).then(() => undefined);
  }

  mkdirPrivate(path: string): Promise<void> {
    return this.exec("mkdir", ["-m", "700", path]).then(() => undefined);
  }

  exists(path: string): Promise<boolean> {
    return existsVia((command, args, options) => this.exec(command, args, options), path);
  }

  async mkdirp(path: string): Promise<void> {
    await this.exec("mkdir", ["-p", path]);
  }

  async remove(path: string): Promise<void> {
    await this.exec("rm", ["-rf", path]);
  }

  async removeEmptyDir(path: string): Promise<void> {
    await this.exec("rmdir", ["--", path]);
  }

  async removeEmptyTree(path: string): Promise<boolean> {
    if (!(await this.exists(path))) return false;
    const result = await this.exec("find", [path, "-depth", "-type", "d", "-empty", "-delete"]);
    if (result.code !== 0) throw new Error(`could not remove empty directories under ${path}: ${result.stderr.trim()}`);
    return !(await this.exists(path));
  }

  listFiles(dir: string): Promise<string[]> {
    return listFilesVia((command, args, options) => this.exec(command, args, options), dir);
  }

  get host(): string {
    return this.#host;
  }

  clientInvocation(entryPath: string, args: string[]): { command: string; args: string[] } {
    return { command: "ssh", args: [this.#host, entryPath, ...args] };
  }
}

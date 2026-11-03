// Target lives in a WSL distribution while the tooling runs on Windows Node. Split out of
// transport.ts to keep that file a thin facade over the per-transport implementations.
//
// Every call is wrapped in `wsl.exe -d <distro> --exec …`; file access goes through the same
// channel, because the Windows side cannot rely on \\wsl$ paths behaving like POSIX. `--exec`
// is required here: the plain `--` form sends the command line through the distribution's
// default shell, which expands literal `$()` and backticks in otherwise safe argv values.

import { listFilesVia } from "../../security/transport-listing.ts";
import { shellQuote } from "../../core/io/shell.ts";
import type { CommandFailure, ExecOptions, ExecResult, Transport } from "./exec.ts";
import { spawnLocal, isWrapperFailureCode, composeExecFailure, TransportUnreachableError } from "./exec.ts";
import { existsVia, privateWriteCommand, publishCommand, withEnvPrefix } from "./quoting.ts";

/** wsl.exe writes its own errors in UTF-16LE; read as UTF-8 they carry a NUL after every
 *  character, which stripping recovers. Shared with parseWslDistroListing. */
export function stripWslNuls(text: string): string {
  return text.replaceAll("\u0000", "");
}

export class WslTransport implements Transport {
  readonly description: string;
  readonly cancellation = "unsupported" as const;
  // Native private field, not a TypeScript `private` parameter property: Node executes
  // TypeScript by erasing types only, so anything that would need code generation
  // (parameter properties, enum, namespace, decorators) is unavailable project-wide.
  #distro: string;

  constructor(distro: string) {
    this.#distro = distro;
    this.description = `wsl:${distro}`;
  }

  async exec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    const [head, rest] = withEnvPrefix(command, args, options.env, options.unsetEnv);
    const wslArgs = ["-d", this.#distro, "--exec", head, ...rest];
    let result: ExecResult;
    try {
      // allowFailure is forced: the exit code must be seen before it can be classified.
      result = await spawnLocal("wsl.exe", wslArgs, { ...options, allowFailure: true });
    } catch (error) {
      // Launch or stdin failure only; a non-zero exit cannot throw here.
      throw new TransportUnreachableError(
        `${this.description}: wsl.exe failed before reaching the target — ${(error as Error).message}`,
        "check that wsl.exe is installed and on PATH (`wsl.exe --status`)",
      );
    }
    // Our own deadline killing wsl.exe looks identical, code-wise, to wsl.exe failing to
    // reach the distro — isWrapperFailureCode can't tell them apart. result.timedOut can, so
    // it's checked first: a slow command must never be reported as TARGET_UNREACHABLE.
    if (result.timedOut === true) {
      if (options.allowFailure === true) return result;
      const error = composeExecFailure("wsl.exe", wslArgs, result) as CommandFailure;
      error.timedOut = true;
      throw error;
    }
    if (isWrapperFailureCode(result.code)) {
      const detail = stripWslNuls(result.stderr).trim() || stripWslNuls(result.stdout).trim() || "no output";
      throw new TransportUnreachableError(
        `${this.description} is unreachable — wsl.exe exited ${result.code}: ${detail}`,
        "check OC_WSL_DISTRO — list the real names with `wsl.exe -l -q`",
      );
    }
    if (result.code !== 0 && options.allowFailure !== true) throw composeExecFailure("wsl.exe", wslArgs, result);
    return result;
  }

  async readFile(path: string): Promise<string> {
    const result = await this.exec("cat", [path]);
    return result.stdout;
  }

  async writeFile(path: string, content: string | Uint8Array, mode?: string): Promise<void> {
    // Publish via publishCommand(): temp sibling renamed over the name, never a write
    // through a symlink that is already there.
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

  /** Which distribution this transport talks to — the path bridge needs it for UNC paths. */
  get distro(): string {
    return this.#distro;
  }

  clientInvocation(entryPath: string, args: string[]): { command: string; args: string[] } {
    // A single shell argument avoids MSYS rewriting a bare /mnt/... path.
    const cut = entryPath.lastIndexOf("/");
    const directory = cut < 0 ? "." : entryPath.slice(0, cut) || "/";
    const entry = entryPath.slice(cut + 1);
    // No `&&`: a Windows scheduler line nests this in quotes cmd.exe does not see through.
    const inner = `set -e; cd -- ${shellQuote(directory)}; exec ${[shellQuote(`./${entry}`), ...args.map(shellQuote)].join(" ")}`;
    return { command: "wsl.exe", args: ["-d", this.#distro, "--exec", "bash", "-lc", inner] };
  }
}

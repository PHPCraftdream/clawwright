// The transport contract (ExecOptions/ExecResult/Transport) and the one implementation that
// needs no target at all: spawning a process locally. Every transport implements Transport;
// WslTransport and SshTransport both route exec() through spawnLocal underneath.
//
// Rule for everything built on top: never touch target files with node:fs directly. The
// target may not share a filesystem with us. Go through the transport. All operations are
// async by design — no *Sync calls anywhere.

import { spawn } from "node:child_process";
import { maskSecrets, UserError } from "../../core/io/log.ts";
import { manual } from "../../core/io/invocation/advice.ts";
import { outputSink, recordStreamedStdout } from "../../core/io/output.ts";
import { meaningfulLines, describeInvocation, noiseFilteredForwarder } from "./spawn-failure.ts";
import { clearSsjackEnvironment } from "./remote/ssjack-contract.ts";

export interface ExecOptions {
  /** Bytes are passed through unchanged; strings retain the existing UTF-8 behavior. */
  input?: string | Uint8Array;
  /** Stream output live; capture it when input or an output sink requires pipes. */
  stream?: boolean;
  /** Duplex process stdio, using safe pipes and exact bytes, without capturing stdout.
   *  Mutually exclusive with finite input; stderr diagnostics are bounded. */
  stdioProtocol?: boolean;
  env?: Record<string, string>;
  /** Remove these inherited names without putting their values in a command argument. */
  unsetEnv?: string[];
  allowFailure?: boolean;
  timeoutMs?: number;
  /** Abort the child (same SIGTERM→SIGKILL tree kill the timeout uses) when this signal
   *  fires. Cancellation for callers that own a longer-lived scope than one call. */
  signal?: AbortSignal;
}

export interface ExecResult {
  code: number;
  /** UTF-8-decoded text: a captured stream's bytes that are not valid UTF-8 arrive as
   *  U+FFFD, not the original bytes (readFile documents the same loss; the streaming
   *  terminal path passes the child's bytes through). Binary output needs a byte-safe
   *  channel — target-side base64 or a mount, not a captured stream. */
  stdout: string;
  /** As stdout: UTF-8-decoded, lossy for non-UTF-8 bytes. */
  stderr: string;
  /** The deadline (timeoutMs) killed the child — `code` is the signal-terminated remnant
   *  (usually -1), not the command's own exit status. Absent otherwise. A transport built on
   *  spawnLocal needs this to tell "my own deadline fired" apart from "the wrapper failed for
   *  an unrelated reason" — both often collapse to the same negative code. */
  timedOut?: true;
}

/** A rejected spawnLocal() call: `fullCommand` (masked) is the argv `message`'s headline was shortened from; read by entry/cli.ts under OC_DEBUG=1. */
export interface CommandFailure extends Error {
  fullCommand?: string;
  /** Set alongside `fullCommand` when the rejection was the timeoutMs deadline, not the
   *  command's own non-zero exit — see ExecResult.timedOut. */
  timedOut?: true;
}

/** wsl.exe or ssh itself failing to reach the target (as opposed to a command that ran there and
 *  failed); `nextAction` names the specific thing to check. A UserError carrying that remedy as
 *  advice, so every surface spells it the one way — the console arrow line (formatError), the
 *  --json failure document and the MCP envelope (execute.ts/call.ts lift UserError advice). */
/** The Advice every unreachable refusal carries, by construction: a site that cannot name
 *  a more specific next step still hands the operator the connection checklist. */
export const TRANSPORT_UNREACHABLE_NEXT_STEP =
  "check the target connection: OC_TARGET_LOCATION (local/wsl/ssh), OC_WSL_DISTRO, OC_SSH_HOST";

export class TransportUnreachableError extends UserError {
  readonly nextAction?: string;
  constructor(message: string, nextAction?: string) {
    super(message, { advice: [manual(nextAction ?? TRANSPORT_UNREACHABLE_NEXT_STEP)] });
    this.name = "TransportUnreachableError";
    this.nextAction = nextAction;
  }
}

/** A target's own exit status is 0-255; anything else means wsl.exe/ssh failed first. */
export function isWrapperFailureCode(code: number): boolean {
  return code < 0 || code > 255;
}

/** Windows reports a negative exit code unsigned (4294967295); this restores -1. */
export function toSignedExitCode(code: number): number {
  return code > 0x7fffffff ? code - 0x100000000 : code;
}

/** The rejection spawnLocal() builds for a non-zero exit, for transports that classify first. */
export function composeExecFailure(command: string, args: string[], result: ExecResult): CommandFailure {
  // Prefer stderr over stdout, but only past Compose's noise: a stderr left with nothing
  // else must not shadow a stdout that has the real reason.
  const stderrLines = meaningfulLines(result.stderr);
  const stdoutLines = meaningfulLines(result.stdout);
  const detail = (stderrLines.length > 0 ? stderrLines : stdoutLines).slice(0, 5).join("\n");
  // Masked: the arguments may carry a token, and the child's own output may echo it back.
  const error = new Error(
    maskSecrets(`${describeInvocation(command, args)} failed (exit ${result.code})${detail ? `: ${detail}` : ""}`),
  ) as CommandFailure;
  // Full argv, not in the message by default (Compose plumbing saying nothing about the
  // failure) but never discarded: OC_DEBUG=1 (entry/cli.ts) prints it.
  error.fullCommand = maskSecrets(`${command} ${args.join(" ")}`);
  return error;
}

export interface Transport {
  /** Human-readable name for diagnostics: "local", "wsl:Ubuntu-24.04", "ssh:user@host". */
  readonly description: string;
  /** Temporary keeper scope: no shared checkout, persistent invocation or implicit second hop. */
  readonly sessionScoped?: true;
  /** True only when aborting the local child confirms target-command termination. */
  readonly cancellation?: "confirmed-local" | "local-only" | "unsupported";
  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
  /** Reads UTF-8 text only; decoding binary files is lossy. For archives, use exec with
   *  target-side base64 and decode on the operator, or a binary-safe scp/rsync transfer. */
  readFile(path: string): Promise<string>;
  /** Writes text as UTF-8 or byte content without a decoding round trip. */
  writeFile(path: string, content: string | Uint8Array, mode?: string): Promise<void>;
  /** Creates a new owner-only file without exposing its contents during the write. */
  readonly writePrivateFile?: (path: string, content: string | Uint8Array) => Promise<void>;
  /** Creates a new owner-only directory and refuses an existing path. */
  readonly mkdirPrivate?: (path: string) => Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Final-leaf lstat presence; unknown traversal/errors throw, never imply absence. */
  readonly existsEntry?: (path: string) => Promise<boolean>;
  mkdirp(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Removes one empty directory, preserving any contents on failure. */
  readonly removeEmptyDir?: (path: string) => Promise<void>;
  /** Removes only empty directories below path; returns whether path itself was removed. */
  readonly removeEmptyTree?: (path: string) => Promise<boolean>;
  /** Every regular file under `dir`, recursively, as POSIX-style paths relative to it. A
   *  missing directory is an empty list, not an error. A newline in a filename is not
   *  supported (remote implementations parse a line-oriented listing). */
  listFiles(dir: string): Promise<string[]>;
  /** How an external client (an MCP client, a scheduler) should invoke a command of ours
   *  so that it reaches the target. Belongs here because only the transport knows whether
   *  a wrapper such as wsl.exe or ssh is needed. */
  clientInvocation(entryPath: string, args: string[]): { command: string; args: string[] };
}

export const STDIN_DELIVERY_FAILED = "failed to deliver stdin";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validateEnvNames(names: string[]): void {
  const invalid = names.filter((name) => !ENV_NAME.test(name));
  if (invalid.length > 0) throw new Error(`invalid environment variable name: ${invalid.join(", ")}`);
}

function unsetInheritedEnvironment(environment: Record<string, string | undefined>, names: string[]): void {
  if (process.platform !== "win32") {
    for (const name of names) delete environment[name];
    return;
  }
  const removed = new Set(names.map((name) => name.toLowerCase()));
  for (const name of Object.keys(environment)) {
    if (removed.has(name.toLowerCase())) delete environment[name];
  }
}

/** `root` and its descendants per `ps`, parents first; only `root` without ps; none on Windows,
 *  where the caller signals the child itself. */
async function processTree(root: number): Promise<number[]> {
  if (process.platform === "win32") return [];
  const listing = await new Promise<string | undefined>((settle) => {
    const ps = spawn("ps", ["-A", "-o", "pid=", "-o", "ppid="], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    ps.stdout.on("data", (chunk: Buffer) => { out += String(chunk); });
    ps.on("error", () => settle(undefined));
    ps.on("close", (code) => settle(code === 0 ? out : undefined));
  });
  if (listing === undefined) return [root];
  const children = new Map<number, number[]>();
  for (const line of listing.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid === undefined || ppid === undefined || !Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const tree: number[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    tree.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return tree;
}

/** The pure stdio decision behind spawnLocal: a run that streams to a real terminal
 *  inherits stdout/stderr (its stdin stays piped when finite input is delivered), everything
 *  else — captured, piped, non-terminal — is piped so the output is collectable. Exported so
 *  the check can pin the decision without spawning a child. */
export function spawnStdio(streamToTerminal: boolean, hasInput: boolean): ["pipe" | "inherit", "inherit" | "pipe", "inherit" | "pipe"] {
  if (!streamToTerminal) return ["pipe", "pipe", "pipe"];
  return [hasInput ? "pipe" : "inherit", "inherit", "inherit"];
}

/** Whether a child's output goes straight to this process's terminal. Finite input is NOT a
 *  factor: it only keeps the child's stdin piped (see spawnStdio), so a --stdin run still
 *  shows its output. */
export function terminalStreaming(facts: {
  readonly protocol: boolean; readonly stream: boolean | undefined; readonly hasSink: boolean;
  readonly stdoutTty: boolean; readonly stderrTty: boolean;
}): boolean {
  return !facts.protocol && facts.stream === true && !facts.hasSink && facts.stdoutTty && facts.stderrTty;
}

/** Spawns a process locally. Arguments are passed as an array — never a shell string —
 *  so quoting is impossible to get wrong. */
export function spawnLocal(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    validateEnvNames(Object.keys(options.env ?? {}));
    validateEnvNames(options.unsetEnv ?? []);
    if (options.stdioProtocol === true && options.input !== undefined) {
      throw new Error("stdioProtocol cannot be combined with finite input");
    }
    const protocol = options.stdioProtocol === true;
    // Streaming means "watch it happen on a real terminal", not merely "no sink": a plain
    // pipe has no sink either, but inheriting stdio onto it wires wsl.exe straight to an MSYS
    // pipe on Windows — Node dies with exit 139 the moment the child writes. Finite input
    // only forces the child's stdin to stay piped (the bytes arrive via child.stdin.end
    // below); stdout/stderr still inherit, so a --stdin run's output is not swallowed.
    const sink = outputSink();
    const streamToTerminal = terminalStreaming({
      protocol, stream: options.stream, hasSink: sink !== undefined,
      stdoutTty: process.stdout.isTTY === true, stderrTty: process.stderr.isTTY === true,
    });

    const environment = { ...process.env, ...options.env };
    clearSsjackEnvironment(environment);
    unsetInheritedEnvironment(environment, options.unsetEnv ?? []);

    const child = spawn(command, args, {
      stdio: spawnStdio(streamToTerminal, options.input !== undefined),
      env: environment,
    });
    // A deadline ends the child's whole tree: its own children would outlive it and hold the
    // output pipes open. Walked, not a new process group — that would cut it off from Ctrl+C.
    const doomed = new Set<number>();
    const killTree = async (signal: NodeJS.Signals): Promise<void> => {
      if (child.pid !== undefined) for (const pid of await processTree(child.pid)) doomed.add(pid);
      if (doomed.size === 0) {
        child.kill(signal);
        return;
      }
      for (const pid of doomed) {
        try {
          process.kill(pid, signal);
        } catch {
          // Already gone.
        }
      }
    };

    let stdout = "";
    let stderr = "";
    let launchError: Error | undefined;
    let inputError: Error | undefined;
    // OC_DEBUG=1 wants the undiluted byte stream. streamToTerminal inherits stdio directly,
    // so these "data" handlers never fire for it anyway.
    const debug = process.env.OC_DEBUG === "1";
    // Record bytes that reach the real stdout, so the --json failure contract (entry/cli.ts)
    // sees a streaming child's own output and never appends a second document after it. The
    // inherit path (streamToTerminal) bypasses these handlers and cannot be counted — the
    // contract's declaration gate covers it instead.
    const toRealStdout = (text: string): void => {
      recordStreamedStdout(Buffer.byteLength(text));
      process.stdout.write(text);
    };
    const forwardStdout = protocol || debug ? undefined : noiseFilteredForwarder((text) => { if (sink !== undefined) sink(text); else toRealStdout(text); });
    const forwardStderr = protocol || debug ? undefined : noiseFilteredForwarder((text) => { if (sink !== undefined) sink(text); else process.stderr.write(text); });

    if (protocol) {
      // Never inherit Windows/MSYS pipe descriptors. Node relays with backpressure,
      // without decoding, filtering, progress sinks, or accumulating protocol responses.
      child.stdout?.pipe(process.stdout, { end: false });
      child.stdout?.on("data", (chunk: Buffer) => recordStreamedStdout(chunk.length));
      child.stderr?.pipe(process.stderr, { end: false });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-8192);
      });
    } else {
      // setEncoding keeps a multibyte character split across chunks whole.
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
        if (options.stream === true) {
          if (forwardStdout !== undefined) forwardStdout.push(chunk);
          else if (sink !== undefined) sink(chunk);
          else toRealStdout(chunk);
        }
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
        if (options.stream === true) {
          if (forwardStderr !== undefined) forwardStderr.push(chunk);
          else if (sink !== undefined) sink(chunk);
          else process.stderr.write(chunk);
        }
      });
    }

    const stopInputRelay = () => {
      if (!protocol || child.stdin === null) return;
      process.stdin.unpipe(child.stdin);
      process.stdin.pause();
    };
    child.stdin?.on("close", stopInputRelay);

    // SIGTERM first, SIGKILL after a grace period: a child that ignores SIGTERM would
    // otherwise outwait the very deadline this timer exists to enforce.
    let timedOut = false;
    let escalate: ReturnType<typeof setTimeout> | undefined;
    const timer = options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
        timedOut = true;
        void killTree("SIGTERM");
        escalate = setTimeout(() => void killTree("SIGKILL"), 5000);
      }, options.timeoutMs);

    // Cancellation rides the exact same kill path as the deadline: the caller's signal
    // SIGTERMs the tree, then SIGKILLs after the same grace period. It does not set
    // `timedOut` — the caller asked to cancel, the child did not overrun a deadline.
    const onAbort = (): void => {
      void killTree("SIGTERM");
      escalate = setTimeout(() => void killTree("SIGKILL"), 5000);
    };
    const signal = options.signal;
    if (signal !== undefined) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    // Handle early stdin closure and wait for the complete child result.
    child.stdin?.on("error", (error) => {
      if (protocol && (error as NodeJS.ErrnoException).code === "EPIPE") {
        stopInputRelay();
        return;
      }
      inputError ??= error;
    });

    child.on("error", (error) => {
      launchError ??= error;
    });

    child.on("close", (code) => {
      stopInputRelay();
      child.stdin?.removeListener("close", stopInputRelay);
      child.stdout?.unpipe(process.stdout);
      child.stderr?.unpipe(process.stderr);
      if (timer) clearTimeout(timer);
      if (escalate !== undefined) clearTimeout(escalate);
      if (signal !== undefined) signal.removeEventListener("abort", onAbort);
      forwardStdout?.flush();
      forwardStderr?.flush();
      const result: ExecResult = {
        code: toSignedExitCode(code ?? -1),
        stdout,
        stderr,
        ...(timedOut ? { timedOut: true as const } : {}),
      };
      if (launchError !== undefined) {
        rejectPromise(launchError);
        return;
      }
      if (result.code !== 0 && options.allowFailure !== true) {
        const error = composeExecFailure(command, args, result);
        if (timedOut) (error as CommandFailure).timedOut = true;
        rejectPromise(error);
        return;
      }
      if (inputError !== undefined && result.code === 0) {
        rejectPromise(new Error(`${STDIN_DELIVERY_FAILED}: ${inputError.message}`));
        return;
      }
      resolvePromise(result);
    });

    try {
      if (protocol && child.stdin !== null) process.stdin.pipe(child.stdin);
      else if (options.input !== undefined) child.stdin?.end(options.input);
      else child.stdin?.end();
    } catch (error) {
      inputError ??= error as Error;
      child.stdin?.destroy();
      if (child.exitCode === null && !child.killed) child.kill();
    }
  });
}

/** The misleading cause a Windows retry without the flag produces under GNU tar: the drive
 *  letter read as a remote host. Exported so checks assert the real cause is kept instead. */
export const TAR_REMOTE_HOST_NOISE = "Cannot connect to D";

/** The flag arguments a local tar invocation needs on this platform: GNU tar (Git Bash) reads
 *  the drive letter in an absolute `-f` path as a remote host spec; `--force-local` stops that.
 *  Stock bsdtar does not know the flag — see tarFlagRejected for the one failure that may retry.
 */
export function tarLocalFlags(): string[] {
  return process.platform === "win32" ? ["--force-local"] : [];
}

/** A local path spelled for tar's own argument handling (rf6-fix33): GNU tar decodes
 *  backslash escapes in its -C value, so a staging directory under a TEMP whose component
 *  begins with \t (\tom, \tmp) read as a tab and every valid artifact was refused as an
 *  integrity error. Windows file APIs accept both spellings; a POSIX tar never sees a
 *  backslash. Exported beside tarLocalFlags: the one spelling local tar calls hand out. */
export function tarLocalPath(path: string): string {
  return path.replaceAll("\\", "/");
}

/** Whether a failed local tar run rejected `--force-local` itself (bsdtar: "Option
 *  --force-local is not supported") — the only failure a retry without the flag answers. Any
 *  other first-attempt failure keeps its own error: retrying under GNU tar replaces the real
 *  cause ("gzip: invalid header") with "Cannot connect to D: resolve failed".
 */
export function tarFlagRejected(result: ExecResult): boolean {
  const noise = `${result.stderr}\n${result.stdout}`;
  return noise.includes("--force-local") && /not supported|unrecognized option|unknown option/i.test(noise);
}

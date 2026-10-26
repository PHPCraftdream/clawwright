import { StringDecoder } from "node:string_decoder";
import { UserError } from "#src/core/io/log.ts";
import { outputSink, recordStreamedStdout } from "#src/core/io/output.ts";
import { shellQuote } from "#src/core/io/shell.ts";
import { listFilesVia } from "#src/security/transport-listing.ts";
import type { ExecOptions, ExecResult, Transport } from "../exec.ts";
import { composeExecFailure, terminalStreaming } from "../exec.ts";
import { existsVia, privateWriteCommand, publishCommand, withEnvPrefix } from "../quoting.ts";
import { runSsjack, type SsjackRpc } from "./ssjack-stream.ts";

/**
 * A finite, operation-scoped transport that never invokes an external SSH executable.
 * @remarks Registration trusts application code, not a filesystem sandbox. This class
 * is intentionally not a SshTransport subclass: no inherited SSH-only route may escape.
 */
export class SsjackTransport implements Transport {
  readonly description: string;
  readonly cancellation = "local-only" as const;
  readonly sessionScoped = true;
  readonly #client: SsjackRpc;

  /** Retain the actual authenticated client and its verified profile label. */
  constructor(client: SsjackRpc, profile: string) {
    this.#client = client;
    this.description = `ssjack:${profile}`;
  }

  /** Revoke local access; keeper operation lifetime remains the authority boundary. */
  close(): void {
    this.#client.close();
  }

  /** Execute native argv after shell-safe remote quoting and explicit environment validation. */
  async exec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    if (options.stdioProtocol === true) throw new UserError("SSJACK_STDIO_PROTOCOL_UNSUPPORTED");
    const names = [...Object.keys(options.env ?? {}), ...(options.unsetEnv ?? [])];
    if (command === "" || names.some((name) => typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) ||
        [command, ...args, ...Object.values(options.env ?? {})].some((value) => typeof value !== "string" || value.includes("\0"))) {
      throw new UserError("SSJACK_EXEC_INVALID");
    }
    const [head, rest] = withEnvPrefix(command, args, options.env, options.unsetEnv);
    const remote = [head, ...rest].map(shellQuote).join(" ");
    const sink = outputSink();
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    const result = await runSsjack(this.#client, remote, {
      input: options.input, timeoutMs: options.timeoutMs, signal: options.signal,
      capture: !terminalStreaming({
        protocol: false, stream: options.stream, hasSink: sink !== undefined,
        stdoutTty: process.stdout.isTTY === true, stderrTty: process.stderr.isTTY === true,
      }),
      ...(options.stream === true ? {
        onChunk: async (stream: "stdout" | "stderr", bytes: Buffer, signal: AbortSignal): Promise<void> => {
          signal.throwIfAborted();
          if (sink !== undefined) {
            const value = decoders[stream].write(bytes);
            if (value !== "") sink(value);
          } else {
            const target = stream === "stdout" ? process.stdout : process.stderr;
            await new Promise<void>((resolve, reject) => {
              target.write(bytes, (error) => error ? reject(error) : resolve());
            });
            if (stream === "stdout") recordStreamedStdout(bytes.length);
          }
        },
      } : {}),
    });
    if (options.stream === true && sink !== undefined) {
      for (const decoder of Object.values(decoders)) {
        const trailing = decoder.end();
        if (trailing !== "") sink(trailing);
      }
    }
    const output: ExecResult = {
      code: result.code, stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8"),
      ...(result.timedOut === true ? { timedOut: true } : {}),
    };
    if ((output.code !== 0 || output.timedOut === true) && options.allowFailure !== true) {
      const error = composeExecFailure(command, args, output);
      if (output.timedOut === true) error.timedOut = true;
      throw error;
    }
    return output;
  }

  /** Read UTF-8 text only; archive consumers must retain the byte-safe channel. */
  async readFile(path: string): Promise<string> {
    return (await this.exec("cat", ["--", path])).stdout;
  }

  /** Publish through an atomic target-side staging sibling using binary-safe stdin. */
  async writeFile(path: string, content: string | Uint8Array, mode?: string): Promise<void> {
    const [command, args] = publishCommand(path);
    await this.exec(command, args, { input: content });
    if (mode !== undefined) await this.exec("chmod", [mode, path]);
  }

  /** Create an exclusive owner-only target file without publishing its bytes in argv. */
  async writePrivateFile(path: string, content: string | Uint8Array): Promise<void> {
    const [command, args] = privateWriteCommand(path);
    await this.exec(command, args, { input: content });
  }

  /** Create one owner-only target directory, refusing an existing entry. */
  async mkdirPrivate(path: string): Promise<void> {
    await this.exec("mkdir", ["-m", "700", "--", path]);
  }

  /** Distinguish a confirmed missing target from an unreachable or blocked inspection. */
  exists(path: string): Promise<boolean> {
    return existsVia((command, args, options) => this.exec(command, args, options), path);
  }

  /** Probe the final target entry without treating a dangling symlink as absence. */
  existsEntry(path: string): Promise<boolean> {
    return existsVia((command, args, options) => this.exec(command, args, options), path, "entry");
  }

  /** Create target parents through the keeper, never through operator-side filesystem APIs. */
  async mkdirp(path: string): Promise<void> {
    await this.exec("mkdir", ["-p", "--", path]);
  }

  /** Remove an application-selected target tree; this scope is not a filesystem jail. */
  async remove(path: string): Promise<void> {
    await this.exec("rm", ["-rf", "--", path]);
  }

  /** Remove one empty directory without deleting its contents on failure. */
  async removeEmptyDir(path: string): Promise<void> {
    await this.exec("rmdir", ["--", path]);
  }

  /** Remove only empty directories below the target path and report whether it vanished. */
  async removeEmptyTree(path: string): Promise<boolean> {
    if (!(await this.exists(path))) return false;
    await this.exec("find", [path, "-depth", "-type", "d", "-empty", "-delete"]);
    return !(await this.exists(path));
  }

  /** Return validated relative target file names through the shared listing implementation. */
  listFiles(path: string): Promise<string[]> {
    return listFilesVia((command, args, options) => this.exec(command, args, options), path);
  }

  /** A temporary lease cannot be embedded in an external or persistent client invocation. */
  clientInvocation(_entryPath: string, _args: string[]): never {
    throw new UserError("SSJACK_PERSISTENT_INVOCATION_UNSUPPORTED");
  }
}

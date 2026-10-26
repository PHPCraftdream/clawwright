import { setTimeout as delay } from "node:timers/promises";
import { UserError } from "#src/core/io/log.ts";
import type { SsjackClient } from "./ssjack-client.ts";
import { SSJACK_REQUIREMENTS } from "./ssjack-contract.ts";
import { inputAccepted, readFrame, startIdentity } from "./ssjack-frames.ts";

/** The authenticated RPC surface, injectable for deterministic flow-control checks. */
export type SsjackRpc = Pick<SsjackClient, "info" | "call" | "close">;

/** Finite execution settings; a binary consumer must honor the supplied operation signal. */
export interface SsjackStreamOptions {
  readonly input?: string | Uint8Array;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly captureLimit?: number;
  readonly capture?: boolean;
  readonly onChunk?: (stream: "stdout" | "stderr", bytes: Buffer, signal: AbortSignal) => Promise<void>;
}

/** Byte-preserving result; consumers choose when to perform any text decoding. */
export interface SsjackBytes {
  readonly code: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly timedOut?: true;
}

/**
 * Execute one finite command with concurrent bounded stdin/output pumping.
 *
 * @remarks
 * Input is retried only after accepted:false. Lost replies are never replayed.
 * A sink is awaited before reading another chunk and disables capture by default.
 * Explicit capture:true retains a bounded copy as well, for the ExecResult contract.
 * Cancellation closes SSH connections only; detached remote processes may survive.
 * Failed calls invalidate the client, preventing silent reuse or standalone fallback.
 */
export async function runSsjack(client: SsjackRpc, command: string, options: SsjackStreamOptions = {}): Promise<SsjackBytes> {
  const timeout = options.timeoutMs ?? 600000;
  const limit = options.captureLimit ?? 64 * 1024 * 1024;
  const capture = options.capture ?? (options.onChunk === undefined);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3600000 ||
      !Number.isSafeInteger(limit) || limit < 0 || (!capture && options.onChunk === undefined) ||
      command === "" || command.includes("\0") || Buffer.byteLength(command) > 65536) {
    throw new UserError("SSJACK_EXEC_INVALID");
  }
  if (options.signal?.aborted) throw new UserError("SSJACK_OPERATION_CANCELLED");
  const input = typeof options.input === "string" ? Buffer.from(options.input) : options.input ?? new Uint8Array();
  const output: Record<"stdout" | "stderr", Buffer[]> = { stdout: [], stderr: [] };
  const operation = new AbortController();
  let captured = 0;
  let job: string | undefined;
  let finished = false;
  const stopState: { reason?: "timeout" | "abort" } = {};
  let cancellation: Promise<void> | undefined;
  let rejectStop!: (error: Error) => void;
  const interrupted = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
  // A stop can occur before the first race has attached to this promise.
  void interrupted.catch(() => {});

  /** Best-effort cancellation is issued once, never retried after an uncertain reply. */
  function cancel(): Promise<void> {
    if (cancellation !== undefined) return cancellation;
    if (job === undefined || finished) return Promise.resolve();
    cancellation = client.call("transport_cancel", { job_id: job }).then((reply) => {
      if (reply.cancelled !== true) throw new UserError("SSJACK_FRAME_INVALID");
    }).catch(() => { client.close(); });
    return cancellation;
  }

  /** Interrupt caller-side waits even if a supplied consumer does not settle promptly. */
  function stop(reason: "timeout" | "abort"): void {
    if (stopState.reason !== undefined || finished) return;
    stopState.reason = reason;
    const error = new UserError(reason === "timeout" ? "SSJACK_OPERATION_TIMED_OUT" : "SSJACK_OPERATION_CANCELLED");
    operation.abort(error);
    rejectStop(error);
    if (job === undefined) client.close();
    else void cancel();
  }

  /** Forward the caller's signal while retaining the listener identity for cleanup. */
  const abort = (): void => stop("abort");
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => stop("timeout"), timeout);
  const pumps: Promise<unknown>[] = [];
  try {
    await Promise.race([client.info(), interrupted]);
    job = startIdentity(await Promise.race([
      client.call("transport_start", { command, timeout_ms: timeout }), interrupted,
    ]));

    /** Deliver each finite chunk exactly once, then queue EOF while output is drained. */
    async function writeInput(): Promise<void> {
      let offset = 0;
      let pending: { eof: true } | { data: string } | undefined;
      while (!finished) {
        operation.signal.throwIfAborted();
        const eof = offset === input.byteLength;
        const end = Math.min(offset + SSJACK_REQUIREMENTS.chunkSize, input.byteLength);
        if (pending === undefined) {
          pending = eof ? { eof: true } : { data: Buffer.from(input.buffer, input.byteOffset + offset, end - offset).toString("base64") };
        }
        const reply = await Promise.race([
          client.call("transport_input", { job_id: job, ...pending }), interrupted,
        ]);
        if (inputAccepted(reply)) {
          pending = undefined;
          if (eof) return;
          offset = end;
        } else {
          await delay(5, undefined, { signal: operation.signal });
        }
      }
    }

    /** Await output consumption before requesting another frame from the bounded server queue. */
    async function readOutput(): Promise<{ code: number; timedOut: boolean }> {
      while (true) {
        operation.signal.throwIfAborted();
        const frame = readFrame(await Promise.race([client.call("transport_read", { job_id: job }), interrupted]));
        if (frame.kind === "pending") continue;
        if (frame.kind === "done") {
          finished = true;
          if (frame.error !== undefined && !frame.timedOut) throw new UserError("SSJACK_REMOTE_EXEC_FAILED");
          return { code: frame.code, timedOut: frame.timedOut };
        }
        if (options.onChunk !== undefined) {
          await Promise.race([options.onChunk(frame.stream, frame.data, operation.signal), interrupted]);
        }
        if (capture) {
          captured += frame.data.length;
          if (captured > limit) throw new UserError("SSJACK_OUTPUT_LIMIT_EXCEEDED");
          output[frame.stream].push(frame.data);
        }
      }
    }

    const writer = writeInput();
    const reader = readOutput();
    pumps.push(writer, reader);
    const [, result] = await Promise.all([writer, reader]);
    return {
      code: result.code, stdout: Buffer.concat(output.stdout), stderr: Buffer.concat(output.stderr),
      ...(result.timedOut ? { timedOut: true as const } : {}),
    };
  } catch (error) {
    rejectStop(error instanceof Error ? error : new UserError("SSJACK_EXEC_FAILED"));
    operation.abort(error);
    await cancel();
    client.close();
    await Promise.allSettled(pumps);
    if (stopState.reason === "timeout") {
      return { code: -1, stdout: Buffer.concat(output.stdout), stderr: Buffer.concat(output.stderr), timedOut: true };
    }
    if (stopState.reason === "abort") throw new UserError("SSJACK_OPERATION_CANCELLED");
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    await cancellation;
  }
}

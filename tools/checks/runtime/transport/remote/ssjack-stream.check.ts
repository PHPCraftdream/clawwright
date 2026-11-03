import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { runSsjack, type SsjackRpc } from "#framework/runtime/transport/remote/ssjack-stream.ts";
import type { SsjackInfo, SsjackTool } from "#framework/runtime/transport/remote/ssjack-client.ts";
import { readFrame, inputAccepted, startIdentity } from "#framework/runtime/transport/remote/ssjack-frames.ts";

const lostInputReply = new Error("SSJACK_FIXTURE_INPUT_REPLY_LOST");

/** Bounded synthetic peer: input cannot advance indefinitely without output draining. */
class Peer implements SsjackRpc {
  closed = false;
  cancelled = false;
  eof = false;
  readCalls = 0;
  inputCalls = 0;
  starts = 0;
  rejectedOnce = false;
  mode: "echo" | "lost-input" | "malformed" | "wait" = "echo";
  readonly accepted: Buffer[] = [];
  readonly attempts: string[] = [];
  readonly queue: Record<string, unknown>[] = [{ done: false, stream: "stderr", data: Buffer.from("diagnostic").toString("base64") }];

  /** Supply the same immutable runtime metadata as the already checked HTTPS client. */
  async info(): Promise<SsjackInfo> {
    return { protocol: 1, profile: "fixture", commit: "fixture", chunkSize: 16384, capabilities: ["exec", "stdin", "binary", "backpressure", "cancel"], cancellation: "connection-only" };
  }

  /** Simulate authenticated tool replies, including explicit backpressure and uncertain delivery. */
  async call(name: SsjackTool, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.closed) throw new Error("closed");
    if (name === "transport_start") { this.starts++; return { job_id: "a".repeat(64) }; }
    if (name === "transport_cancel") { this.cancelled = true; return { cancelled: true }; }
    if (name === "transport_input") {
      this.inputCalls++;
      if (args.eof === true) { this.eof = true; return { accepted: true }; }
      assert.equal(typeof args.data, "string");
      this.attempts.push(args.data as string);
      if (!this.rejectedOnce || this.queue.length >= 1) { this.rejectedOnce = true; return { accepted: false }; }
      const bytes = Buffer.from(args.data as string, "base64");
      assert.ok(bytes.length <= 16384);
      this.accepted.push(bytes);
      if (this.mode === "lost-input") throw lostInputReply;
      this.queue.push({ done: false, stream: "stdout", data: args.data });
      return { accepted: true };
    }
    this.readCalls++;
    if (this.mode === "malformed") return { done: false, stream: "stdout", data: "!invalid!" };
    const frame = this.queue.shift();
    if (frame !== undefined) return frame;
    if (this.eof && this.mode !== "wait") return { done: true, exit_code: 7 };
    await delay(1);
    return { done: false, pending: true, exit_code: -1 };
  }

  /** Prevent all subsequent calls after a fatal or uncertain operation. */
  close(): void { this.closed = true; }
}

const bytes = Buffer.from(Array.from({ length: 1024 * 1024 + 17 }, (_, index) => index % 256));
const peer = new Peer();
const result = await runSsjack(peer, "copy", { input: bytes });
assert.deepEqual(result.stdout, bytes);
assert.deepEqual(Buffer.concat(peer.accepted), bytes);
assert.equal(result.stderr.toString(), "diagnostic");
assert.equal(result.code, 7);
assert.ok(peer.inputCalls > peer.accepted.length);
assert.equal(peer.attempts[0], peer.attempts[1]);
assert.ok(peer.readCalls > 1);
assert.equal(peer.closed, false);

const uncertain = new Peer();
uncertain.mode = "lost-input";
await assert.rejects(runSsjack(uncertain, "copy", { input: bytes }), (error: unknown) => error === lostInputReply);
assert.equal(uncertain.accepted.length, 1);
assert.equal(uncertain.cancelled, true);
assert.equal(uncertain.closed, true);

for (const mode of ["malformed", "limit"] as const) {
  const invalid = new Peer();
  if (mode === "malformed") invalid.mode = mode;
  await assert.rejects(runSsjack(invalid, "copy", { input: bytes, captureLimit: mode === "limit" ? 1 : undefined }),
    mode === "malformed" ? /SSJACK_FRAME_INVALID/ : /SSJACK_OUTPUT_LIMIT_EXCEEDED/);
  assert.equal(invalid.cancelled, true);
  assert.equal(invalid.closed, true);
}

const aborted = new Peer();
const alreadyStopped = new AbortController();
alreadyStopped.abort();
await assert.rejects(runSsjack(aborted, "copy", { signal: alreadyStopped.signal }), /SSJACK_OPERATION_CANCELLED/);
assert.equal(aborted.starts, 0);

const active = new Peer();
const controller = new AbortController();
await assert.rejects(runSsjack(active, "copy", {
  input: bytes, signal: controller.signal,
  onChunk: async () => { controller.abort(); await new Promise<void>(() => {}); },
}), /SSJACK_OPERATION_CANCELLED/);
assert.equal(active.cancelled, true);

const timed = new Peer();
timed.mode = "wait";
const expired = await runSsjack(timed, "wait", { timeoutMs: 20 });
assert.equal(expired.timedOut, true);
assert.equal(expired.code, -1);
assert.equal(timed.cancelled, true);

const bounded = new Peer();
let release!: () => void;
let entered!: () => void;
const waiting = new Promise<void>((resolve) => { entered = resolve; });
const gate = new Promise<void>((resolve) => { release = resolve; });
const streamed: Uint8Array[] = [];
let first = true;
const streaming = runSsjack(bounded, "copy", {
  input: bytes, capture: false,
  onChunk: async (stream, chunk) => {
    if (first) { first = false; entered(); await gate; }
    if (stream === "stdout") streamed.push(chunk);
  },
});
await waiting;
const readsWhileBlocked = bounded.readCalls;
await Promise.resolve();
assert.equal(bounded.readCalls, readsWhileBlocked);
release();
assert.equal((await streaming).stdout.length, 0);
assert.deepEqual(Buffer.concat(streamed), bytes);

for (const frame of [
  {}, { done: "true" }, { done: false, pending: true, data: "YQ==" },
  { done: false, stream: "stdout", data: "YR==" },
  { done: false, stream: "other", data: "YQ==" },
  { done: true, exit_code: 1.5 }, { done: true, exit_code: 256 },
  { done: true, exit_code: 0, pending: true },
  { done: false, stream: "stdout", data: Buffer.alloc(16385).toString("base64") },
]) assert.throws(() => readFrame(frame), /SSJACK_FRAME_INVALID/);
assert.throws(() => inputAccepted({}), /SSJACK_FRAME_INVALID/);
assert.throws(() => startIdentity({ job_id: "wrong" }), /SSJACK_FRAME_INVALID/);

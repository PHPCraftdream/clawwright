import assert from "node:assert/strict";
import { SsjackTransport } from "#framework/runtime/transport/remote/ssjack.ts";
import type { SsjackRpc } from "#framework/runtime/transport/remote/ssjack-stream.ts";
import type { SsjackInfo, SsjackTool } from "#framework/runtime/transport/remote/ssjack-client.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { shellQuote } from "#framework/core/io/shell.ts";

/** Small RPC fixture for argv, filesystem-stdin and text presentation boundaries. */
class Fixture implements SsjackRpc {
  readonly commands: string[] = [];
  readonly inputs: Buffer[] = [];
  frames: Record<string, unknown>[] = [];
  code = 0;
  closed = false;

  /** Supply a compatible authenticated scope without opening sockets or subprocesses. */
  async info(): Promise<SsjackInfo> {
    return { protocol: 1, profile: "fixture", commit: "fixture", chunkSize: 16384, capabilities: ["exec", "stdin", "binary", "backpressure", "cancel"], cancellation: "connection-only" };
  }

  /** Keep commands and stdin separate; no fixture command is actually executed. */
  async call(name: SsjackTool, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (name === "transport_start") {
      this.commands.push(String(args.command));
      return { job_id: "b".repeat(64) };
    }
    if (name === "transport_input") {
      if (typeof args.data === "string") this.inputs.push(Buffer.from(args.data, "base64"));
      return { accepted: true };
    }
    if (name === "transport_cancel") return { cancelled: true };
    return this.frames.shift() ?? { done: true, exit_code: this.code };
  }

  /** Record local revocation without concealing whether the fixture used an external tool. */
  close(): void { this.closed = true; }
}

const peer = new Fixture();
const transport = new SsjackTransport(peer, "fixture");
assert.equal(transport.sessionScoped, true);
assert.notEqual(transport.cancellation, "confirmed-local");
const args = ["with spaces", "'quoted'", "$(not executed)", "&literal"];
await transport.exec("printf", args, { env: { VALUE: "a'b" }, unsetEnv: ["REMOVE"] });
assert.ok(peer.commands[0].startsWith(shellQuote("env")));
for (const argument of ["-u", "REMOVE", "VALUE=a'b", "printf", ...args]) {
  assert.equal(peer.commands[0].split(shellQuote(argument)).length, 2);
}

const callsBeforeRefusal = peer.commands.length;
assert.throws(() => transport.clientInvocation("entry", []), /SSJACK_PERSISTENT_INVOCATION_UNSUPPORTED/);
await assert.rejects(transport.exec("tool", [], { stdioProtocol: true }), /SSJACK_STDIO_PROTOCOL_UNSUPPORTED/);
await assert.rejects(transport.exec("tool", [], { env: { "BAD-NAME": "x" } }), /SSJACK_EXEC_INVALID/);
await assert.rejects(transport.exec("tool", ["nul\0"]), /SSJACK_EXEC_INVALID/);
assert.equal(peer.commands.length, callsBeforeRefusal);

const filePeer = new Fixture();
const files = new SsjackTransport(filePeer, "fixture");
const binary = Buffer.from([0, 255, 128, 10]);
await files.writePrivateFile("/target/private file", binary);
assert.deepEqual(Buffer.concat(filePeer.inputs), binary);
const privateMask = /\bumask\s+([0-7]+);/.exec(filePeer.commands[0])?.[1];
assert.equal(privateMask, "077");
assert.ok(!filePeer.commands[0].includes(binary.toString("base64")));

const streamPeer = new Fixture();
streamPeer.frames = [
  { done: false, stream: "stdout", data: Buffer.from([226, 130]).toString("base64") },
  { done: false, stream: "stdout", data: Buffer.from([172]).toString("base64") },
];
const chunks: string[] = [];
const streamed = await withOutputSink((chunk) => { chunks.push(chunk); },
  () => new SsjackTransport(streamPeer, "fixture").exec("tool", [], { stream: true }));
assert.equal(chunks.join(""), "€");
assert.equal(streamed.stdout, "€");

const failedPeer = new Fixture();
failedPeer.code = 9;
const failed = new SsjackTransport(failedPeer, "fixture");
assert.equal((await failed.exec("tool", [], { allowFailure: true })).code, 9);
await assert.rejects(failed.exec("tool", []), (error: unknown) =>
  error instanceof Error && "fullCommand" in error && typeof error.fullCommand === "string" && error.fullCommand.trim() === "tool");
transport.close();
assert.equal(peer.closed, true);

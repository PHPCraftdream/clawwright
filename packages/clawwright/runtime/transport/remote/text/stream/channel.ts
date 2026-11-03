import { request } from "node:https";
import type { Agent } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { TextDecoder } from "node:util";
import { registerSecret } from "#src/core/io/log.ts";
import type { SsjackTextBootstrap } from "../client.ts";
import { textStreamAgent } from "./tls.ts";

export type TextStreamCapability = "text_hydrate_stream_v2" | "text_reverse_copy_stream_v2";
export type TextStreamPath = "prepare" | "execute" | "reverse-copy";
const MCP = "2025-06-18";
const fail = (): Error => new Error("SSJACK_TEXT_STREAM_HTTP_FAILED");
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export async function textStreamJSON(response: IncomingMessage, notification = false): Promise<unknown> {
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of response) {
      if (!(chunk instanceof Buffer) || chunk.length > 65536 - length) throw fail();
      length += chunk.length;
      chunks.push(chunk);
    }
    if (!response.complete) throw fail();
    if (notification && response.statusCode === 202 && length === 0) return undefined;
    if (response.statusCode !== 200 || response.headers["content-type"] !== "application/json") throw fail();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, length))) as unknown;
  } catch {
    response.destroy();
    throw fail();
  }
}

/** One pinned scoped connection; no raw execution or arbitrary RPC surface. */
export class TextStreamChannel {
  readonly #bootstrap: Omit<SsjackTextBootstrap, "token">;
  readonly #capability: TextStreamCapability;
  readonly #pending = new Set<ClientRequest>();
  #agent?: Agent;
  #token: string;
  #id = 0;
  #opened = false;
  #ready = false;
  #closed = false;
  #busy = false;

  constructor(bootstrap: SsjackTextBootstrap, capability: TextStreamCapability) {
    registerSecret(bootstrap.token);
    if (typeof bootstrap.profile !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(bootstrap.profile) || !["text_hydrate_stream_v2", "text_reverse_copy_stream_v2"].includes(capability)) throw fail();
    this.#bootstrap = { endpoint: bootstrap.endpoint, pin: bootstrap.pin, profile: bootstrap.profile };
    this.#capability = capability;
    this.#token = bootstrap.token;
  }

  async open(signal: AbortSignal): Promise<void> {
    if (this.#opened || this.#closed || signal.aborted) throw fail();
    this.#opened = true;
    try {
      const agent = await textStreamAgent({ ...this.#bootstrap, token: this.#token }, signal);
      if (this.#closed || signal.aborted) { agent.destroy(); throw fail(); }
      this.#agent = agent;
      const initialized = await this.#rpc("initialize", { protocolVersion: MCP, capabilities: {}, clientInfo: { name: "clawwright-ssjack-text-stream", version: "2" } }, signal);
      if (!object(initialized) || initialized.protocolVersion !== MCP) throw fail();
      await this.#json({ jsonrpc: "2.0", method: "notifications/initialized" }, signal, true);
      const result = await this.#rpc("tools/call", { name: "transport_info", arguments: {} }, signal);
      if (!object(result) || result.isError === true || !object(result.structuredContent)) throw fail();
      const info = result.structuredContent;
      if (info.protocol !== 2 || info.profile !== this.#bootstrap.profile || info.chunk_size !== 32768 || info.cancellation !== "connection-only" || typeof info.commit !== "string" || info.commit.length === 0 || info.commit.length > 128 || !Array.isArray(info.capabilities) || info.capabilities.length !== 1 || info.capabilities[0] !== this.#capability) throw fail();
      this.#ready = true;
    } catch {
      this.close();
      throw fail();
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#token = "";
    for (const pending of this.#pending) pending.destroy(fail());
    this.#agent?.destroy();
  }

  async post(path: TextStreamPath, header: Record<string, unknown>, input: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<IncomingMessage> {
    if (!this.#ready || !["prepare", "execute", "reverse-copy"].includes(path) || (path === "reverse-copy") !== (this.#capability === "text_reverse_copy_stream_v2")) throw fail();
    const encoded = Buffer.from(`${JSON.stringify(header)}\n`);
    if (encoded.length > 16385) throw fail();
    async function* body(): AsyncGenerator<Uint8Array> { yield encoded; yield* input; }
    return this.#request(`/text-stream-v2/${path}`, "application/x-ndjson", body(), signal);
  }

  async #rpc(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const id = ++this.#id;
    const reply = await this.#json({ jsonrpc: "2.0", id, method, params }, signal);
    if (!object(reply) || reply.jsonrpc !== "2.0" || reply.id !== id || reply.error !== undefined || !Object.hasOwn(reply, "result")) throw fail();
    return reply.result;
  }

  async #json(value: Record<string, unknown>, signal: AbortSignal, notification = false): Promise<unknown> {
    const encoded = Buffer.from(JSON.stringify(value));
    if (encoded.length > 16384) throw fail();
    async function* body(): AsyncGenerator<Buffer> { yield encoded; }
    return textStreamJSON(await this.#request("/mcp", "application/json", body(), signal), notification);
  }

  async #request(path: string, contentType: string, body: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<IncomingMessage> {
    if (this.#closed || this.#agent === undefined || this.#busy || signal.aborted) throw fail();
    this.#busy = true;
    let received = false;
    let req!: ClientRequest;
    const response = new Promise<IncomingMessage>((resolve, reject) => {
      req = request(new URL(path, this.#bootstrap.endpoint), {
        method: "POST", agent: this.#agent, signal,
        headers: { Authorization: `Bearer ${this.#token}`, "Content-Type": contentType, Accept: "application/json, text/event-stream, application/x-ndjson", "MCP-Protocol-Version": MCP },
      }, (reply) => {
        received = true;
        reply.once("error", () => { req.destroy(fail()); });
        reply.once("close", () => { this.#busy = false; });
        reply.once("end", () => { this.#busy = false; });
        resolve(reply);
      });
      this.#pending.add(req);
      req.once("error", () => { this.#busy = false; reject(fail()); });
      req.once("close", () => { this.#pending.delete(req); });
    });
    const uploaded = (async (): Promise<void> => {
      let sent = 0, idle = 0, records = 0;
      const limit = path === "/mcp" ? 16384 : 96 * 1024 * 1024 + 16385;
      try {
        for await (const chunk of body) {
          if (received) break;
          if (signal.aborted || !(chunk instanceof Uint8Array) || chunk.byteLength > 49153 || chunk.byteLength > limit - sent) throw fail();
          records += 1;
          if (records > 4098) throw fail();
          sent += chunk.byteLength;
          idle = chunk.byteLength === 0 ? idle + 1 : 0;
          if (idle >= 8) throw fail();
          const written = new Promise<void>((resolve, reject) => { req.write(chunk, (error) => { if (error) reject(fail()); else resolve(); }); });
          await Promise.race([written, response.then(() => undefined)]);
        }
        if (!req.destroyed && !req.writableEnded) req.end();
      } catch {
        if (!received) { req.destroy(fail()); throw fail(); }
        if (!req.destroyed && !req.writableEnded) req.end();
      }
    })();
    try {
      const reply = await response;
      await uploaded;
      return reply;
    } catch {
      req.destroy(fail());
      await uploaded.catch(() => undefined);
      this.#busy = false;
      throw fail();
    }
  }
}

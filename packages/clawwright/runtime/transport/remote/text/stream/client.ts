import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { SsjackTextBootstrap, SsjackTextStatus } from "../client.ts";
import { TextStreamChannel, textStreamJSON, type TextStreamCapability } from "./channel.ts";
import { TextStreamTemplate, publishTextStreamCopy } from "./files.ts";
import { decodeTextFrames, encodeTextFrames, TEXT_STREAM_LIMITS } from "./frames.ts";
import { textStreamFailure, textStreamHeader, textStreamID, textStreamLifetime, textStreamRecord, textStreamSelection, type TextStreamOptions, type TextStreamSelection } from "./scope.ts";

function correlated(value: unknown, operation: string): Record<string, unknown> {
  if (!textStreamRecord(value) || value.format !== "ssjack-text-stream-v2" || value.operation_id !== operation) throw textStreamFailure();
  return value;
}

function statusReply(value: unknown, operation: string): SsjackTextStatus {
  const reply = correlated(value, operation);
  if (Object.keys(reply).length !== 3 || !["withheld", "unknown", "received"].includes(reply.status as string)) throw textStreamFailure();
  return reply.status as SsjackTextStatus;
}

function preparation(value: unknown, operation: string): string | undefined {
  const reply = correlated(value, operation);
  if (reply.status === "withheld" && Object.keys(reply).length === 3) return undefined;
  const bytes = Object.hasOwn(reply, "bytes") ? reply.bytes : 0;
  const keys = ["format", "operation_id", "status", "ticket", ...(Object.hasOwn(reply, "bytes") ? ["bytes"] : [])];
  if (reply.status !== "prepared" || Object.keys(reply).length !== keys.length || keys.some((key) => !Object.hasOwn(reply, key)) || !textStreamID(reply.ticket) || typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > TEXT_STREAM_LIMITS.bytes) throw textStreamFailure();
  return reply.ticket;
}

/** Single-use file operations; uncertainty after dispatch never authorizes retry. */
export class SsjackTextStreamClient {
  readonly #channel: TextStreamChannel;
  readonly #profile: string;
  readonly #capability: TextStreamCapability;
  #attempted = false;

  constructor(bootstrap: SsjackTextBootstrap, capability: TextStreamCapability) {
    this.#channel = new TextStreamChannel(bootstrap, capability);
    this.#profile = bootstrap.profile;
    this.#capability = capability;
  }

  async deploy(input: TextStreamSelection & { readonly template: string }, options: TextStreamOptions = {}): Promise<SsjackTextStatus> {
    if (this.#attempted || this.#capability !== "text_hydrate_stream_v2") throw textStreamFailure();
    this.#attempted = true;
    const selection = textStreamSelection(input, this.#profile);
    const operation = randomBytes(16).toString("base64url");
    const header = textStreamHeader(selection, operation);
    const lifetime = textStreamLifetime(options);
    let template: TextStreamTemplate | undefined;
    let dispatched = false;
    let outcome: SsjackTextStatus | undefined;
    try {
      template = await TextStreamTemplate.open(input.template);
      await this.#channel.open(lifetime.signal);
      const prepared = await textStreamJSON(await this.#channel.post("prepare", header, encodeTextFrames(template.read(lifetime.signal), operation, lifetime.signal), lifetime.signal));
      const ticket = preparation(prepared, operation);
      if (ticket === undefined) {
        outcome = "withheld";
      } else {
        const executionHeader = textStreamHeader(selection, operation, ticket);
        if (lifetime.signal.aborted) throw textStreamFailure();
        dispatched = true;
        const reply = await textStreamJSON(await this.#channel.post("execute", executionHeader, encodeTextFrames(template.read(lifetime.signal), operation, lifetime.signal), lifetime.signal));
        outcome = statusReply(reply, operation);
        if (lifetime.signal.aborted) outcome = "unknown";
      }
    } catch {
      if (dispatched) outcome = "unknown";
    } finally {
      this.#channel.close();
      try { await template?.close(); }
      catch { outcome = dispatched ? "unknown" : undefined; }
      lifetime.dispose();
    }
    if (outcome === undefined) throw textStreamFailure();
    return outcome;
  }

  async backup(input: TextStreamSelection & { readonly output: string }, options: TextStreamOptions = {}): Promise<SsjackTextStatus> {
    if (this.#attempted || this.#capability !== "text_reverse_copy_stream_v2") throw textStreamFailure();
    this.#attempted = true;
    const selection = textStreamSelection(input, this.#profile);
    if (typeof input.output !== "string" || input.output.length === 0 || input.output.includes("\0") || /[\uD800-\uDFFF]/u.test(input.output)) throw textStreamFailure();
    const operation = randomBytes(16).toString("base64url");
    const header = textStreamHeader(selection, operation);
    const lifetime = textStreamLifetime(options);
    let response: IncomingMessage | undefined;
    let dispatched = false;
    let outcome: SsjackTextStatus | undefined;
    try {
      await this.#channel.open(lifetime.signal);
      if (lifetime.signal.aborted) throw textStreamFailure();
      dispatched = true;
      async function* empty(): AsyncGenerator<Uint8Array> { yield* []; }
      response = await this.#channel.post("reverse-copy", header, empty(), lifetime.signal);
      if (response.headers["content-type"] === "application/json") {
        outcome = statusReply(await textStreamJSON(response), operation);
        if (outcome === "received") throw textStreamFailure();
      } else {
        if (response.statusCode !== 200 || response.headers["content-type"] !== "application/x-ndjson") throw textStreamFailure();
        const body = response;
        async function* received(): AsyncGenerator<Buffer> {
          yield* decodeTextFrames(body, operation, lifetime.signal);
          if (!body.complete || lifetime.signal.aborted) throw textStreamFailure();
        }
        await publishTextStreamCopy(input.output, received(), lifetime.signal);
        outcome = "received";
      }
      if (lifetime.signal.aborted) outcome = "unknown";
    } catch {
      if (dispatched) outcome = "unknown";
    } finally {
      response?.destroy();
      this.#channel.close();
      lifetime.dispose();
    }
    if (outcome === undefined) throw textStreamFailure();
    return outcome;
  }
}

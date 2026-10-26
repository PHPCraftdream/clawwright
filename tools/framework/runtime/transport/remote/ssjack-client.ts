import { createHash, timingSafeEqual, X509Certificate } from "node:crypto";
import { Agent, request } from "node:https";
import type { ClientRequest } from "node:http";
import { connect, type TLSSocket } from "node:tls";
import { TextDecoder } from "node:util";
import { UserError, registerSecret } from "#src/core/io/log.ts";
import { SSJACK_REQUIREMENTS } from "./ssjack-contract.ts";

export const SSJACK_ENV = {
  endpoint: "SSJACK_APP_ENDPOINT",
  token: "SSJACK_APP_TOKEN",
  pin: "SSJACK_APP_CERTIFICATE_SHA256",
} as const;

export interface SsjackBootstrap {
  readonly endpoint: string;
  readonly token: string;
  readonly pin: string;
}

export interface SsjackInfo {
  readonly protocol: 1;
  readonly profile: string;
  readonly commit: string;
  readonly chunkSize: 16384;
  readonly capabilities: readonly string[];
  readonly cancellation: "connection-only";
}

export type SsjackTool = "transport_start" | "transport_input" | "transport_read" | "transport_cancel";

const MCP_VERSION = "2025-06-18";
const MAX_RESPONSE = 256 * 1024;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const failure = (code: string): UserError => new UserError(code);

export function validateBootstrap(value: SsjackBootstrap): void {
  const match = /^https:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/mcp$/.exec(value.endpoint);
  if (match === null || Number(match[1]) > 65535 || !/^[0-9a-f]{64}$/.test(value.token) || !/^[0-9a-f]{64}$/.test(value.pin)) {
    throw failure("SSJACK_CONTEXT_INVALID");
  }
}

export function ssjackBootstrap(env: NodeJS.ProcessEnv = process.env): SsjackBootstrap | undefined {
  const values = Object.values(SSJACK_ENV).map((name) => env[name]);
  if (values.every((value) => value === undefined)) return undefined;
  registerSecret(env[SSJACK_ENV.token]);
  if (values.some((value) => value === undefined || value === "")) throw failure("SSJACK_CONTEXT_INCOMPLETE");
  const value = { endpoint: env[SSJACK_ENV.endpoint]!, token: env[SSJACK_ENV.token]!, pin: env[SSJACK_ENV.pin]! };
  validateBootstrap(value);
  return value;
}

export class SsjackClient {
  readonly #endpoint: URL;
  readonly #pin: Buffer;
  #token: string;
  #agent?: Agent;
  #probe?: TLSSocket;
  #ready?: Promise<SsjackInfo>;
  #id = 0;
  #closed = false;
  readonly #requests = new Set<ClientRequest>();

  constructor(bootstrap: SsjackBootstrap) {
    registerSecret(bootstrap.token);
    validateBootstrap(bootstrap);
    this.#endpoint = new URL(bootstrap.endpoint);
    this.#pin = Buffer.from(bootstrap.pin, "hex");
    this.#token = bootstrap.token;
  }

  info(): Promise<SsjackInfo> {
    if (this.#closed) return Promise.reject(failure("SSJACK_TRANSPORT_CLOSED"));
    return this.#ready ??= this.#initialize();
  }

  async call(name: SsjackTool, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.info();
    try { return await this.#tool(name, args); }
    catch (error) { this.close(); throw error; }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#token = "";
    this.#probe?.destroy();
    this.#agent?.destroy();
    for (const pending of this.#requests) pending.destroy(failure("SSJACK_TRANSPORT_CLOSED"));
  }

  async #initialize(): Promise<SsjackInfo> {
    try {
      const ca = await this.#certificate();
      if (this.#closed) throw failure("SSJACK_TRANSPORT_CLOSED");
      this.#agent = new Agent({
        ca, rejectUnauthorized: true, minVersion: "TLSv1.3", keepAlive: true, maxSockets: 8, maxFreeSockets: 4,
        checkServerIdentity: (_host, cert) => cert.raw !== undefined && this.#matchesPin(cert.raw)
          ? undefined : failure("SSJACK_CERTIFICATE_MISMATCH"),
      });
      const initialized = await this.#rpc("initialize", {
        protocolVersion: MCP_VERSION, capabilities: {}, clientInfo: { name: "clawwright-ssjack-transport", version: "transport-1" },
      });
      if (!record(initialized) || initialized.protocolVersion !== MCP_VERSION) throw failure("SSJACK_MCP_INCOMPATIBLE");
      await this.#send({ jsonrpc: "2.0", method: "notifications/initialized" }, true);
      const info = await this.#tool("transport_info", {});
      const capabilities = info.capabilities;
      if (info.protocol !== SSJACK_REQUIREMENTS.protocol || info.chunk_size !== SSJACK_REQUIREMENTS.chunkSize || info.cancellation !== SSJACK_REQUIREMENTS.cancellation ||
          typeof info.profile !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(info.profile) ||
          typeof info.commit !== "string" || info.commit.length === 0 || info.commit.length > 128 ||
          !Array.isArray(capabilities) || !capabilities.every((value) => typeof value === "string") ||
          !SSJACK_REQUIREMENTS.capabilities.every((name) => capabilities.includes(name))) {
        throw failure("SSJACK_PROTOCOL_INCOMPATIBLE");
      }
      return { protocol: 1, profile: info.profile, commit: info.commit, chunkSize: 16384, capabilities, cancellation: "connection-only" };
    } catch (error) {
      this.close();
      throw error;
    }
  }

  #matchesPin(raw: Buffer): boolean {
    return timingSafeEqual(createHash("sha256").update(raw).digest(), this.#pin);
  }

  #certificate(): Promise<string> {
    if (this.#closed) return Promise.reject(failure("SSJACK_TRANSPORT_CLOSED"));
    return new Promise((resolve, reject) => {
      // No HTTP or Authorization is sent by this unauthenticated TLS probe.
      const socket = connect({ host: "127.0.0.1", port: Number(this.#endpoint.port), rejectUnauthorized: false, minVersion: "TLSv1.3" });
      this.#probe = socket;
      let settled = false;
      const timer = setTimeout(() => finish(failure("SSJACK_CONNECT_TIMEOUT")), 5000);
      const finish = (error?: Error, certificate?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#probe = undefined;
        socket.destroy();
        if (error !== undefined) reject(error);
        else resolve(certificate!);
      };
      socket.once("error", () => finish(failure("SSJACK_TRANSPORT_UNAVAILABLE")));
      socket.once("close", () => { if (!settled) finish(failure("SSJACK_TRANSPORT_CLOSED")); });
      socket.once("secureConnect", () => {
        const raw = socket.getPeerCertificate().raw;
        if (raw === undefined || !this.#matchesPin(raw)) {
          finish(failure("SSJACK_CERTIFICATE_MISMATCH"));
          return;
        }
        finish(undefined, new X509Certificate(raw).toString());
      });
    });
  }

  async #tool(name: SsjackTool | "transport_info", args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await this.#rpc("tools/call", { name, arguments: args });
    if (!record(result) || result.isError === true) throw failure("SSJACK_TOOL_REJECTED");
    if (!record(result.structuredContent)) throw failure("SSJACK_RESPONSE_INVALID");
    return result.structuredContent;
  }

  async #rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = ++this.#id;
    const reply = await this.#send({ jsonrpc: "2.0", id, method, params });
    if (!record(reply) || reply.jsonrpc !== "2.0" || reply.id !== id || reply.error !== undefined || !("result" in reply)) {
      throw failure("SSJACK_RPC_REJECTED");
    }
    return reply.result;
  }

  #send(message: Record<string, unknown>, notification = false): Promise<unknown> {
    if (this.#closed || this.#agent === undefined) return Promise.reject(failure("SSJACK_TRANSPORT_CLOSED"));
    const body = Buffer.from(JSON.stringify(message));
    if (body.length > MAX_RESPONSE) return Promise.reject(failure("SSJACK_REQUEST_TOO_LARGE"));
    return new Promise((resolve, reject) => {
      let settled = false;
      const req = request(this.#endpoint, {
        method: "POST", agent: this.#agent,
        headers: { Authorization: `Bearer ${this.#token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": MCP_VERSION, "Content-Length": body.length },
      }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE) {
            finish(failure("SSJACK_RESPONSE_TOO_LARGE"));
            req.destroy();
          } else chunks.push(chunk);
        });
        response.once("error", () => finish(failure("SSJACK_RESPONSE_INCOMPLETE")));
        response.once("aborted", () => finish(failure("SSJACK_RESPONSE_INCOMPLETE")));
        response.once("end", () => {
          if (notification && response.statusCode === 202 && size === 0) { finish(); return; }
          if (response.statusCode !== 200 || response.headers["content-type"]?.split(";")[0] !== "application/json") {
            finish(failure("SSJACK_HTTP_REJECTED"));
            return;
          }
          try { finish(undefined, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown); }
          catch { finish(failure("SSJACK_RESPONSE_INVALID")); }
        });
      });
      this.#requests.add(req);
      const timer = setTimeout(() => { finish(failure("SSJACK_REQUEST_TIMEOUT")); req.destroy(); }, 10000);
      const finish = (error?: Error, value?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#requests.delete(req);
        if (error !== undefined) reject(error);
        else resolve(value);
      };
      req.once("error", () => finish(failure("SSJACK_TRANSPORT_UNAVAILABLE")));
      req.end(body);
    });
  }
}

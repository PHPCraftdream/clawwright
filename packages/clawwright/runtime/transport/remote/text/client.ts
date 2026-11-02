import { createHash, randomBytes, timingSafeEqual, X509Certificate } from "node:crypto";
import { Agent, request } from "node:https";
import type { ClientRequest } from "node:http";
import { connect, type TLSSocket } from "node:tls";
import { TextDecoder } from "node:util";
import { UserError, registerSecret } from "#src/core/io/log.ts";
import { parseCanonicalTextReferences } from "./canonical.ts";

export interface SsjackTextBootstrap {
  readonly endpoint: string;
  readonly token: string;
  readonly pin: string;
  readonly profile: string;
}

export type SsjackTextStatus = "withheld" | "received" | "unknown";

const MCP = "2025-06-18";
const MAX_REQUEST = 200 * 1024;
const fail = (): UserError => new UserError("SSJACK_TEXT_OPERATION_FAILED");
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validBootstrap = (bootstrap: SsjackTextBootstrap): void => {
  if (
    !/^https:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/mcp$/.test(bootstrap.endpoint) ||
    Number(new URL(bootstrap.endpoint).port) > 65535 ||
    !/^[0-9a-f]{64}$/.test(bootstrap.token) ||
    !/^[0-9a-f]{64}$/.test(bootstrap.pin) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(bootstrap.profile)
  ) {
    throw fail();
  }
};

export function ssjackTextBootstrap(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SsjackTextBootstrap | undefined {
  const keys = [
    "SSJACK_TEXT_ENDPOINT",
    "SSJACK_TEXT_TOKEN",
    "SSJACK_TEXT_CERTIFICATE_SHA256",
    "SSJACK_TEXT_PROFILE",
  ];
  const values = keys.map((key) => env[key]);
  if (values.every((value) => value === undefined)) return undefined;
  if (values.some((value) => !value)) throw fail();
  registerSecret(values[1]);
  const bootstrap = {
    endpoint: values[0]!,
    token: values[1]!,
    pin: values[2]!,
    profile: values[3]!,
  };
  validBootstrap(bootstrap);
  return bootstrap;
}

/** A protocol-1 client limited to the text-hydrate operation. */
export class SsjackTextClient {
  readonly #endpoint: URL;
  readonly #pin: Buffer;
  readonly #profile: string;
  #token: string;
  #agent?: Agent;
  #probe?: TLSSocket;
  #ready?: Promise<void>;
  #closed = false;
  #attempted = false;
  #id = 0;
  readonly #pending = new Set<ClientRequest>();

  constructor(bootstrap: SsjackTextBootstrap) {
    validBootstrap(bootstrap);
    registerSecret(bootstrap.token);
    this.#endpoint = new URL(bootstrap.endpoint);
    this.#pin = Buffer.from(bootstrap.pin, "hex");
    this.#profile = bootstrap.profile;
    this.#token = bootstrap.token;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#token = "";
    this.#probe?.destroy();
    this.#agent?.destroy();
    for (const request of this.#pending) request.destroy(fail());
  }

  async textHydrate(
    file: string,
    template: string,
    options: { deadline?: number | Date; timeoutMs?: number } = {},
  ): Promise<SsjackTextStatus> {
    if (this.#attempted || this.#closed) throw fail();
    this.#attempted = true;
    const entered = Date.now();
    const callerDeadline = options.deadline instanceof Date
      ? options.deadline.getTime()
      : options.deadline;
    const timeoutMs = options.timeoutMs ?? 60000;
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw fail();
    const deadline = Math.min(entered + timeoutMs, entered + 60000, callerDeadline ?? Infinity);
    const remaining = (): number => Math.floor(deadline - Date.now());
    if (
      typeof file !== "string" ||
      file.length === 0 ||
      Buffer.byteLength(file, "utf8") > 4096 ||
      file.includes("\0") ||
      typeof template !== "string" ||
      Buffer.byteLength(template, "utf8") > 32768 ||
      !Number.isFinite(deadline) ||
      remaining() < 1
    ) {
      throw fail();
    }
    parseCanonicalTextReferences(template);
    let dispatched = false;
    try {
      await this.#initialize(deadline);
      let raw: unknown;
      try {
        dispatched = true;
        raw = await this.#tool(
          "text_hydrate",
          {
            operation_id: randomBytes(16).toString("base64url"),
            file,
            mode: "hydrate-v1",
            template,
          },
          remaining(),
        );
      } catch {
        if (dispatched) return "unknown";
        throw fail();
      }
      if (
        !record(raw) ||
        Object.keys(raw).length !== 1 ||
        typeof raw.status !== "string" ||
        !["withheld", "received", "unknown"].includes(raw.status)
      ) {
        if (dispatched) return "unknown";
        throw fail();
      }
      return raw.status as SsjackTextStatus;
    } catch {
      if (dispatched) return "unknown";
      throw fail();
    } finally {
      this.close();
    }
  }

  #initialize(deadline: number): Promise<void> {
    if (this.#closed) return Promise.reject(fail());
    return this.#ready ??= this.#initializeOnce(deadline);
  }

  async #initializeOnce(deadline: number): Promise<void> {
    const timeout = (): number => Math.min(5000, deadline - Date.now());
    const certificate = await this.#certificate(timeout());
    if (this.#closed) throw fail();
    this.#agent = new Agent({
      ca: certificate,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
      keepAlive: true,
      maxSockets: 1,
      checkServerIdentity: (_host, cert) =>
        cert.raw !== undefined && this.#matchesPin(cert.raw) ? undefined : fail(),
    });
    const initialized = await this.#rpc(
      "initialize",
      {
        protocolVersion: MCP,
        capabilities: {},
        clientInfo: { name: "clawwright-ssjack-text", version: "1" },
      },
      timeout(),
    );
    if (!record(initialized) || initialized.protocolVersion !== MCP) throw fail();
    await this.#send({ jsonrpc: "2.0", method: "notifications/initialized" }, timeout(), true);
    const info = await this.#tool("transport_info", {}, timeout());
    if (
      !record(info) ||
      info.protocol !== 1 ||
      info.profile !== this.#profile ||
      !Array.isArray(info.capabilities) ||
      info.capabilities.length !== 1 ||
      info.capabilities[0] !== "text_hydrate"
    ) {
      throw fail();
    }
  }

  #matchesPin(raw: Buffer): boolean {
    return timingSafeEqual(createHash("sha256").update(raw).digest(), this.#pin);
  }

  #certificate(timeout: number): Promise<string> {
    if (this.#closed || timeout < 1) return Promise.reject(fail());
    return new Promise((resolve, reject) => {
      const socket = connect({
        host: "127.0.0.1",
        port: Number(this.#endpoint.port),
        rejectUnauthorized: false,
        minVersion: "TLSv1.3",
      });
      this.#probe = socket;
      let settled = false;
      const finish = (error?: Error, certificate?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#probe = undefined;
        socket.destroy();
        if (error !== undefined) {
          reject(error);
        } else {
          resolve(certificate!);
        }
      };
      const timer = setTimeout(() => finish(fail()), Math.min(timeout, 5000));
      socket.once("error", () => finish(fail()));
      socket.once("close", () => {
        if (!settled) finish(fail());
      });
      socket.once("secureConnect", () => {
        const raw = socket.getPeerCertificate().raw;
        if (raw === undefined || !this.#matchesPin(raw)) {
          finish(fail());
          return;
        }
        finish(undefined, new X509Certificate(raw).toString());
      });
    });
  }

  async #tool(name: string, args: Record<string, unknown>, timeout: number): Promise<unknown> {
    const result = await this.#rpc("tools/call", { name, arguments: args }, timeout);
    if (!record(result) || result.isError === true || !record(result.structuredContent)) throw fail();
    return result.structuredContent;
  }

  async #rpc(method: string, params: Record<string, unknown>, timeout: number): Promise<unknown> {
    const id = ++this.#id;
    const reply = await this.#send({ jsonrpc: "2.0", id, method, params }, timeout);
    if (
      !record(reply) ||
      reply.jsonrpc !== "2.0" ||
      reply.id !== id ||
      reply.error !== undefined ||
      !("result" in reply)
    ) {
      throw fail();
    }
    return reply.result;
  }

  #send(message: Record<string, unknown>, timeout: number, notification = false): Promise<unknown> {
    if (this.#closed || this.#agent === undefined || timeout < 1) return Promise.reject(fail());
    const body = Buffer.from(JSON.stringify(message));
    if (body.length > MAX_REQUEST) return Promise.reject(fail());
    return new Promise((resolve, reject) => {
      let settled = false;
      let size = 0;
      const req = request(
        this.#endpoint,
        {
          method: "POST",
          agent: this.#agent,
          headers: {
            Authorization: `Bearer ${this.#token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            "MCP-Protocol-Version": MCP,
            "Content-Length": body.length,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 65536) {
              finish(fail());
              req.destroy();
            } else {
              chunks.push(chunk);
            }
          });
          response.once("aborted", () => finish(fail()));
          response.once("error", () => finish(fail()));
          response.once("end", () => {
            if (notification && response.statusCode === 202 && size === 0) {
              finish(undefined, undefined);
              return;
            }
            if (
              response.statusCode !== 200 ||
              response.headers["content-type"]?.split(";")[0] !== "application/json"
            ) {
              finish(fail());
              return;
            }
            try {
              finish(
                undefined,
                JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))),
              );
            } catch {
              finish(fail());
            }
          });
        },
      );
      this.#pending.add(req);
      const timer = setTimeout(() => {
        finish(fail());
        req.destroy();
      }, timeout);
      const finish = (error?: Error, value?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#pending.delete(req);
        if (error !== undefined) {
          reject(error);
        } else {
          resolve(value);
        }
      };
      req.once("error", () => finish(fail()));
      req.end(body);
    });
  }
}

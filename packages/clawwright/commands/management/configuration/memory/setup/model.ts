import type { LookupAddress, LookupAllOptions } from "node:dns";
import type { request } from "node:https";
import type { ModelApproval } from "./approval.ts";
import { approveModel, MODEL_REDIRECT_HOSTS } from "./approval.ts";

export interface FileIdentity { readonly dev: string; readonly ino: string }
export interface ModelReceipt {
  readonly stage: FileIdentity;
  readonly receipt: FileIdentity;
  readonly root: FileIdentity;
}
export interface ModelRequest {
  readonly operation: "inspect" | "download" | "cleanup";
  readonly approval: ModelApproval;
  readonly root: string;
  readonly expectedRoot?: FileIdentity;
  readonly filename: string;
  readonly token: string;
  readonly timeoutMs: number;
  readonly quiescent?: true;
  readonly receipt?: ModelReceipt;
}
export interface ModelFacts {
  readonly ok: boolean;
  readonly code: string;
  readonly changed: boolean;
  readonly bytes?: number;
  readonly retainedStage?: boolean;
  readonly receipt?: ModelReceipt;
}
export interface ModelNetwork {
  readonly lookup: (hostname: string, options: LookupAllOptions) => Promise<LookupAddress[]>;
  readonly request: typeof request;
}

export async function modelOperation(
  input: ModelRequest,
  validate: typeof approveModel,
  hosts: readonly string[],
  load: NodeRequire,
  network?: ModelNetwork,
  report: (receipt: ModelReceipt) => void = () => {},
  platform: { getuid: () => number | undefined } = { getuid: () => process.getuid?.() },
): Promise<ModelFacts> {
  const fs: typeof import("node:fs") = load("node:fs");
  const path: typeof import("node:path") = load("node:path");
  const crypto: typeof import("node:crypto") = load("node:crypto");
  const net: typeof import("node:net") = load("node:net");
  const dns: typeof import("node:dns/promises") = load("node:dns/promises");
  const https: typeof import("node:https") = load("node:https");
  const io: ModelNetwork = network ?? { lookup: dns.lookup, request: https.request };
  const fail = (code: string): never => { throw new Error(code); };
  const identity = (s: import("node:fs").BigIntStats): FileIdentity => ({ dev: String(s.dev), ino: String(s.ino) });
  const same = (s: import("node:fs").BigIntStats, id: FileIdentity): boolean => String(s.dev) === id.dev && String(s.ino) === id.ino;
  const owned = (s: import("node:fs").BigIntStats): boolean => s.isFile() && s.uid === 1000n && s.nlink === 1n && (s.mode & 0o077n) === 0n;
  const stat = (p: string) => fs.lstatSync(p, { bigint: true });
  const flags = fs.constants;
  let stage = "", receiptPath = "", root = "", destination = "";
  let rootId: FileIdentity | undefined, receipt: ModelReceipt | undefined;
  let stageFd: number | undefined, receiptFd: number | undefined;
  let createdStage = false, createdReceipt = false, published = false, attempted = false, networkQuiescent = true;
  const responseTimers = new Map<import("node:http").IncomingMessage, NodeJS.Timeout>();
  let stageId: FileIdentity | undefined, receiptId: FileIdentity | undefined;
  const deadline = Date.now() + input.timeoutMs;
  const remaining = (): number => {
    const value = deadline - Date.now();
    if (value <= 0) return fail("MODEL_DEADLINE");
    return value;
  };
  function boundary(): void {
    let current = path.parse(root).root;
    for (const part of root.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const s = stat(current);
      if (!s.isDirectory() || s.isSymbolicLink()) fail("MODEL_BOUNDARY");
    }
    const s = stat(root);
    if (fs.realpathSync(root) !== root || s.uid !== 1000n || (s.mode & 0o022n) !== 0n || (rootId && !same(s, rootId)) || (input.expectedRoot && !same(s, input.expectedRoot))) fail("MODEL_BOUNDARY");
  }
  function removeOwned(p: string, id: FileIdentity): void {
    boundary();
    const s = stat(p);
    if (!owned(s) || !same(s, id)) fail("MODEL_CLEANUP_IDENTITY");
    fs.unlinkSync(p);
  }
  const publicIPv6 = new net.BlockList();
  publicIPv6.addSubnet("2000::", 3, "ipv6");
  const deniedIPv6 = new net.BlockList();
  deniedIPv6.addSubnet("2001::", 23, "ipv6");
  deniedIPv6.addSubnet("2001:db8::", 32, "ipv6");
  deniedIPv6.addSubnet("2002::", 16, "ipv6");
  deniedIPv6.addSubnet("3fff::", 20, "ipv6");
  function publicAddress(address: string): boolean {
    const family = net.isIP(address);
    if (family === 4) {
      const a = address.split(".").map(Number), [x, y, z] = a;
      if (x === 0 || x === 10 || x === 127 || x >= 224 || (x === 100 && y >= 64 && y <= 127) ||
          (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) ||
          (x === 192 && y === 0) || (x === 192 && y === 2) || (x === 192 && y === 88 && z === 99) ||
          (x === 198 && (y === 18 || y === 19 || (y === 51 && z === 100))) || (x === 203 && y === 0 && z === 113)) return false;
      return true;
    }
    if (family !== 6 || address.includes("%") || address.includes(".")) return false;
    return publicIPv6.check(address, "ipv6") && !deniedIPv6.check(address, "ipv6");
  }
  function redirectUrl(raw: string, base?: URL): URL {
    if (raw.length > 8192) return fail("MODEL_REDIRECT");
    for (const character of raw) {
      const code = character.charCodeAt(0);
      if (code <= 32 || code === 127 || character === "\\") return fail("MODEL_REDIRECT");
    }
    const u = new URL(raw, base);
    if (u.protocol !== "https:" || u.username || u.password || u.port || u.hash || !hosts.includes(u.hostname)) return fail("MODEL_REDIRECT");
    return u;
  }
  async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("MODEL_DEADLINE")), remaining());
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  async function response(url: URL): Promise<import("node:http").IncomingMessage> {
    const addresses = await bounded(io.lookup(url.hostname, { all: true, verbatim: true }));
    if (!addresses.length || addresses.some((a) => !publicAddress(a.address) || net.isIP(a.address) !== a.family)) return fail("MODEL_DNS");
    const pin = addresses[0];
    return new Promise((resolve, reject) => {
      const req = io.request({ protocol: "https:", hostname: url.hostname, port: 443,
        path: url.pathname + url.search, method: "GET", servername: url.hostname,
        rejectUnauthorized: true, agent: false, family: pin.family,
        lookup: (_hostname, _options, callback) => callback(null, pin.address, pin.family),
        headers: { Accept: "application/octet-stream", "Accept-Encoding": "identity" },
      });
      networkQuiescent = false;
      let settled = false;
      const timer = setTimeout(() => {
        req.destroy(new Error("MODEL_DEADLINE"));
        if (!settled) { settled = true; reject(new Error("MODEL_QUIESCENCE")); }
      }, remaining());
      req.once("error", (error) => {
        if (req.closed) { networkQuiescent = true; if (!settled) { settled = true; reject(error); } }
        else req.once("close", () => { networkQuiescent = true; if (!settled) { settled = true; reject(error); } });
      });
      req.once("close", () => {
        clearTimeout(timer);
        if (!settled) { networkQuiescent = true; settled = true; reject(new Error("MODEL_HTTP")); }
      });
      req.once("response", (res) => {
        clearTimeout(timer);
        if (settled) { res.destroy(); return; }
        settled = true;
        const bodyTimer = setTimeout(() => res.destroy(new Error("MODEL_DEADLINE")), Math.max(1, deadline - Date.now()));
        responseTimers.set(res, bodyTimer);
        res.once("close", () => { clearTimeout(bodyTimer); responseTimers.delete(res); networkQuiescent = true; });
        resolve(res);
      });
      req.end();
    });
  }
  async function closeResponse(res: import("node:http").IncomingMessage): Promise<void> {
    if (res.closed) { networkQuiescent = true; return; }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const bodyTimer = responseTimers.get(res);
        if (bodyTimer) clearTimeout(bodyTimer);
        responseTimers.delete(res);
        reject(new Error("MODEL_QUIESCENCE"));
      }, 1000);
      res.once("close", () => { clearTimeout(timer); networkQuiescent = true; resolve(); });
      res.destroy();
    });
  }
  async function get(source: string): Promise<import("node:http").IncomingMessage> {
    let url = redirectUrl(source);
    for (let redirects = 0; ; redirects++) {
      const res = await response(url);
      if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
        const location = res.headers.location;
        await closeResponse(res);
        if (redirects >= 3 || typeof location !== "string") return fail("MODEL_REDIRECT");
        url = redirectUrl(location, url);
      } else if (res.statusCode !== 200 || (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity")) {
        await closeResponse(res); return fail("MODEL_HTTP");
      } else return res;
    }
  }
  async function hashFile(file: string, approval: ModelApproval): Promise<number> {
    boundary();
    const before = stat(file);
    if (!owned(before) || before.size < 4n || before.size > BigInt(approval.maxBytes)) return fail("MODEL_FILE");
    const fd = fs.openSync(file, flags.O_RDONLY | flags.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!same(opened, identity(before))) return fail("MODEL_FILE");
      const hash = crypto.createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
      let bytes = 0, header = Buffer.alloc(0);
      for (;;) {
        remaining();
        const n = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (!n) break;
        bytes += n;
        if (bytes > approval.maxBytes) return fail("MODEL_SIZE");
        if (header.length < 4) header = Buffer.concat([header, buffer.subarray(0, Math.min(n, 4 - header.length))]);
        hash.update(buffer.subarray(0, n));
      }
      const after = fs.fstatSync(fd, { bigint: true });
      boundary();
      if (!same(stat(file), identity(opened)) || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs || BigInt(bytes) !== after.size) return fail("MODEL_FILE");
      if (header.equals(Buffer.from("GGUF")) === false || hash.digest("hex") !== approval.checksum) return fail("MODEL_CONTENT");
      return bytes;
    } finally { fs.closeSync(fd); }
  }
  try {
    const approval = validate(input.approval);
    if (!["inspect", "download", "cleanup"].includes(input.operation) || platform.getuid() !== 1000 ||
        !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > 240000 ||
        typeof input.root !== "string" || !path.isAbsolute(input.root) || input.root !== path.normalize(input.root) ||
        typeof input.filename !== "string" || /\s/.test(input.filename) || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.gguf$/.test(input.filename) || input.filename.includes("..") ||
        typeof input.token !== "string" || /\s/.test(input.token) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.token)) return fail("MODEL_INPUT");
    root = input.root;
    boundary(); rootId = identity(stat(root));
    destination = path.join(root, input.filename);
    stage = path.join(root, `.cfmodel-${input.token}.stage`);
    receiptPath = path.join(root, `.cfmodel-${input.token}.receipt`);
    if (input.operation === "cleanup") {
      if (input.quiescent !== true || !input.receipt || !same(stat(root), input.receipt.root)) return fail("MODEL_QUIESCENCE");
      const r = stat(receiptPath);
      if (!owned(r) || !same(r, input.receipt.receipt) || r.size > 2048n) return fail("MODEL_CLEANUP_IDENTITY");
      const fd = fs.openSync(receiptPath, flags.O_RDONLY | flags.O_NOFOLLOW);
      let saved: ModelReceipt;
      try {
        if (!same(fs.fstatSync(fd, { bigint: true }), input.receipt.receipt)) return fail("MODEL_CLEANUP_IDENTITY");
        saved = JSON.parse(fs.readFileSync(fd, "utf8")) as ModelReceipt;
      } finally { fs.closeSync(fd); }
      if (JSON.stringify(saved) !== JSON.stringify(input.receipt)) return fail("MODEL_CLEANUP_IDENTITY");
      attempted = true;
      removeOwned(stage, saved.stage);
      removeOwned(receiptPath, saved.receipt);
      return { ok: true, code: "MODEL_CLEANED", changed: true };
    }
    let exists = false;
    try { stat(destination); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (exists) return { ok: true, code: "MODEL_PRESENT", changed: false, bytes: await hashFile(destination, approval) };
    if (input.operation === "inspect") return { ok: false, code: "MODEL_MISSING", changed: false };
    boundary();
    attempted = true;
    stageFd = fs.openSync(stage, flags.O_WRONLY | flags.O_CREAT | flags.O_EXCL | flags.O_NOFOLLOW, 0o600);
    createdStage = true;
    stageId = identity(fs.fstatSync(stageFd, { bigint: true }));
    receiptFd = fs.openSync(receiptPath, flags.O_WRONLY | flags.O_CREAT | flags.O_EXCL | flags.O_NOFOLLOW, 0o600);
    createdReceipt = true;
    receiptId = identity(fs.fstatSync(receiptFd, { bigint: true }));
    receipt = { stage: stageId, receipt: receiptId, root: rootId };
    fs.writeFileSync(receiptFd, JSON.stringify(receipt)); fs.fsyncSync(receiptFd);
    fs.closeSync(receiptFd); receiptFd = undefined;
    report(receipt);
    const res = await get(approval.source);
    let bytes = 0, header = Buffer.alloc(0);
    const hash = crypto.createHash("sha256");
    try {
      const length = res.headers["content-length"];
      if (length !== undefined && (typeof length !== "string" || !/^[0-9]+$/.test(length) || BigInt(length) > BigInt(approval.maxBytes))) return fail("MODEL_SIZE");
      const iterator = res[Symbol.asyncIterator]();
      for (;;) {
        const next = await bounded(iterator.next());
        if (next.done) break;
        const value = next.value;
        remaining();
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        bytes += chunk.length;
        if (bytes > approval.maxBytes) return fail("MODEL_SIZE");
        if (header.length < 4) header = Buffer.concat([header, chunk.subarray(0, 4 - header.length)]);
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const n = fs.writeSync(stageFd, chunk, offset, chunk.length - offset);
          if (n <= 0) return fail("MODEL_WRITE");
          offset += n;
        }
      }
      if (!res.complete || (length !== undefined && BigInt(length) !== BigInt(bytes))) return fail("MODEL_HTTP");
      if (header.equals(Buffer.from("GGUF")) === false || hash.digest("hex") !== approval.checksum) return fail("MODEL_CONTENT");
    } finally { await closeResponse(res); }
    fs.fsyncSync(stageFd); fs.closeSync(stageFd); stageFd = undefined;
    remaining(); boundary();
    const ready = stat(stage);
    if (!owned(ready) || !same(ready, stageId) || ready.size !== BigInt(bytes)) return fail("MODEL_FILE");
    fs.linkSync(stage, destination); published = true;
    boundary();
    const linked = stat(stage), dest = stat(destination);
    if (!same(linked, stageId) || !same(dest, stageId) || linked.nlink !== 2n) return fail("MODEL_PUBLISH");
    fs.unlinkSync(stage); createdStage = false;
    removeOwned(receiptPath, receiptId); createdReceipt = false;
    return { ok: true, code: "MODEL_DOWNLOADED", changed: true, bytes };
  } catch (error) {
    if (stageFd !== undefined) { fs.closeSync(stageFd); stageFd = undefined; }
    if (receiptFd !== undefined) { fs.closeSync(receiptFd); receiptFd = undefined; }
    let retained = published && createdStage;
    if (!published && networkQuiescent) {
      try {
        if (createdStage && stageId) { removeOwned(stage, stageId); createdStage = false; }
        if (createdReceipt && receiptId) { removeOwned(receiptPath, receiptId); createdReceipt = false; }
      } catch { retained = true; }
    } else retained ||= createdReceipt;
    const message = error instanceof Error ? error.message : "";
    const code = !networkQuiescent ? "MODEL_QUIESCENCE" : /^MODEL_[A-Z_]+$/.test(message) ? message : (error as NodeJS.ErrnoException)?.code === "EEXIST" ? "MODEL_EXISTS" : "MODEL_IO";
    return { ok: false, code, changed: attempted || published, retainedStage: retained || createdStage || createdReceipt, ...(receipt ? { receipt } : {}) };
  }
}

export const MODEL_SETUP_SCRIPT = `"use strict";const validate=(${approveModel.toString()});const run=(${modelOperation.toString()});run(JSON.parse(process.argv[1]),validate,${JSON.stringify(MODEL_REDIRECT_HOSTS)},require,undefined,receipt=>process.stdout.write(JSON.stringify({kind:"model-staging",receipt})+"\\n")).then(facts=>{process.stdout.write(JSON.stringify({kind:"model-result",...facts})+"\\n");process.exitCode=facts.ok?0:1;},()=>{process.stdout.write('{"kind":"model-result","ok":false,"code":"MODEL_INPUT","changed":false}\\n');process.exitCode=1;});`;

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseCanonicalTextReferences } from "#framework/runtime/transport/remote/text/canonical.ts";
import { readSsjackTextInput, readSsjackTextInputFrom, type SsjackTextInputFiles } from "#framework/runtime/transport/remote/text/input.ts";
import { SsjackTextClient } from "#framework/runtime/transport/remote/text/client.ts";
import { executeCommand } from "#framework/core/command/execute.ts";
import { orchestrationCommands } from "#framework/commands/interface/groups/openclawCommands.orchestration.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { deployText, backupText } from "#framework/recipe-kit/index.ts";
import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { spawnLocal, createTransport, SsjackTransport } from "#framework/runtime/transport/transport.ts";
import { SSJACK_ENV, SsjackClient, ssjackBootstrap, validateBootstrap } from "#framework/runtime/transport/remote/ssjack-client.ts";
import { ssjackTextEnvironment } from "#framework/runtime/transport/remote/ssjack-contract.ts";
import { maskSecrets } from "#framework/core/io/log.ts";

const token = "a".repeat(64);
const pin = "b".repeat(64);
const valid = { endpoint: "https://127.0.0.1:12345/mcp", token, pin };
assert.equal(ssjackBootstrap({}), undefined);
assert.throws(() => ssjackBootstrap({ SSJACK_APP_TOKEN: token }), /SSJACK_CONTEXT_INCOMPLETE/);
for (const endpoint of [
  "http://127.0.0.1:12345/mcp", "https://localhost:12345/mcp", "https://127.1:12345/mcp",
  "https://0.0.0.0:12345/mcp", "https://127.0.0.1:0/mcp", "https://127.0.0.1:65536/mcp",
  "https://127.0.0.1:12345/mcp?token=x", "https://127.0.0.1:12345/mcp#fragment",
  "https://user@127.0.0.1:12345/mcp", "https://127.0.0.1:01234/mcp",
]) assert.throws(() => validateBootstrap({ ...valid, endpoint }), /SSJACK_CONTEXT_INVALID/);
assert.throws(() => validateBootstrap({ ...valid, token: "invalid" }), /SSJACK_CONTEXT_INVALID/);
assert.throws(() => validateBootstrap({ ...valid, pin: "invalid" }), /SSJACK_CONTEXT_INVALID/);
assert.deepEqual(ssjackBootstrap({ SSJACK_APP_ENDPOINT: valid.endpoint, SSJACK_APP_TOKEN: token, SSJACK_APP_CERTIFICATE_SHA256: pin }), valid);
assert.equal(maskSecrets(token), "***");

const scratch = await mkdtemp(join(tmpdir(), "ssjack-client-"));
try {
  const keyFile = join(scratch, "fixture.key");
  const certFile = join(scratch, "fixture.crt");
  const configFile = join(scratch, "fixture.cnf");
  await writeFile(configFile, [
    "[req]", "distinguished_name=dn", "x509_extensions=extensions", "prompt=no",
    "[dn]", "CN=ssjack-fixture", "[extensions]", "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature", "extendedKeyUsage=serverAuth", "subjectAltName=IP:127.0.0.1", "",
  ].join("\n"));
  await spawnLocal("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-days", "1", "-config", configFile, "-keyout", keyFile, "-out", certFile,
  ]);
  const key = await readFile(keyFile);
  const cert = await readFile(certFile);
  const actualPin = createHash("sha256").update(new X509Certificate(cert).raw).digest("hex");
  let count = 0;
  let mode: "normal" | "incompatible" | "redirect" | "oversize" | "invalid-utf8" | "wrong-id" | "wrong-jsonrpc" | "missing-result" | "tool-error" = "normal";
  const info = { protocol: 1, profile: "dev.profile", commit: "fixture", chunk_size: 16384, capabilities: ["exec", "stdin", "binary", "backpressure", "cancel"], cancellation: "connection-only" };
  const binary = Buffer.from([0, 255, 128, 10, 195, 169]);
  const server = createServer({ key, cert, minVersion: "TLSv1.3" }, async (req, res) => {
    count++;
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return; }
    const pieces: Buffer[] = [];
    for await (const piece of req) pieces.push(Buffer.from(piece as Buffer));
    const message = JSON.parse(Buffer.concat(pieces).toString("utf8")) as { id?: number; method: string; params?: { name?: string } };
    if (message.method === "notifications/initialized") { res.writeHead(202).end(); return; }
    if (message.method !== "initialize" && message.params?.name !== "transport_info") {
      if (mode === "redirect") { res.writeHead(302, { Location: "https://example.invalid/" }).end(); return; }
      if (mode === "oversize") { res.writeHead(200, { "Content-Type": "application/json" }).end("x".repeat(300000)); return; }
      if (mode === "invalid-utf8") { res.writeHead(200, { "Content-Type": "application/json" }).end(Buffer.from([0xFF])); return; }
    }
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-06-18", serverInfo: { name: "fixture", version: "1" }, capabilities: { tools: {} } }
      : { structuredContent: message.params?.name === "transport_info" ? { ...info, protocol: mode === "incompatible" ? 2 : 1 } : { stream: "stdout", data: binary.toString("base64"), done: false, exit_code: -1 }, ...(mode === "tool-error" ? { isError: true } : {}) };
    const replyId = mode === "wrong-id" && message.method !== "initialize" && message.params?.name !== "transport_info" ? -1 : message.id;
    const envelope = {
      jsonrpc: mode === "wrong-jsonrpc" ? "1.0" : "2.0",
      id: replyId,
      ...(mode === "missing-result" ? {} : { result }),
    };
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(envelope));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const endpoint = `https://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const clients: SsjackClient[] = [];
  const managed: SsjackTransport[] = [];
  const previous = new Map(Object.values(SSJACK_ENV).map((name) => [name, process.env[name]]));
  const client = (certificatePin = actualPin): SsjackClient => {
    const value = new SsjackClient({ endpoint, token, pin: certificatePin });
    clients.push(value);
    return value;
  };
  try {
    process.env[SSJACK_ENV.endpoint] = endpoint;
    process.env[SSJACK_ENV.token] = token;
    process.env[SSJACK_ENV.pin] = actualPin;
    for (const location of ["auto", "ssjack"]) {
      const selected = await createTransport({ location, platform: "win32" });
      assert.ok(selected instanceof SsjackTransport);
      managed.push(selected);
      assert.equal(selected.sessionScoped, true);
      assert.equal(selected.description, "ssjack:dev.profile");
    }
    mode = "incompatible";
    await assert.rejects(createTransport({ location: "auto", platform: "win32" }), /SSJACK_PROTOCOL_INCOMPATIBLE/);
    mode = "normal";
    process.env[SSJACK_ENV.pin] = "0".repeat(64);
    const unauthenticated = count;
    await assert.rejects(createTransport({ location: "auto", platform: "win32" }), /SSJACK_CERTIFICATE_MISMATCH/);
    assert.equal(count, unauthenticated);
    process.env[SSJACK_ENV.pin] = actualPin;

    const before = count;
    await assert.rejects(client("0".repeat(64)).info(), /SSJACK_CERTIFICATE_MISMATCH/);
    assert.equal(count, before, "no HTTP or Authorization before certificate pin verification");
    const connected = client();
    const metadata = await connected.info();
    assert.equal(metadata.profile, "dev.profile");
    assert.equal(metadata.protocol, 1);
    assert.equal(metadata.chunkSize, 16384);
    const output = await connected.call("transport_read", { job_id: "fixture" });
    assert.equal(typeof output.data, "string");
    assert.deepEqual(Buffer.from(output.data as string, "base64"), binary);
    connected.close();
    const closedCount = count;
    await assert.rejects(connected.call("transport_read", {}), /SSJACK_TRANSPORT_CLOSED/);
    assert.equal(count, closedCount);
    mode = "incompatible";
    await assert.rejects(client().info(), /SSJACK_PROTOCOL_INCOMPATIBLE/);
    mode = "normal";
    for (const [failureMode, expected] of [
      ["redirect", /SSJACK_HTTP_REJECTED/], ["oversize", /SSJACK_RESPONSE_TOO_LARGE/],
      ["invalid-utf8", /SSJACK_RESPONSE_INVALID/], ["wrong-id", /SSJACK_RPC_REJECTED/],
      ["wrong-jsonrpc", /SSJACK_RPC_REJECTED/], ["missing-result", /SSJACK_RPC_REJECTED/],
      ["tool-error", /SSJACK_TOOL_REJECTED/],
    ] as const) {
      const current = client();
      await current.info();
      mode = failureMode;
      const requestsBefore = count;
      await assert.rejects(current.call("transport_read", { job_id: "fixture" }), expected);
      assert.equal(count, requestsBefore + 1, "uncertain consumed frames are never retried");
      await assert.rejects(current.call("transport_read", {}), /SSJACK_TRANSPORT_CLOSED/);
      mode = "normal";
    }
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const current of managed) current.close();
    for (const current of clients) current.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); });
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

async function checkTextAdapter(): Promise<void> {
  // Independent immutable Go-canonical byte vector. Keep field order as the Go
  // producer emits it; IDs intentionally differ so field swaps cannot pass.
  const objectId = "0123456789abcdef0123456789abcdef";
  const snapshotId = "1123456789abcdef0123456789abcdef";
  const storeId = "2123456789abcdef0123456789abcdef";
  const versionId = "3123456789abcdef0123456789abcdef";
  const valid = `{"$ssjack":{"format":"ssjack-secret-ref-v1","object_id":"${objectId}","snapshot_id":"${snapshotId}","store_id":"${storeId}","version_id":"${versionId}"}}`;
  const second = (n: string) => {
    const id = Number.parseInt(n, 16).toString(16).padStart(32, "0");
    return `{"$ssjack":{"format":"ssjack-secret-ref-v1","object_id":"${id}","snapshot_id":"${snapshotId}","store_id":"${storeId}","version_id":"${id}"}}`;
  };
  assert.equal(parseCanonicalTextReferences(`prefix ${valid} suffix`)[0].store_id, storeId);
  assert.deepEqual(parseCanonicalTextReferences(`${valid} ${valid}`).length, 1, "identical references deduplicate");
  assert.equal(parseCanonicalTextReferences(Array.from({ length: 16 }, (_, i) => i === 0 ? valid : second((i + 1).toString(16))).join(" ")).length, 16);
  const duplicateKey = `{"$ssjack":{"format":"ssjack-secret-ref-v1","object_id":"${objectId}","object_id":"${objectId}","snapshot_id":"${snapshotId}","store_id":"${storeId}","version_id":"${versionId}"}}`;
  const malformedId = valid.replace(objectId, "not-a-32-hex-id");
  for (const invalid of [
    duplicateKey,
    malformedId,  valid.replace('"object_id":"' + objectId + '","snapshot_id":"' + snapshotId, '"snapshot_id":"' + snapshotId + '","object_id":"' + objectId),
    valid.replace('"object_id":"' + objectId, '"object_id": "' + objectId),
    valid.replace('"object_id":"' + objectId, '"object_id":"' + "0".repeat(32)),
    valid.replace('"store_id":"' + storeId, '"store_id":"' + "0".repeat(32)),
    valid.replace('"$ssjack":', '"$ssjack": '),
    valid.replace('"$ssjack"', '"\\u0024ssjack"'),
    `${valid} ${"x".repeat(32768)}`,
    `${valid}\ud800`,
    Array.from({ length: 17 }, (_, i) => i === 0 ? valid : second((i + 1).toString(16))).join(" "),
    `${valid} ${second("4").replace(snapshotId, "4".repeat(32))}`,
    `${valid} ${second("5").replace(storeId, "5".repeat(32))}`,
  ]) assert.throws(() => parseCanonicalTextReferences(invalid), /SSJACK_TEXT_TEMPLATE_INVALID/);

  const validTextEnvironment = {
    SSJACK_TEXT_LAUNCH: "1",
    SSJACK_TEXT_PROFILE: "human.profile",
    SSJACK_APP_ENDPOINT: "https://127.0.0.1:12345/mcp",
    SSJACK_APP_TOKEN: "a".repeat(64),
    SSJACK_APP_CERTIFICATE_SHA256: "b".repeat(64),
  };
  const mappedTextEnvironment = ssjackTextEnvironment(validTextEnvironment);
  assert.equal(mappedTextEnvironment.SSJACK_TEXT_ENDPOINT, validTextEnvironment.SSJACK_APP_ENDPOINT);
  assert.equal(mappedTextEnvironment.SSJACK_TEXT_PROFILE, validTextEnvironment.SSJACK_TEXT_PROFILE);
  assert.equal(mappedTextEnvironment.SSJACK_TEXT_TOKEN, validTextEnvironment.SSJACK_APP_TOKEN);
  assert.equal(mappedTextEnvironment.SSJACK_TEXT_CERTIFICATE_SHA256, validTextEnvironment.SSJACK_APP_CERTIFICATE_SHA256);
  assert.equal(mappedTextEnvironment.SSJACK_APP_ENDPOINT, undefined);
  assert.equal(validTextEnvironment.SSJACK_APP_ENDPOINT, 'https://127.0.0.1:12345/mcp');
  for (const invalidEnvironment of [
    { ...validTextEnvironment, SSJACK_TEXT_LAUNCH: "2" },
    { ...validTextEnvironment, SSJACK_APP_TOKEN: undefined },
    { ...validTextEnvironment, ssjack_text_launch: "1" },
    { ...validTextEnvironment, ssjack_app_endpoint: "https://127.0.0.1:12345/mcp" },
    { ...validTextEnvironment, SSJACK_TEXT_TOKEN: "c".repeat(64) },
  ]) assert.throws(() => ssjackTextEnvironment(invalidEnvironment), /SSJACK_TEXT_CONTEXT_INVALID/);

  let opened = 0;
  const stat = { size: 1, dev: 1, ino: 2, isFile: () => true };
  const fifo: SsjackTextInputFiles = {
    lstat: async () => ({ ...stat, isFile: () => false }),
    open: async (_path, flags) => {
      opened++;
      const nonblock = constants.O_NONBLOCK ?? 0;
      assert.equal(flags & nonblock, nonblock);
      throw new Error("unexpected open");
    },
  };
  await assert.rejects(readSsjackTextInputFrom("fifo", fifo), /SSJACK_TEXT_INPUT_FAILED/);
  assert.equal(opened, 0);

  const fakeFile = (openedStat: typeof stat, data: Buffer, expectedNonblock = constants.O_NONBLOCK ?? 0) => {
    let readcalls = 0;
    let closed = false;
    const files: SsjackTextInputFiles = {
      lstat: async () => stat,
      open: async (_path, flags) => {
        const nonblock = constants.O_NONBLOCK ?? 0;
        assert.equal(flags & nonblock, expectedNonblock);
        return {
          stat: async () => openedStat,
          read: async (buffer, offset, length) => {
            readcalls++;
            const bytesRead = Math.min(length, data.length);
            data.copy(buffer, offset, 0, bytesRead);
            data = data.subarray(bytesRead);
            return { bytesRead };
          },
          close: async () => {
            closed = true;
          },
        };
      },
    };
    return { files, readcalls: () => readcalls, closed: () => closed };
  };
  for (const openedStat of [
    { ...stat, isFile: () => false }, { ...stat, dev: 2 }, { ...stat, ino: 3 },
  ]) {
    const nativeFixture = fakeFile(openedStat, Buffer.from(valid));
    await assert.rejects(readSsjackTextInputFrom("changed", nativeFixture.files), /SSJACK_TEXT_INPUT_FAILED/);
    assert.equal(nativeFixture.readcalls(), 0);
    assert.equal(nativeFixture.closed(), true);
    const fixture = fakeFile(openedStat, Buffer.from(valid), 0);
    await assert.rejects(readSsjackTextInputFrom("changed", fixture.files, "win32"), /SSJACK_TEXT_INPUT_FAILED/);
    assert.equal(fixture.readcalls(), 0);
    assert.equal(fixture.closed(), true);
  }
  const sameIdentity = fakeFile(stat, Buffer.from(valid));
  assert.equal(await readSsjackTextInputFrom("same", sameIdentity.files), valid);
  assert.equal(sameIdentity.readcalls(), 2);
  assert.equal(sameIdentity.closed(), true);
  // Windows lacks POSIX O_NONBLOCK; regular-file opens remain supported while
  // the independent pre-stat and opened-handle identity checks stay mandatory.
  const windowsFile = fakeFile(stat, Buffer.from(valid), 0);
  const windowsInput = {
    ...windowsFile.files,
    open: async (_path: string, flags: number) => {
      assert.equal(flags & constants.O_NONBLOCK, 0);
      return windowsFile.files.open(_path, flags);
    },
  } satisfies SsjackTextInputFiles;
  assert.equal(await readSsjackTextInputFrom("same", windowsInput, "win32"), valid);
  let windowsOpened = 0;
  const windowsRejected = fakeFile(stat, Buffer.from(valid), 0);
  const windowsFifo: SsjackTextInputFiles = {
    lstat: async () => ({ ...stat, isFile: () => false }),
    open: async (path, flags) => { windowsOpened++; return windowsRejected.files.open(path, flags); },
  };
  await assert.rejects(readSsjackTextInputFrom("pipe", windowsFifo, "win32"), /SSJACK_TEXT_INPUT_FAILED/);
  assert.equal(windowsOpened, 0);
  assert.equal(windowsRejected.readcalls(), 0);
  assert.equal(windowsRejected.closed(), false);

  let consumed = 0;
  let closed = false;
  const growing: SsjackTextInputFiles = {
    lstat: async () => stat,
    open: async (_path, flags) => {
      const nonblock = constants.O_NONBLOCK ?? 0;
      assert.equal(flags & nonblock, nonblock);
      return {
        stat: async () => stat,
        read: async (buffer, offset, length) => {
          const bytesRead = Math.min(length, 65536 - consumed);
          buffer.fill(120, offset, offset + bytesRead);
          consumed += bytesRead;
          return { bytesRead };
        },
        close: async () => {
          closed = true;
        },
      };
    },
  };
  await assert.rejects(readSsjackTextInputFrom("grow", growing), /SSJACK_TEXT_INPUT_FAILED/);
  assert.equal(consumed, 32769);
  assert.equal(closed, true);

  const scratch = await mkdtemp(join(tmpdir(), "ssjack-text-input-check-"));
  try {
    const normal = join(scratch, "template.txt");
    await writeFile(normal, valid, "utf8");
    assert.equal(await readSsjackTextInput(normal), valid);
    const oversized = join(scratch, "oversized.txt");
    await writeFile(oversized, `${valid}${"x".repeat(32769)}`);
    await assert.rejects(readSsjackTextInput(oversized), /SSJACK_TEXT_INPUT_FAILED/);
    const badUtf8 = join(scratch, "invalid-utf8.txt");
    await writeFile(badUtf8, Buffer.from([0xc3, 0x28]));
    await assert.rejects(readSsjackTextInput(badUtf8), /SSJACK_TEXT_INPUT_FAILED/);
    const bom = join(scratch, "bom.txt");
    await writeFile(bom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(valid)]));
    assert.equal((await readSsjackTextInput(bom)).charCodeAt(0), 0xfeff);
    await assert.rejects(readSsjackTextInput(scratch), /SSJACK_TEXT_INPUT_FAILED/);
    assert.ok((await readFile(normal, "utf8")).includes(objectId));

    // Generate a synthetic certificate when this check runs in CI.
    const openssl = promisify(execFile);
    const certPath = join(scratch, "cert.pem");
    const keyPath = join(scratch, "key.pem");
    await openssl("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ]);
    const cert = await readFile(certPath, "utf8");
    const key = await readFile(keyPath, "utf8");
    const pin = createHash("sha256").update(new X509Certificate(cert).raw).digest("hex");
    const server = createServer({ cert, key });
  let replymode:
    | "normal"
    | "statusinvalid"
    | "wrongid"
    | "missingstructured"
    | "extra-key"
    | "drop"
    | "malformed-json"
    | "wrong-jsonrpc"
    | "missing-result"
    | "wire-overflow"
    | "wire-exact"
    | "invalid-utf8"
    | "failed-text"
    | "missing-text"
    | "http-rejected"
    | "truncated" = "normal";
  let wireStatus: "received" | "withheld" | "unknown" = "received";
    let capabilities = ["text_hydrate"];
    let advertisedProfile = "human.profile";
    let hydrateCount = 0;
    let reverseCount = 0;
    let copyText = "";
    let cancelReverse: (() => void) | undefined;
    let captured: Record<string, unknown> | undefined;
    server.on("request", (request, response) => {
      assert.deepEqual(request.headers.accept?.split(/\s*,\s*/), ["application/json", "text/event-stream"]);
      assert.deepEqual(
        Buffer.from(request.headers.authorization ?? "", "utf8"),
        Buffer.concat([Buffer.from("Bearer", "ascii"), Buffer.from([0x20]), Buffer.from("a".repeat(64), "ascii")]),
      );
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: number; method: string; params?: { name: string; arguments: Record<string, unknown> } };
        if (message.method === "notifications/initialized") {
          response.writeHead(202).end();
          return;
        }
        const { id, method, params } = message;
        let result: unknown;
        if (method === "initialize") result = { protocolVersion: "2025-06-18" };
        else if (method === "tools/call" && params?.name === "transport_info") {
          result = { structuredContent: { protocol: 1, profile: advertisedProfile, capabilities } };
        } else {
          if (params?.name === "text_reverse_copy") {
            reverseCount++;
            captured = params.arguments;
            cancelReverse?.();
            const structured = wireStatus === "received" ? { status: wireStatus, text: copyText } : { status: wireStatus };
            result = { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured };
            if (replymode === "failed-text") result = { content: [{ type: "text", text: JSON.stringify({ status: "unknown", text: "not-publishable" }) }], structuredContent: { status: "unknown", text: "not-publishable" } };
            if (replymode === "missing-text") result = { content: [{ type: "text", text: JSON.stringify({ status: "received" }) }], structuredContent: { status: "received" } };
          } else {
            hydrateCount++;
            captured = params?.arguments;
          }
          if (replymode === "wire-overflow") { const encoded = JSON.stringify({ jsonrpc: "2.0", id, result }); response.writeHead(200, { "Content-Type": "application/json" }).end(encoded + " ".repeat(25231361 - Buffer.byteLength(encoded))); return; }
          if (replymode === "invalid-utf8") { response.writeHead(200, { "Content-Type": "application/json" }).end(Buffer.from([255])); return; }
          if (replymode === "http-rejected") { response.writeHead(403).end(); return; }
          if (replymode === "truncated") { response.writeHead(200, { "Content-Type": "application/json" }); response.write('{"jsonrpc":"2.0","id":'); response.destroy(); return; }
          if (replymode === "malformed-json") {
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end("{");
            return;
          }
          if (replymode === "drop") {
            response.destroy();
            return;
          }
          if (replymode === "missingstructured") result = {};
          else if (replymode === "extra-key") result = { structuredContent: { status: wireStatus, extra: true } };
          else if (params?.name !== "text_reverse_copy") result = { structuredContent: { status: replymode === "statusinvalid" ? "bogus" : wireStatus } };
        }
        const replyId = ["text_hydrate", "text_reverse_copy"].includes(params?.name ?? "") && replymode === "wrongid" ? id + 1 : id;
        const textTool = params?.name === "text_hydrate" || params?.name === "text_reverse_copy";
        const envelope = { jsonrpc: textTool && replymode === "wrong-jsonrpc" ? "1.0" : "2.0", id: replyId, ...(textTool && replymode === "missing-result" ? {} : { result }) };
        if (replymode === "wire-exact" && params?.name === "text_reverse_copy") { const encoded = JSON.stringify(envelope); response.writeHead(200, { "Content-Type": "application/json" }).end(encoded + " ".repeat(25231360 - Buffer.byteLength(encoded))); return; }
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(envelope));
      });
    });
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const endpoint = `https://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const client = () => new SsjackTextClient({
      endpoint,
      token: "a".repeat(64),
      pin,
      profile: "human.profile",
    });
    const reverseClient = () => new SsjackTextClient({ endpoint, token: "a".repeat(64), pin, profile: "human.profile" }, "text_reverse_copy");
    try {
      capabilities = ["text_reverse_copy"];
      for (const received of ["", "ordinary", "\uFEFFé🙂", valid] as const) {
        copyText = received;
        const current = reverseClient();
        const before = reverseCount;
        assert.deepEqual(await current.textReverseCopy("fixture.txt", { timeoutMs: 3000 }), { status: "received", text: received });
        assert.equal(reverseCount, before + 1);
        assert.deepEqual(Object.keys(captured!).sort(), ["file", "mode", "operation_id"]);
        assert.equal(captured!.file, "fixture.txt");
        assert.equal(captured!.mode, "reverse-copy-v1");
        assert.match(captured!.operation_id as string, /^[A-Za-z0-9_-]{22}$/);
        await assert.rejects(current.textReverseCopy("fixture.txt"), /SSJACK_TEXT_OPERATION_FAILED/);
        assert.equal(reverseCount, before + 1);
      }
      for (const mode of ["malformed-json", "drop", "missingstructured", "extra-key", "wrongid", "wrong-jsonrpc", "missing-result", "wire-overflow", "invalid-utf8", "failed-text", "missing-text", "http-rejected", "truncated"] as const) {
        replymode = mode;
        const before = reverseCount;
        const current = reverseClient();
        const response = await current.textReverseCopy("fixture.txt", { timeoutMs: 3000 });
        assert.deepEqual(response, { status: "unknown" });
        assert.equal(reverseCount, before + 1);
        await assert.rejects(current.textReverseCopy("fixture.txt"), /SSJACK_TEXT_OPERATION_FAILED/);
        assert.equal(reverseCount, before + 1);
      }
      replymode = "normal";
      capabilities = ["text_hydrate"];
      for (const mode of ["normal", "statusinvalid", "wrongid", "missingstructured", "extra-key", "drop", "malformed-json", "wrong-jsonrpc", "missing-result"] as const) {
        replymode = mode;
        wireStatus = "received";
        const before = hydrateCount;
        const current = client();
        const expected = mode === "normal" ? "received" : "unknown";
        assert.equal(await current.textHydrate("fixture.txt", valid, { timeoutMs: 3000 }), expected);
        assert.equal(hydrateCount, before + 1);
        assert.deepEqual(Object.keys(captured!).sort(), ["file", "mode", "operation_id", "template"]);
        assert.equal(captured!.file, "fixture.txt");
        assert.equal(captured!.mode, "hydrate-v1");
        assert.equal(captured!.template, valid);
        assert.match(captured!.operation_id as string, /^[A-Za-z0-9_-]{22}$/);
        assert.equal(Buffer.from(captured!.operation_id as string, "base64url").length, 16);
        await assert.rejects(current.textHydrate("fixture.txt", valid), /SSJACK_TEXT_OPERATION_FAILED/);
      }
      replymode = "normal";
      for (const status of ["received", "withheld", "unknown"] as const) {
        wireStatus = status;
        const current = client();
        const before = hydrateCount;
        assert.equal(await current.textHydrate("fixture.txt", valid, { timeoutMs: 3000 }), status);
        assert.equal(hydrateCount, before + 1);
        await assert.rejects(current.textHydrate("fixture.txt", valid), /SSJACK_TEXT_OPERATION_FAILED/);
      }
      wireStatus = "received";
      const before = hydrateCount;
      advertisedProfile = "other.profile";
      await assert.rejects(client().textHydrate("fixture.txt", valid, { timeoutMs: 3000 }), /SSJACK_TEXT_OPERATION_FAILED/);
      assert.equal(hydrateCount, before);
      advertisedProfile = "human.profile";
      capabilities = ["text_hydrate", "exec"];
      const unsupported = client();
      await assert.rejects(unsupported.textHydrate("fixture.txt", valid, { timeoutMs: 3000 }), /SSJACK_TEXT_OPERATION_FAILED/);
      assert.equal(hydrateCount, before);
      capabilities = ["text_hydrate"];
      // Invalid input is also rejected before dispatching a hydrate operation.
      await assert.rejects(client().textHydrate("", valid, { timeoutMs: 3000 }), /SSJACK_TEXT_OPERATION_FAILED/);
      assert.equal(hydrateCount, before);
      const priorEnvironment = new Map<string, string | undefined>();
      const contextNames = ["SSJACK_TEXT_LAUNCH", "SSJACK_APP_ENDPOINT", "SSJACK_APP_TOKEN", "SSJACK_APP_CERTIFICATE_SHA256", "SSJACK_TEXT_ENDPOINT", "SSJACK_TEXT_TOKEN", "SSJACK_TEXT_CERTIFICATE_SHA256", "SSJACK_TEXT_PROFILE"];
      for (const name of contextNames) {
        priorEnvironment.set(name, process.env[name]);
        delete process.env[name];
      }
      try {
        process.env.SSJACK_TEXT_LAUNCH = "1";
        process.env.SSJACK_APP_ENDPOINT = endpoint;
        process.env.SSJACK_APP_TOKEN = "a".repeat(64);
        process.env.SSJACK_APP_CERTIFICATE_SHA256 = pin;
        process.env.SSJACK_TEXT_PROFILE = "human.profile";
        const app = { name: "fixture", description: "fixture", commands: orchestrationCommands };
        const invoke = (argv: string[], command = "deploy-text") => executeCommand(app, command, { kind: "argv", argv }, { surface: "terminal" });
        const call = async (argv: string[], command = "deploy-text") => {
          const output: string[] = [];
          const result = await withOutputSink((chunk) => {
            output.push(chunk);
          }, () => invoke(argv, command));
          return { result, output: output.join("") };
        };
        const liveContext = new Map(contextNames.map((name) => [name, process.env[name]]));
        for (const name of contextNames) delete process.env[name];
        const beforeUnavailable = hydrateCount;
        const unavailable = await call(["--file", "fixture.txt", "--template", normal, "--profile", "human.profile"]);
        assert.equal(unavailable.result.reachedRun, true);
        assert.ok(unavailable.result.error);
        assert.equal(hydrateCount, beforeUnavailable);
        for (const [name, value] of liveContext) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        replymode = "normal";
        wireStatus = "received";
        const validCall = await call(["--file", "fixture.txt", "--template", normal, "--profile", "human.profile"]);
        assert.equal(validCall.result.reachedRun, true);
        assert.equal(validCall.result.error, undefined);
        assert.equal(validCall.output, '{"status":"received"}\n');
        for (const status of ["unknown", "withheld"] as const) {
          wireStatus = status;
          const outcome = await call(["--file", "fixture.txt", "--template", normal, "--profile", "human.profile"]);
          assert.equal(outcome.result.reachedRun, true);
          assert.equal(outcome.result.exitCode, 1);
          assert.equal(outcome.output, `{"status":"${status}"}\n`);
        }
        wireStatus = "received";
        const beforeRefusals = hydrateCount;
        const missing = await call(["--file", "fixture.txt", "--template", normal]);
        assert.equal(missing.result.stage, "parse");
        const unknown = await executeCommand(app, "apply-config", { kind: "argv", argv: ["--text-template", normal] }, { surface: "terminal" });
        assert.equal(unknown.stage, "parse");
        assert.equal(hydrateCount, beforeRefusals);
        delete process.env.SSJACK_TEXT_PROFILE;
        const partial = await call(["--file", "fixture.txt", "--template", normal, "--profile", "human.profile"]);
        assert.equal(partial.result.reachedRun, true);
        assert.ok(partial.result.error);
        assert.equal(hydrateCount, beforeRefusals);

        process.env.SSJACK_TEXT_PROFILE = "human.profile";
        const noRuntime = { dryRun: false, runtime: { runOneOff: async () => { throw new Error("UNEXPECTED_GENERIC_RUNTIME"); } } };
        capabilities = ["text_reverse_copy"];
        copyText = valid;
        const reverseInput = join(scratch, "fixture.txt");
        const reverseOutput = join(scratch, "new-copy.txt");
        await writeFile(reverseInput, valid, "utf8");
        const backupCall = (argv: string[]) => call(argv, "backup-text");
        const backupArgs = ["--file", reverseInput, "--output", reverseOutput, "--profile", "human.profile"];
        const beforeReverse = reverseCount;
        const preDispatchAbort = new AbortController();
        preDispatchAbort.abort();
        await assert.rejects(reverseClient().textReverseCopy("fixture.txt", { timeoutMs: 3000, signal: preDispatchAbort.signal }), /SSJACK_TEXT_OPERATION_FAILED/);
        assert.equal(reverseCount, beforeReverse);
        const cancellation = new AbortController();
        cancelReverse = () => cancellation.abort();
        assert.deepEqual(await reverseClient().textReverseCopy("fixture.txt", { timeoutMs: 3000, signal: cancellation.signal }), { status: "unknown" });
        cancelReverse = undefined;
        assert.equal(reverseCount, beforeReverse + 1);
        const copied = await backupCall(backupArgs);
        assert.equal(copied.result.error, undefined);
        assert.equal(copied.result.exitCode, undefined);
        assert.equal(copied.output, '{"status":"received"}\n');
        assert.equal(await readFile(reverseOutput, "utf8"), valid);
        assert.equal(await readFile(reverseInput, "utf8"), valid);
        assert.equal(reverseCount, beforeReverse + 2);
        copyText = "wrong response";
        const rejectedCopy = await backupCall(backupArgs);
        assert.ok(rejectedCopy.result.error);
        assert.equal(await readFile(reverseOutput, "utf8"), valid);
        copyText = valid;
        assert.deepEqual(await backupText(noRuntime as never, { file: reverseInput, profile: 'human.profile' }), { status: 'received', text: valid });
        for (const status of ["withheld", "unknown"] as const) {
          wireStatus = status;
          const response = await reverseClient().textReverseCopy("fixture.txt", { timeoutMs: 3000 });
          assert.deepEqual(response, status === "withheld" ? { status: "withheld" } : { status: "unknown" });
          const failedOutput = join(scratch, `failed-${status}.txt`);
          const failed = await backupCall(["--file", "fixture.txt", "--output", failedOutput, "--profile", "human.profile"]);
          assert.equal(failed.result.exitCode, 1);
          assert.equal(failed.output, `{"status":"${status}"}\n`);
          await assert.rejects(readFile(failedOutput));
          assert.deepEqual(await backupText(noRuntime as never, { file: "fixture.txt", profile: "human.profile" }), { status });
        }
        wireStatus = "received";
        const boundaryText = String.fromCharCode(1).repeat(1048576);
        copyText = boundaryText;
        const boundaryResponse = await reverseClient().textReverseCopy("fixture.txt", { timeoutMs: 3000 });
        assert.equal(boundaryResponse.status === "received" && boundaryResponse.text === boundaryText, true);
        replymode = "wire-exact";
        assert.deepEqual(await reverseClient().textReverseCopy("fixture.txt", { timeoutMs: 3000 }), { status: "received", text: boundaryText });
        replymode = "normal";
        const nativeNow = Date.now;
        const nativeParse = JSON.parse;
        try {
          JSON.parse = ((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
            const value = nativeParse(text, reviver);
            if (text.includes('"status":"received"') && text.includes('"text":"parse-late"')) Date.now = () => nativeNow() + 3001;
            return value;
          }) as typeof JSON.parse;
          copyText = "parse-late";
          assert.deepEqual(await reverseClient().textReverseCopy("fixture.txt", { timeoutMs: 3000 }), { status: "unknown" });
        } finally {
          JSON.parse = nativeParse;
          Date.now = nativeNow;
        }
        for (const invalidText of ["\0", "\ud800", "x".repeat(1048577)]) {
          copyText = invalidText;
          const before = reverseCount;
          const response = await reverseClient().textReverseCopy("fixture.txt", { timeoutMs: 3000 });
          assert.deepEqual(response, { status: "unknown" });
          assert.equal(reverseCount, before + 1);
        }
        const reverseBeforeRefusal = reverseCount;
        capabilities = ["text_hydrate"];
        await assert.rejects(reverseClient().textReverseCopy("fixture.txt", { timeoutMs: 3000 }), /SSJACK_TEXT_OPERATION_FAILED/);
        assert.equal(reverseCount, reverseBeforeRefusal);
        capabilities = ["text_reverse_copy", "exec"];
        await assert.rejects(reverseClient().textReverseCopy("fixture.txt", { timeoutMs: 3000 }), /SSJACK_TEXT_OPERATION_FAILED/);
        assert.equal(reverseCount, reverseBeforeRefusal);
        capabilities = ["text_hydrate"];
        assert.equal(await deployText(noRuntime as never, { file: "fixture.txt", template: valid, profile: "human.profile" }), "received");
        assert.equal(await deployText(noRuntime as never, { file: "fixture.txt", template: await readFile(reverseOutput, "utf8"), profile: "human.profile" }), "received");
        for (const unsupported of ["", "ordinary", valid + "x".repeat(32768)]) {
          const beforeUnsupported = hydrateCount;
          await assert.rejects(deployText(noRuntime as never, { file: "fixture.txt", template: unsupported, profile: "human.profile" }));
          assert.equal(hydrateCount, beforeUnsupported);
        }
        await assert.rejects(backupText({ ...noRuntime, dryRun: true } as never, { file: reverseInput, profile: "human.profile" }));
        const priorTextProfile = process.env.SSJACK_TEXT_PROFILE;
        delete process.env.SSJACK_TEXT_PROFILE;
        const missingTextProfile = await backupCall(backupArgs);
        assert.ok(missingTextProfile.result.error);
        assert.equal(await readFile(reverseOutput, "utf8"), valid);
        await assert.rejects(backupText(noRuntime as never, { file: reverseInput, profile: "human.profile" }));
        if (priorTextProfile === undefined) delete process.env.SSJACK_TEXT_PROFILE;
        else process.env.SSJACK_TEXT_PROFILE = priorTextProfile;
        const beforeWrongProfile = hydrateCount;
        await assert.rejects(backupText(noRuntime as never, { file: reverseInput, profile: "wrong.profile" }));
        await assert.rejects(deployText(noRuntime as never, { file: "fixture.txt", template: valid, profile: "wrong.profile" }));
        assert.equal(hydrateCount, beforeWrongProfile);
        for (const status of ["unknown", "withheld"] as const) {
          wireStatus = status;
          assert.equal(await deployText(noRuntime as never, { file: "fixture.txt", template: valid, profile: "human.profile" }), status);
        }
        wireStatus = "received";
        await assert.rejects(deployText({ ...noRuntime, dryRun: true } as never, { file: "fixture.txt", template: valid, profile: "human.profile" }));
        for (const location of ["auto", "local", "wsl", "ssh", "ssjack"]) {
          await assert.rejects(createTransport({ location, platform: "linux", sshHost: "fixture@host" }), /SSJACK_TEXT_CONTEXT_NOT_TRANSPORT/);
        }
        for (const name of contextNames) delete process.env[name];
        const ordinaryLocal = await createTransport({ location: "local", platform: "linux" });
        assert.ok(ordinaryLocal);
      } finally {
        for (const [name, value] of priorEnvironment) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

await checkTextAdapter();

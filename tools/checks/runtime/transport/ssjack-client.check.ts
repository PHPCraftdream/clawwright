import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { spawnLocal } from "#framework/runtime/transport/transport.ts";
import { SsjackClient, ssjackBootstrap, validateBootstrap } from "#framework/runtime/transport/ssjack/client.ts";
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
  let mode: "normal" | "incompatible" | "redirect" | "oversize" | "invalid-utf8" | "wrong-id" | "tool-error" = "normal";
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
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: mode === "wrong-id" && message.method !== "initialize" && message.params?.name !== "transport_info" ? -1 : message.id, result }));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const endpoint = `https://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const clients: SsjackClient[] = [];
  const client = (certificatePin = actualPin): SsjackClient => {
    const value = new SsjackClient({ endpoint, token, pin: certificatePin });
    clients.push(value);
    return value;
  };
  try {
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
    for (const current of clients) current.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); });
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

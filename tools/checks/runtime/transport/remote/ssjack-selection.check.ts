import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:net";
import { createTransport, LocalTransport, WslTransport, SshTransport, spawnLocal } from "#framework/runtime/transport/transport.ts";
import { SSJACK_ENV, clearSsjackEnvironment } from "#framework/runtime/transport/remote/ssjack-contract.ts";

const names = Object.values(SSJACK_ENV).flatMap((name) => [name, name.toLowerCase()]);
const previous = new Map(names.map((name) => [name, process.env[name]]));
try {
  for (const name of names) delete process.env[name];
  assert.ok(await createTransport({ location: "auto", platform: "linux" }) instanceof LocalTransport);
  assert.ok(await createTransport({ location: "auto", platform: "win32" }) instanceof WslTransport);
  await assert.rejects(createTransport({ location: "ssjack" }), /SSJACK_CONTEXT_REQUIRED/);

  process.env[SSJACK_ENV.token] = "a".repeat(64);
  await assert.rejects(createTransport({ location: "auto", platform: "win32" }), /SSJACK_CONTEXT_INCOMPLETE/);
  assert.ok(await createTransport({ location: "local", platform: "linux" }) instanceof LocalTransport);
  assert.ok(await createTransport({ location: "wsl", platform: "win32" }) instanceof WslTransport);
  assert.ok(await createTransport({ location: "ssh", sshHost: "fixture" }) instanceof SshTransport);

  process.env[SSJACK_ENV.endpoint] = "http://127.0.0.1:12345/mcp";
  process.env[SSJACK_ENV.pin] = "b".repeat(64);
  await assert.rejects(createTransport({ location: "auto", platform: "linux" }), /SSJACK_CONTEXT_INVALID/);

  const unused = createServer();
  await new Promise<void>((resolve, reject) => { unused.once("error", reject); unused.listen(0, "127.0.0.1", resolve); });
  const port = (unused.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => { unused.close((error) => error ? reject(error) : resolve()); });
  process.env[SSJACK_ENV.endpoint] = `https://127.0.0.1:${port}/mcp`;
  await assert.rejects(createTransport({ location: "auto", platform: "win32" }));

  process.env[SSJACK_ENV.token.toLowerCase()] = "c".repeat(64);
  const parentToken = process.env[SSJACK_ENV.token];
  const script = "process.stdout.write(JSON.stringify(Object.keys(process.env).filter(name=>name.toLowerCase().startsWith('ssjack_app_'))))";
  const child = await spawnLocal(process.execPath, ["-e", script], { env: { [SSJACK_ENV.token]: "override" } });
  assert.deepEqual(JSON.parse(child.stdout), []);
  assert.equal(process.env[SSJACK_ENV.token], parentToken);

  const original = { [SSJACK_ENV.token.toLowerCase()]: "fixture", KEEP: "value" };
  const sanitized = { ...original };
  clearSsjackEnvironment(sanitized);
  assert.deepEqual(sanitized, { KEEP: "value" });
  assert.equal(original[SSJACK_ENV.token.toLowerCase()], "fixture");
} finally {
  for (const [name, value] of previous) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

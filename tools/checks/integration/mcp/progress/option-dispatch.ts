import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { main } from "#framework/entry/cli.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { LocalTransport, spawnLocal, hostPlatform, type ExecOptions } from "#framework/runtime/transport/transport.ts";
import { fixtureMutationTarget } from "./fixture-mutation.ts";

const [root, shim, ...argv] = process.argv.slice(2);
useDeployment(root);
hostPlatform.current = "linux"; // Controlled executable, not a real local target.
LocalTransport.prototype.exec = function (command: string, args: string[], options: ExecOptions = {}) {
  return spawnLocal(process.execPath, [shim, root, command, ...args], options);
};
const mkdirp = LocalTransport.prototype.mkdirp;
LocalTransport.prototype.mkdirp = async function (path: string) {
  await mkdirp.call(this, await fixtureMutationTarget(root, path));
};
const write = LocalTransport.prototype.writeFile;
LocalTransport.prototype.writeFile = async function (path, content, mode) {
  await write.call(this, await fixtureMutationTarget(root, path), content, mode);
};
const remove = LocalTransport.prototype.remove;
LocalTransport.prototype.remove = async function (path) {
  await remove.call(this, await fixtureMutationTarget(root, path));
};
if (argv[0] === "--fixture-guard-probe") {
  const outside = argv[1]!;
  const transport = new LocalTransport();
  const sentinel = join(outside, "sentinel");
  await assert.rejects(() => transport.mkdirp(join(outside, "new")), /fixture mutation outside root/);
  await assert.rejects(() => transport.writeFile(sentinel, "changed"), /fixture mutation outside root/);
  await assert.rejects(() => transport.remove(sentinel), /fixture mutation outside root/);
  await assert.rejects(() => stat(join(outside, "new")), { code: "ENOENT" });
  assert.equal(await readFile(sentinel, "utf8"), "unchanged");
  const inside = join(root, "guard-positive");
  await transport.mkdirp(inside);
  await transport.writeFile(join(inside, "file"), "inside");
  assert.equal(await readFile(join(inside, "file"), "utf8"), "inside");
  await transport.remove(inside);
  await assert.rejects(() => stat(inside), { code: "ENOENT" });
  process.stdout.write("fixture guard probe passed\n");
} else {
  await main({ name: "literal-options", description: "Controlled argument consumer", commands: openclawCommands, service: { name: "gateway" } }, argv);
}

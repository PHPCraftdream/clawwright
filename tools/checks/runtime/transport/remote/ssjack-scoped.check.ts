import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { composeFile, monorepoRoot, toSettings } from "#framework/core/env.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { createPathBridge, type PathBridge } from "#framework/core/paths.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult, Transport } from "#framework/runtime/transport/transport.ts";
import { ComposeOperations } from "#framework/runtime/docker/compose-operations.ts";
import { createIO, RefusalError } from "#framework/runtime/docker/side-stack/io.ts";
import { runRemote } from "#framework/commands/management/deploy/server.ts";
import { exposeSsh } from "#framework/commands/operate/expose/ssh.ts";
import { updateCrontab, printSchedulingInstructions, printUnschedulingInstructions, schedulingSupport } from "#framework/commands/operate/schedule.ts";

/** Record target actions without opening sockets or touching a target filesystem. */
class Recording implements Transport {
  readonly description = "ssjack:fixture";
  sessionScoped: true | undefined = true;
  readonly events: string[] = [];
  readonly executions: { program: string; args: string[] }[] = [];
  readonly writes: { path: string; bytes: Buffer; private: boolean }[] = [];
  readonly removed: string[] = [];
  writePrivateFile: Transport["writePrivateFile"] = async (path, content) => {
    this.events.push("private-write");
    this.writes.push({ path, bytes: typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content), private: true });
  };

  /** Record argv, keeping effects entirely inside this fixture. */
  async exec(program: string, args: string[]): Promise<ExecResult> {
    this.events.push("exec");
    this.executions.push({ program, args });
    return { code: 0, stdout: "", stderr: "" };
  }

  /** Unexpected reads make an admission failure observable. */
  async readFile(_path: string): Promise<never> { throw new Error("FIXTURE_UNEXPECTED_READ"); }
  /** Capture bytes separately from argv. */
  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    this.events.push("write");
    this.writes.push({ path, bytes: typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content), private: false });
  }
  /** Report no pre-existing target entry in this isolated recording. */
  async exists(_path: string): Promise<boolean> { this.events.push("exists"); return false; }
  /** Record directory preparation. */
  async mkdirp(_path: string): Promise<void> { this.events.push("mkdir"); }
  /** Retain cleanup evidence rather than deleting operator files. */
  async remove(path: string): Promise<void> { this.events.push("remove"); this.removed.push(path); }
  /** No stale per-call directories exist in this fixture. */
  async listFiles(_path: string): Promise<string[]> { this.events.push("list"); return []; }
  /** A missed persistent-route guard must not silently succeed in the fixture. */
  clientInvocation(_entry: string, _args: string[]): never { throw new Error("FIXTURE_UNEXPECTED_INVOCATION"); }
}

useDeployment(resolve(monorepoRoot, "apps", "ssjack-scoped-fixture"));
const settings = toSettings({ OC_DATA_DIR: "/fixture/data", OPENCLAW_GATEWAY_TOKEN: "fixture" });
const target = new Recording();
const paths = await createPathBridge({
  kind: "scoped", mounts: [{ target: settings.dataDir, container: "/container/data" }],
  readFile: (path) => target.readFile(path),
});
await assert.rejects(paths.toTarget(composeFile), /SSJACK_PATH_MAPPING_UNSUPPORTED/);
await assert.rejects(paths.toTool(settings.dataDir), /SSJACK_PATH_MAPPING_UNSUPPORTED/);
assert.equal(paths.toContainer(`${settings.dataDir}/config`), "/container/data/config");
assert.equal(paths.fromContainer("/container/data/config"), `${settings.dataDir}/config`);
assert.deepEqual(target.events, []);

const operations = new ComposeOperations(target, () => settings, () => {}, paths, "gateway", "10", undefined);
await operations.compose(["ps"]);
const staged = target.writes.find((entry) => posix.basename(entry.path) === "compose.yaml");
assert.ok(staged);
assert.equal(staged.private, true);
assert.deepEqual(staged.bytes, await readFile(composeFile));
const invocation = target.executions.find((entry) => entry.program === "docker");
assert.ok(invocation);
assert.equal(invocation.args[invocation.args.indexOf("--file") + 1], staged.path);
assert.equal(invocation.args[invocation.args.indexOf("--project-directory") + 1], posix.dirname(staged.path));
assert.deepEqual(target.removed, [posix.dirname(staged.path)]);

const unsupported = new Recording();
unsupported.writePrivateFile = undefined;
const missingStage = new ComposeOperations(unsupported, () => settings, () => {}, paths, "gateway", "10", undefined);
await assert.rejects(missingStage.compose(["ps"]), /SSJACK_PRIVATE_STAGING_REQUIRED/);
assert.deepEqual(unsupported.events, []);
await assert.rejects(missingStage.runOneOff("cli", [], { stdioProtocol: true }), /SSJACK_STDIO_PROTOCOL_UNSUPPORTED/);
assert.deepEqual(unsupported.events, []);

const failedStage = new Recording();
const stageFailure = new Error("FIXTURE_STAGE_FAILED");
failedStage.writePrivateFile = async () => { throw stageFailure; };
const rejectedStage = new ComposeOperations(failedStage, () => settings, () => {}, paths, "gateway", "10", undefined);
await assert.rejects(rejectedStage.compose(["ps"]), (error: unknown) => error === stageFailure);
assert.equal(failedStage.removed.length, 1);
assert.equal(failedStage.executions.some((entry) => entry.program === "docker"), false);

const guarded = new Recording();
const context = { settings, transport: guarded, paths } as Context;
assert.equal(schedulingSupport(context).supported, false);
await assert.rejects(updateCrontab(context, "fixture", "fixture"), /SSJACK_PERSISTENT_INVOCATION_UNSUPPORTED/);
await assert.rejects(printSchedulingInstructions(context, "fixture", "fixture", 60, [], true), /SSJACK_PERSISTENT_INVOCATION_UNSUPPORTED/);
await assert.rejects(printUnschedulingInstructions(context, "fixture", true), /SSJACK_PERSISTENT_INVOCATION_UNSUPPORTED/);
await assert.rejects(runRemote(context, "second-hop", "true"), /SSJACK_SECOND_HOP_UNSUPPORTED/);
await assert.rejects(exposeSsh(context, []), /SSJACK_PORT_FORWARDING_UNSUPPORTED/);
assert.throws(() => createIO(guarded, paths, () => settings, "fixture", "/operator/recipe.yml", []),
  (error: unknown) => error instanceof RefusalError && error.code === "SSJACK_RECIPE_STAGING_UNSUPPORTED");
assert.deepEqual(guarded.events, []);

const legacy = new Recording();
legacy.sessionScoped = undefined;
let mappings = 0;
const shared: PathBridge = {
  toTarget: async () => { mappings++; return "/legacy/shared"; },
  toTool: async (path) => path,
  toContainer: (path) => path,
  fromContainer: (path) => path,
};
await new ComposeOperations(legacy, () => settings, () => {}, shared, "gateway", "10", undefined).compose(["ps"]);
assert.equal(mappings, 2);
assert.equal(legacy.writes.some((entry) => entry.private), false);

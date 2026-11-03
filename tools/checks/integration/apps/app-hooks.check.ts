import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runApp } from "#framework/entry/cli.ts";
import { createContext } from "#framework/core/context.ts";
import { useDeployment, deploymentDir } from "#framework/runtime/deployment.ts";
import { requirements, requirementsForConfig } from "#framework/service/secrets.ts";
import { preflightSecrets, secrets as secretsCommand } from "#framework/commands/management/configuration/secrets.ts";
import type { ExecResult, Transport } from "#framework/runtime/transport/transport.ts";
import { spawnLocal } from "#framework/runtime/transport/transport.ts";
import { withOutputSink, emit } from "#framework/core/io/output.ts";
import type { AppDefinition } from "#framework/core/app.ts";
import { useLinuxHost } from "#checks/foundation/hygiene/linux-host.ts";
import { CHILD_NODE_DEADLINE_MS } from "#checks/kit/spawn.ts";

useLinuxHost();

const root = await mkdtemp(join(tmpdir(), "clawwright-app-hooks-"));
const previousDeployment = (() => {
  try { return deploymentDir(); } catch { return undefined; }
})();
let settingsCalls = 0;
let secretsCalls = 0;

class MemoryTransport implements Transport {
  readonly description = "memory";
  readonly files = new Map<string, string>();

  async exec(command: string, args: string[]): Promise<ExecResult> {
    if (command === "mkdir") return { code: 0, stdout: "", stderr: "" };
    if (command === "rm" && args[0] === "-rf") this.files.delete(args[1]);
    if (command === "mv") {
      const source = args[args.length - 2] ?? "";
      const destination = args[args.length - 1] ?? "";
      const staged = this.files.get(source);
      if (staged !== undefined) {
        this.files.set(destination, staged);
        this.files.delete(source);
      }
    }
    return { code: 0, stdout: "", stderr: "" };
  }
  async readFile(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`missing ${path}`);
    return value;
  }
  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    this.files.set(path, typeof content === "string" ? content : new TextDecoder().decode(content));
  }
  async writePrivateFile(path: string, content: string | Uint8Array): Promise<void> {
    assert.equal(this.files.has(path), false, "private staging creation is exclusive");
    await this.writeFile(path, content);
  }
  async exists(path: string): Promise<boolean> { return this.files.has(path); }
  async mkdirp(_path: string): Promise<void> {}
  async remove(path: string): Promise<void> { this.files.delete(path); }
  async removeEmptyDir(_path: string): Promise<void> {}
  async removeEmptyTree(_path: string): Promise<boolean> { return false; }
  async listFiles(_dir: string): Promise<string[]> { return []; }
  clientInvocation(entryPath: string, args: string[]): { command: string; args: string[] } { return { command: entryPath, args }; }
}

try {
  await mkdir(join(root, "data", "config"), { recursive: true });
  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(
    join(root, ".env"),
    `OC_DATA_DIR=${join(root, "data")}
OC_TARGET_LOCATION=local
OPENCLAW_GATEWAY_TOKEN=synthetic-gateway-token
`,
  );
  await writeFile(join(root, "data", "config", "openclaw.json"), "{}");
  useDeployment(root);

  const app: AppDefinition = {
    name: "hooks",
    description: "hook fixture",
    settings: (env) => {
      settingsCalls += 1;
      env.MUTATED_BY_HOOK = "must not leak";
      return { APP_MODE: "test", OPENCLAW_GATEWAY_PORT: "19999" };
    },
    secrets: async (ctx) => {
      secretsCalls += 1;
      assert.equal(ctx.settings.env.APP_MODE, "test");
      return [{ name: "APP_SECRET", location: "target-env", usedBy: "hook fixture" }];
    },
    commands: {
      inspect: {
        summary: "inspect hooks",
        run: async (ctx) => {
          const needed = await requirements(ctx);
          emit(JSON.stringify({ env: ctx.settings.env, gatewayPort: ctx.settings.gatewayPort, serviceUrl: ctx.settings.serviceUrl, needed }));
        },
      },
    },
  };

  const output: string[] = [];
  await withOutputSink((chunk) => output.push(chunk), () => runApp(app, ["inspect"]));
  const result = JSON.parse(output.join("")) as {
    env: Record<string, string>;
    gatewayPort: string;
    serviceUrl: string;
    needed: { name: string; required: boolean; location: string }[];
  };
  assert.equal(settingsCalls, 1);
  assert.equal(secretsCalls, 1);
  assert.equal(result.env.APP_MODE, "test");
  assert.equal(result.env.MUTATED_BY_HOOK, undefined);
  assert.equal(result.gatewayPort, "19999");
  assert.equal(result.serviceUrl, "http://127.0.0.1:19999");
  assert.deepEqual(result.needed, [{ name: "APP_SECRET", location: "target-env", usedBy: "hook fixture", required: true }]);

  await writeFile(join(root, ".env"), `OC_DATA_DIR=${join(root, "data")}\nOC_TARGET_LOCATION=local\nOPENCLAW_GATEWAY_PORT=18888\nOPENCLAW_GATEWAY_TOKEN=synthetic-gateway-token\n`);
  const explicitOutput: string[] = [];
  await withOutputSink((chunk) => explicitOutput.push(chunk), () => runApp(app, ["inspect"]));
  const explicit = JSON.parse(explicitOutput.join("")) as { gatewayPort: string; serviceUrl: string };
  assert.equal(explicit.gatewayPort, "18888");
  assert.equal(explicit.serviceUrl, "http://127.0.0.1:18888");

  const explicitEnv = `OC_DATA_DIR=${join(root, "data")}\nOC_TARGET_LOCATION=local\nOPENCLAW_GATEWAY_PORT=18888\nOPENCLAW_GATEWAY_TOKEN=synthetic-gateway-token\n`;
  await writeFile(join(root, ".env"), "OC_TARGET_LOCATION=local\n");
  const defaultContext = await createContext({ settings: () => ({ OC_DATA_DIR: join(root, "data"), OPENCLAW_GATEWAY_PORT: "19999" }) });
  assert.equal(defaultContext.settings.dataDir, join(root, "data"));
  assert.equal(defaultContext.settings.gatewayPort, "19999");
  await writeFile(join(root, ".env"), explicitEnv);
  await assert.rejects(createContext({ settings: () => ({ "INVALID NAME": "value" }) }), /invalid application setting name/);

  // Invalid settings fail while the context is being built, before command code runs.
  let actionRan = false;
  await assert.rejects(
    runApp({
      ...app,
      settings: () => ({ BROKEN: 42 } as unknown as Record<string, string>),
      commands: { check: { summary: "check", run: async () => { actionRan = true; } } },
    }, ["check"]),
    /application setting BROKEN must be a string/,
  );
  assert.equal(actionRan, false);

  // A required application secret blocks preflight; an available required secret and a
  // missing optional one allow the command to reach its action.
  let blockedAction = false;
  await assert.rejects(
    runApp({
      ...app,
      secrets: async () => [{ name: "MISSING_APP_SECRET", location: "target-env", usedBy: "blocked" }],
      commands: { check: { summary: "check", run: async (ctx) => { await preflightSecrets(ctx); blockedAction = true; } } },
    }, ["check"]),
    /required secret\(s\) missing/,
  );
  assert.equal(blockedAction, false);

  let allowedAction = false;
  await withOutputSink(() => {}, () => runApp({
    ...app,
    secrets: async () => [
      { name: "OPENCLAW_GATEWAY_TOKEN", location: "repo-env", usedBy: "gateway" },
      { name: "OPTIONAL_APP_SECRET", location: "target-env", usedBy: "optional", required: false },
    ],
    commands: { check: { summary: "check", run: async (ctx) => { await preflightSecrets(ctx); allowedAction = true; } } },
  }, ["check"]));
  assert.equal(allowedAction, true);

  // A later app has no access to the prior app's hooks.
  let leaked = false;
  await runApp({
    name: "plain",
    description: "plain",
    commands: { check: { summary: "check", run: async (ctx) => { leaked = ctx.applicationSecrets !== undefined; } } },
  }, ["check"]);
  assert.equal(leaked, false);

  const duplicateContext = {
    applicationSecrets: async () => [
      { name: "DUPLICATE_SECRET", location: "target-env" as const, usedBy: "optional", required: false },
      { name: "DUPLICATE_SECRET", location: "target-env" as const, usedBy: "required" },
    ],
  } as unknown as import("#framework/core/context.ts").Context;
  const duplicates = await requirementsForConfig(duplicateContext, {});
  assert.equal(duplicates.find((entry) => entry.name === "DUPLICATE_SECRET")?.required, true);
  const conflicting = {
    applicationSecrets: async () => [
      { name: "CONFLICTING_SECRET", location: "repo-env" as const, usedBy: "repo" },
      { name: "CONFLICTING_SECRET", location: "target-env" as const, usedBy: "target" },
    ],
  } as unknown as import("#framework/core/context.ts").Context;
  await assert.rejects(requirementsForConfig(conflicting, {}), /conflicts with an existing/);

  // Applying a store includes application-owned target keys and never writes a literal
  // `undefined` for an absent optional key.
  await mkdir(join(root, "secrets"), { recursive: true });
  await writeFile(join(root, "config", "desired-state.json"), "[]");
  await writeFile(join(root, "secrets", "local.env"), "APP_SECRET=from-store\n");
  const memory = new MemoryTransport();
  const dataDir = "/fixture/app-data";
  memory.files.set(`${dataDir}/config/openclaw.json`, "{}");
  memory.files.set(`${dataDir}/config/.env`, "OLD_SECRET=old\n");
  const applyContext = {
    settings: { dataDir, env: {} },
    runtime: { async isRunning(): Promise<boolean> { return false; } },
    transport: memory,
    applicationSecrets: async () => [
      { name: "APP_SECRET", location: "target-env" as const, usedBy: "fixture" },
      { name: "OPTIONAL_MISSING", location: "target-env" as const, usedBy: "fixture", required: false },
    ],
  } as unknown as import("#framework/core/context.ts").Context;
  await secretsCommand(applyContext, ["--apply", "--store", "local"]);
  const applied = await memory.readFile(`${dataDir}/config/.env`);
  assert.equal(applied, "APP_SECRET=from-store\n");

  // The MCP entry point receives the same hooks and dispatches a real command with them.
  const moduleUrl = (name: string) => new URL(`../../../../packages/clawwright/${name}.ts`, import.meta.url).href;
  const mcpScript = `
    const { serveMcp } = await import(${JSON.stringify(moduleUrl("integration/mcp/server"))});
    const { useDeployment } = await import(${JSON.stringify(moduleUrl("runtime/deployment"))});
    const { requirements } = await import(${JSON.stringify(moduleUrl("service/secrets"))});
    const { emit } = await import(${JSON.stringify(moduleUrl("core/io/output"))});
    useDeployment(${JSON.stringify(root)});
    let settingsCalls = 0;
    let secretsCalls = 0;
    await serveMcp({
      name: "mcp-hooks",
      description: "mcp hook fixture",
      settings: () => { settingsCalls += 1; return { MCP_APP_MODE: "mcp" }; },
      secrets: async () => { secretsCalls += 1; return [{ name: "MCP_APP_SECRET", location: "target-env", usedBy: "mcp" }]; },
      commands: {
        probe: {
          summary: "probe hooks",
          run: async (ctx) => emit(JSON.stringify({ mode: ctx.settings.env.MCP_APP_MODE, names: (await requirements(ctx)).map((entry) => entry.name), settingsCalls, secretsCalls })),
        },
      },
    });
  `;
  const mcp = await spawnLocal(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", mcpScript], {
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "probe", arguments: {} } })}\n`,
    timeoutMs: CHILD_NODE_DEADLINE_MS,
  });
  assert.equal(mcp.code, 0);
  const mcpResponse = JSON.parse(mcp.stdout.trim()) as { result: { content: [{ text: string }] } };
  assert.deepEqual(JSON.parse(mcpResponse.result.content[0].text), {
    mode: "mcp",
    names: ["MCP_APP_SECRET"],
    settingsCalls: 1,
    secretsCalls: 1,
  });
} finally {
  if (previousDeployment === undefined) {
    // The check runner normally starts with a deployment selected by the gate.
  } else {
    useDeployment(previousDeployment);
  }
  await rm(root, { recursive: true, force: true });
}

process.stderr.write("all application hook checks passed\n");

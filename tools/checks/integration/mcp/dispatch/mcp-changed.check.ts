import { check, finish, isolatedAppsRoot } from "#checks/kit/harness.ts";
import { createDeploymentFixture, stageTally } from "#checks/kit/deployment-fixture.ts";
import { runProcess } from "#checks/kit/spawn.ts";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Stage } from "#framework/core/command/execute.ts";
import { buildChangedInventory, runChangedInventory } from "#checks/integration/mcp/dispatch/changed-inventory.ts";
import { monorepoRoot } from "#framework/core/env.ts";

const childApps = await isolatedAppsRoot("mcp-changed-child");
const fixture = await createDeploymentFixture();
const tally = stageTally();
// Resolve against the monorepo root, not process.cwd(): the check is invoked from tools/,
// where cwd-relative "tools/..." would double the segment and the child's imports would
// fail with ERR_MODULE_NOT_FOUND before any PIPELINE_STAGE line.
const moduleUrl = (name: string): string => pathToFileURL(join(monorepoRoot, "packages", "clawwright", name)).href;
const script = (root: string): string => `
  const { serveMcp } = await import(${JSON.stringify(moduleUrl("integration/mcp/server.ts"))});
  const { useDeployment } = await import(${JSON.stringify(moduleUrl("runtime/deployment.ts"))});
  const { defineApp } = await import(${JSON.stringify(moduleUrl("core/app.ts"))});
  const { commandBody, materializeCommands } = await import(${JSON.stringify(moduleUrl("core/command/spec.ts"))});
  const { emit } = await import(${JSON.stringify(moduleUrl("core/io/output.ts"))});
  const { UserError } = await import(${JSON.stringify(moduleUrl("core/io/log.ts"))});
  await useDeployment(${JSON.stringify(root)});  const mode = process.env.CASE_MODE;
  const body = (effect) => commandBody({
    effect, arguments: [], needs: "target",
    preparesEnvironment: mode.startsWith("environment"),
    ...(mode === "prepare" ? { prepare: async () => { throw new UserError("prepare refusal"); } } : {}),
    run: async () => {
      emit(JSON.stringify({ changed: effect !== "read" }));
      if (mode === "run") throw new Error("interrupted run");
    },
  });
  const commands = materializeCommands({
    destroy: { summary: "fixture destroy", group: "change", structured: true, ...body("destroy") },
    change: { summary: "fixture change", group: "change", structured: true, ...body("change") },
    read: { summary: "fixture read", group: "check", structured: true, ...body("read") },
  });
  const settings = mode === "environment" || mode === "environment-no-write" ? () => { throw new UserError(mode === "environment-no-write" ? "settings refusal no write" : "settings refusal"); } : undefined;
  const app = defineApp({ name: "fixture", description: "MCP changed fixture", commands, settings });
  const serve = () => serveMcp(app, [], [], {
    observe: (stage) => process.stderr.write("PIPELINE_STAGE " + stage + "\\n"),
    transport: new Proxy({}, { get: (_target, method) => (...args) => { process.stderr.write("TRANSPORT_CONTACT " + String(method) + "\\n"); throw new Error("fixture transport refusal"); } }),
  });
  // environment-partial: the renamer double lands the new token content, then throws a non-
  // transient EACCES — the same double the in-process environment case uses — so provisioning
  // marks the error and the envelope reports changed: true.
  if (mode === "environment-partial") {
    const { withPrivateFileRenamer } = await import(${JSON.stringify(moduleUrl("security/privacy/private-file.ts"))});
    const { rename } = await import("node:fs/promises");
    await withPrivateFileRenamer(async (from, to) => {
      await rename(from, to);
      const failure = new Error("simulated rename contention");
      failure.code = "EACCES";
      throw failure;
    }, serve);
  } else await serve();
`;

try {
  const inventory = buildChangedInventory();
  check("changed inventory has mutating units", inventory.length > 0, true);
  await runChangedInventory({ fixture, tally });
  const scenarios: readonly { label: string; mode: string; call: { name: string; arguments: Record<string, unknown> }; expected: Stage; changed?: boolean; bare: boolean }[] = [
    { label: "parse bare unknown named field", mode: "safe", call: { name: "change", arguments: { __unknown: "x" } }, expected: "parse", bare: true },
    { label: "destroy confirmation refusal", mode: "safe", call: { name: "destroy", arguments: {} }, expected: "confirm", bare: true },
    { label: "prepare refusal", mode: "prepare", call: { name: "change", arguments: {} }, expected: "prepare", changed: false, bare: false },
    { label: "environment refusal, env unreadable (directory)", mode: "environment-fail", call: { name: "change", arguments: {} }, expected: "environment", changed: false, bare: false },
    { label: "environment partial write after landed rename", mode: "environment-partial", call: { name: "change", arguments: {} }, expected: "environment", changed: true, bare: false },
    { label: "context refusal without environment write", mode: "environment-no-write", call: { name: "change", arguments: {} }, expected: "context", changed: false, bare: false },
    { label: "context refusal after environment token write", mode: "environment", call: { name: "change", arguments: {} }, expected: "context", changed: true, bare: false },
    { label: "safe mutating run", mode: "safe", call: { name: "change", arguments: { confirm: true } }, expected: "run", changed: true, bare: false },
    { label: "read run", mode: "safe", call: { name: "read", arguments: {} }, expected: "run", changed: false, bare: false },
    { label: "interrupted mutating run", mode: "run", call: { name: "change", arguments: { confirm: true } }, expected: "run", changed: true, bare: false },
  ];
  // All scenarios share the same baseline env-file content; the preamble fixture supplies it
  // once, and each concurrent scenario gets its own deployment fixture to mutate safely.
  const originalEnv = await readFile(join(fixture.root, ".env"), "utf8");
  const runScenario = async (scenario: (typeof scenarios)[number]): Promise<void> => {
    const scenarioFixture = await createDeploymentFixture();
    try {
      const envPath = join(scenarioFixture.root, ".env");
      await rm(envPath, { recursive: true });
      await writeFile(envPath, originalEnv, "utf8");
      if (scenario.mode === "environment" || scenario.mode === "environment-partial") {
        const withoutToken = originalEnv.replace(/^OPENCLAW_GATEWAY_TOKEN=.*\n/m, "");
        await writeFile(envPath, withoutToken, "utf8");
      }
      if (scenario.mode === "environment-fail") {
        // The .env is replaced by a DIRECTORY of the same name before the child spawns: protect/
        // createPrivateFile fail and the pipeline refuses at the environment stage.
        await rm(envPath);
        await mkdir(envPath);
      }
      if (scenario.mode !== "environment-fail") {
        const expectedToken = scenario.mode !== "environment" && scenario.mode !== "environment-partial";
        const envBefore = await readFile(envPath, "utf8");
        check(`${scenario.label}: token setup is independent`, envBefore.includes("OPENCLAW_GATEWAY_TOKEN="), expectedToken);
      }
      const mode = scenario.mode;
      const result = await runProcess(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script(scenarioFixture.root)], {
        cwd: childApps.root, env: { ...process.env, CASE_MODE: mode },
        input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: scenario.call })}\n`, timeoutMs: 60_000,
      });
      const stageLine = new RegExp("PIPELINE_STAGE (parse|confirm|prepare|environment|context|run)", "g");
      const observed = result.stderr.match(stageLine)?.map((entry) => entry.slice("PIPELINE_STAGE ".length)) ?? [];
      const responses = result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
      const resultBody = responses.find((response) => response.id === 1)?.result as Record<string, unknown> | undefined;
      const bare = resultBody !== undefined && typeof resultBody.isError === "boolean" && !("structuredContent" in resultBody) && !("structured" in resultBody);
      check(`${scenario.label}: stdio server exits successfully`, result.code, 0);
      check(`${scenario.label}: actual stage observed`, observed.at(-1), scenario.expected);
      const payload = resultBody?.structuredContent as Record<string, unknown> | undefined;
      const actualChanged = payload?.changed ?? resultBody?.changed;
      check(`${scenario.label}: changed envelope present as expected`, typeof actualChanged === "boolean", scenario.changed !== undefined);
      if (scenario.changed !== undefined) check(`${scenario.label}: literal changed value`, actualChanged, scenario.changed);
      check(`${scenario.label}: refusal envelope is bare as expected`, bare, scenario.bare);
      check(`${scenario.label}: recording transport untouched`, result.stderr.includes("TRANSPORT_CONTACT"), false);
      tally.case(scenario.label, observed.at(-1) as Stage | undefined ?? "parse", result.code === 0 ? undefined : new Error(result.stderr));
      if (scenario.mode === "environment-fail") {
        // Restore the file form before the fixture is disposed below.
        await rm(envPath, { recursive: true });
        await writeFile(envPath, originalEnv, "utf8");
      }
    } finally {
      await scenarioFixture.dispose();
    }
  };
  // Simple worker pool: scenarios are independent, so run up to 4 children concurrently.
  const CONCURRENCY = 4;
  const queue = [...scenarios];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) await runScenario(next);
  });
  await Promise.all(workers);
  check("fixture env is isolated in OS temp", originalEnv.includes(fixture.root), true);
} finally {
  tally.print("mcp-changed");
  await fixture.dispose();
  await childApps.dispose();
}
finish("mcp-changed");

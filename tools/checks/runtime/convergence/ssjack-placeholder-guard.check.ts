import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { orchestrationCommands } from "#framework/commands/interface/groups/openclawCommands.orchestration.ts";
import { clearDeployment, useDeployment } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { INVALID_SSJACK_REFERENCE, SSJACK_DELIVERY_UNAVAILABLE } from "#framework/core/values/ssjack-secret-refs.ts";
import type { Context } from "#framework/core/context.ts";

const deployment = await mkdtemp(join(tmpdir(), "clawwright-ssjack-preflight-"));
const placeholder = { $ssjack: {
  format: "ssjack-secret-ref-v1", store_id: "11".repeat(16), object_id: "22".repeat(16),
  version_id: "33".repeat(16), snapshot_id: "44".repeat(16),
} };
try {
  await mkdir(resolve(deployment, "config"), { recursive: true });
  useDeployment(deployment);
  const declared = resolve(deployment, "config", "desired-state.json");
  let writes = 0;
  let removals = 0;
  let runtimeCalls = 0;
  let configReads = 0;
  let readinessCalls = 0;
  const output: string[] = [];
  const ctx = {
    settings: { dataDir: "/synthetic-clawwright" },
    transport: {
      async exists(path: string): Promise<boolean> { return path.endsWith("openclaw.json"); },
      async readFile(path: string): Promise<string> {
        configReads++;
        if (path.endsWith("openclaw.json")) return JSON.stringify({ gateway: { mode: "remote" } });
        const error = new Error("synthetic missing metadata");
        (error as NodeJS.ErrnoException).code = "ENOENT";
        throw error;
      },
      async writeFile(): Promise<void> { writes++; },
      async remove(): Promise<void> { removals++; },
    },
    paths: { toContainer: (path: string): string => path },
    runtime: {
      async isRunning(): Promise<boolean> { readinessCalls++; return true; },
      async runOneOff(): Promise<{ code: number; stdout: string; stderr: string }> {
        runtimeCalls++;
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;

  for (const [name, value, expected] of [
    ["valid", placeholder, SSJACK_DELIVERY_UNAVAILABLE],
    ["malformed", { $ssjack: { ...placeholder.$ssjack, secret_value: "synthetic-sensitive-marker" } }, INVALID_SSJACK_REFERENCE],
  ] as const) {
    const raw = JSON.stringify([{ path: "gateway.auth.token", value }]);
    await writeFile(declared, raw);
    let failure = "accepted";
    await withOutputSink((chunk) => output.push(chunk), async () => {
      try { await orchestrationCommands["apply-config"].run(ctx, ["--dry-run"]); }
      catch (error) { failure = error instanceof Error ? error.message : "non-error"; }
    });
    check(`${name} managed marker is refused at the real config command`, failure, expected);
    check(`${name} refusal performs no patch, cleanup, runtime or live-value reads`, { writes, removals, runtimeCalls, configReads }, { writes: 0, removals: 0, runtimeCalls: 0, configReads: 0 });
    check(`${name} reference-only declaration remains unchanged`, await readFile(declared, "utf8"), raw);
  }
  checkTrue("the command really reached its runtime-readiness boundary", readinessCalls === 2);
  checkTrue("refusal output never echoes a supplied value", !output.join("").includes("synthetic-sensitive-marker"));

  await writeFile(declared, JSON.stringify([{ path: "gateway.mode", value: "local" }]));
  await withOutputSink(() => {}, async () => orchestrationCommands["apply-config"].run(ctx, ["--dry-run"]));
  check("the ordinary standalone control still stages and invokes its native runtime", { writes, runtimeCalls, removals }, { writes: 1, runtimeCalls: 1, removals: 1 });
} finally {
  clearDeployment();
  await rm(deployment, { recursive: true, force: true });
}
finish("ssjack placeholder config guard");

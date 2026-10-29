// Shared by the set-build checks: a real temporary deployment for `set build` to collect, and a
// context whose transport and runtime THROW on any use — a set must build with no running
// instance and no reachable target, and a stub that politely answers would let that rule erode
// silently. Each check file runs as its own process, so nothing here is shared state.

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { spawnLocal } from "#framework/runtime/transport/transport.ts";
import type { Context } from "#framework/core/context.ts";
/** Every string anywhere in a value, however deep. */
export function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(stringsOf);
  return [];
}
function refuse(what: string): () => never {
  return () => {
    throw new Error(`set build used the target ${what} — a set must build with no instance and no reachable target`);
  };
}

export const ctx = {
  settings: { image: "ghcr.io/openclaw/openclaw:extended-stable" },
  transport: new Proxy({}, { get: (_target, property) => refuse(`transport.${String(property)}`) }),
  runtime: new Proxy({}, { get: (_target, property) => refuse(`runtime.${String(property)}`) }),
} as unknown as Context;

// Values that exist only on this fake machine. They must never appear in a manifest — and
// the assertions below also prove the guard itself can fire when one does.
export const TOKEN = "tok-live-example-1234567890";
export const STORE_KEY = "sk-demo-9999-not-a-real-key";
export const DIGEST = `ghcr.io/openclaw/openclaw@sha256:${"3".repeat(64)}`;
/** Writes the example deployment and selects it. Pair with removeBuildDeployment(). */
export async function createBuildDeployment(): Promise<string> {
  const deployment = await mkdtemp(join(tmpdir(), "clawwright-set-build-check-"));
  await populateBuildDeployment(deployment);
  return deployment;
}

/** Populate and select a caller-owned temporary deployment. */
export async function populateBuildDeployment(deployment: string): Promise<void> {
  await mkdir(resolve(deployment, "config"), { recursive: true });
  await mkdir(resolve(deployment, "recipes", "demo", "agent"), { recursive: true });
  await mkdir(resolve(deployment, "recipes", "demo", "data"), { recursive: true });
  await mkdir(resolve(deployment, "recipes", "plain"), { recursive: true });
  await mkdir(resolve(deployment, "secrets"), { recursive: true });

  await writeFile(
    resolve(deployment, "config", "desired-state.json"),
    JSON.stringify([
      { path: "gateway.mode", value: "local" },
      // The SecretRef the set's secret names are derived from: it travels in the set,
      // unlike the live openclaw.json on a target.
      { path: "gateway.auth.token", value: { source: "env", id: "OPENCLAW_GATEWAY_TOKEN" } },
    ]),
  );
  await writeFile(resolve(deployment, ".env"), `OPENCLAW_GATEWAY_TOKEN=${TOKEN}\nOTHER_SETTING=some-value\n`);
  await writeFile(resolve(deployment, "secrets", "prod.env"), `ZAI_API_KEY=${STORE_KEY}\n`);
  // The digest the build pins, written through the same file `./clawwright lock` writes, so the
  // fixture and the command cannot disagree about where the digest lives.
  await writeFile(
    resolve(deployment, "config", "deployment.lock.json"),
    JSON.stringify({
      version: 1,
      deployment: "set-build-check",
      generatedAt: "2026-01-01T00:00:00.000Z",
      image: { reference: "ghcr.io/openclaw/openclaw:extended-stable", digest: DIGEST },
      recipes: {},
      secrets: [],
    }),
  );

  // demo: a full recipe — served content, an agent bundle with a cron schedule, acceptance checks.
  await writeFile(resolve(deployment, "recipes", "demo", "recipe.json"), JSON.stringify({ description: "example recipe" }));
  await writeFile(resolve(deployment, "recipes", "demo", "compose.yml"), "services: {}\n");
  await writeFile(resolve(deployment, "recipes", "demo", "server.ts"), "// example mcp server\n");
  await writeFile(resolve(deployment, "recipes", "demo", "data", "page.md"), "# example page\n");
  await writeFile(
    resolve(deployment, "recipes", "demo", "agent", "config.json"),
    JSON.stringify({ agentId: "demo-agent", mcpServerName: "demo-mcp", cronJobName: "demo-refresh", cronSchedule: "17 3 * * *" }),
  );
  await writeFile(resolve(deployment, "recipes", "demo", "agent", "AGENTS.md"), "# the agent's instructions\n");
  await writeFile(
    resolve(deployment, "recipes", "demo", "acceptance.json"),
    JSON.stringify({
      checks: [{ kind: "mcp_responds" }, { kind: "agent_answers", usesModel: true, agent: "demo-agent", message: "hello" }],
    }),
  );
  // plain: a service with no agent bundle and no acceptance checks.
  await writeFile(resolve(deployment, "recipes", "plain", "recipe.json"), JSON.stringify({ description: "plain service" }));
  await writeFile(resolve(deployment, "recipes", "plain", "compose.yml"), "services: {}\n");

  useDeployment(deployment);
}

export async function removeBuildDeployment(deployment: string): Promise<void> {
  await rm(deployment, { recursive: true, force: true });
  // The active deployment is process-wide and the checks share one process: leave it where
  // the other check files expect to find it rather than pointing at a directory just deleted.
  useDeployment(resolve(monorepoRoot, "apps", "example app"));
}

// On Windows some tars (GNU tar from Git) read the drive letter in an absolute path as a
// remote host spec; --force-local stops that, but tars that know drive letters reject the
// flag, so try the flagged form and fall back to the plain one.
export async function tarList(path: string): Promise<string> {
  let result = await spawnLocal("tar", process.platform === "win32" ? ["--force-local", "-tzf", path] : ["-tzf", path], { allowFailure: true });
  if (result.code !== 0) result = await spawnLocal("tar", ["-tzf", path]);
  return result.stdout;
}

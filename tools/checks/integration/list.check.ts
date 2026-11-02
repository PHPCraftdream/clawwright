// `./clawwright list` — packages/clawwright/integration/list.ts's listDeployments().
//
// A scratch apps/ this file builds and owns, never the real one: several fixtures, one
// broken in each of the ways a real deployment can be, all read through the one function
// `./clawwright list` calls, with the target query stubbed rather than touching Docker.

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, basename } from "node:path";
import { listDeployments } from "#framework/integration/list.ts";
import { deploymentNames } from "#framework/integration/deployment/names.ts";
import { soleDeploymentFallback } from "#framework/integration/gate.ts";
import { useDeployment, selectedDeployment } from "#framework/runtime/deployment.ts";
import { NotBootstrapped } from "#framework/runtime/runtime.ts";
import type { Context } from "#framework/core/context.ts";
import type { AppDefinition } from "#framework/core/app.ts";
import { check, finish } from "#checks/kit/harness.ts";

const root = await mkdtemp(join(tmpdir(), "clawwright-list-check-"));

const FIXTURE_APP =
  'export default { name: "fixture", description: "fixture", service: { name: "gateway" }, ' +
  'commands: { noop: { summary: "noop", run: async () => {} } } };\n';

async function writeDeployment(name: string, env: string | undefined, app = FIXTURE_APP): Promise<void> {
  const directory = resolve(root, name);
  await mkdir(directory, { recursive: true });
  if (env !== undefined) await writeFile(resolve(directory, ".env"), env, "utf8");
  await writeFile(resolve(directory, "app.ts"), app, "utf8");
}

await writeDeployment(
  "healthy",
  "OC_DATA_DIR=/srv/healthy/data\nOC_TARGET_LOCATION=local\nOPENCLAW_GATEWAY_PORT=18001\n" +
    "OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:extended-stable@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
);
await writeDeployment(
  "auto-target",
  "OC_DATA_DIR=/srv/autotarget/data\nOPENCLAW_GATEWAY_PORT=18006\n" +
    "OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:extended-stable\n",
);
await writeDeployment(
  "unpinned",
  "OC_DATA_DIR=/srv/unpinned/data\nOC_TARGET_LOCATION=ssh\nOC_SSH_HOST=user@example.com\n" +
    "OPENCLAW_GATEWAY_PORT=18002\nOPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:extended-stable\n",
);
await writeDeployment(
  "bad-digest",
  "OC_DATA_DIR=/srv/baddigest/data\nOC_TARGET_LOCATION=local\nOPENCLAW_GATEWAY_PORT=18007\n" +
    "OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:extended-stable@sha256:zz\n",
);
await writeDeployment(
  "not-bootstrapped",
  "OC_DATA_DIR=/srv/notboot/data\nOC_TARGET_LOCATION=local\nOPENCLAW_GATEWAY_PORT=18003\n" +
    "OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:extended-stable@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n",
);
await writeDeployment(
  "conn-error",
  "OC_DATA_DIR=/srv/connerr/data\nOC_TARGET_LOCATION=local\nOPENCLAW_GATEWAY_PORT=18004\n" +
    "OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:extended-stable\n",
);
await writeDeployment(
  "broken-app",
  "OC_DATA_DIR=/srv/brokenapp/data\nOC_TARGET_LOCATION=local\nOPENCLAW_GATEWAY_PORT=18005\n" +
    "OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:extended-stable\n",
  'throw new Error("fixture: intentionally broken");\n',
);
await writeDeployment("no-env", undefined); // app.ts but no .env at all
// A .env that exists but does not parse: the refusal must reach the caller as the
// parse error (file + line), never as the missing-.env advice.
await writeDeployment(
  "bad-env",
  "OC_DATA_DIR=/srv/badenv/data\nOPENCLAW_GATEWAY_PORT=18099\nBROKEN LINE WITHOUT EQUALS\n",
);
await mkdir(resolve(root, "empty-dir"), { recursive: true });
await mkdir(resolve(root, ".hidden"), { recursive: true });
await writeDeployment("Bad_Name", undefined);

function stubContext(isRunning: () => Promise<boolean>, transportDescription: string): Context {
  return { runtime: { isRunning }, transport: { description: transportDescription } } as unknown as Context;
}

async function buildContext(_app: AppDefinition, directory: string): Promise<Context> {
  // Mirrors the production default (defaultBuildContext in scaffold.ts), which also switches
  // this same global per deployment — the restore assertion below only means anything if this
  // stub actually exercises that switch too.
  useDeployment(directory);
  const name = basename(directory);
  if (name === "healthy") return stubContext(async () => true, "local");
  if (name === "auto-target") return stubContext(async () => true, "wsl:Ubuntu-24.04");
  if (name === "unpinned") return stubContext(async () => false, "ssh:user@example.com");
  if (name === "bad-digest") return stubContext(async () => false, "local");
  if (name === "not-bootstrapped") {
    return stubContext(async () => {
      throw new NotBootstrapped("/srv/notboot/data");
    }, "local");
  }
  if (name === "conn-error") {
    return stubContext(async () => {
      throw new Error("connection refused");
    }, "local");
  }
  throw new Error(`unexpected buildContext call for ${name}`);
}

const sentinel = resolve(root, "sentinel-deployment");
useDeployment(sentinel);

const summaries = await listDeployments({ appsRoot: root, buildContext });
const byName = new Map(summaries.map((entry) => [entry.name, entry]));

check("every fixture directory gets a row", [...byName.keys()].sort(), [
  "auto-target",
  "bad-digest",
  "bad-env",
  "broken-app",
  "conn-error",
  "healthy",
  "no-env",
  "not-bootstrapped",
  "unpinned",
]);

check("a running deployment reports running, with its config", byName.get("healthy"), {
  name: "healthy",
  target: "local",
  port: "18001",
  image: "ghcr.io/openclaw/openclaw:extended-stable@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  pinned: true,
  state: "running",
});

check("an auto target resolves to the context's actual transport once checked", byName.get("auto-target"), {
  name: "auto-target",
  target: "wsl:Ubuntu-24.04",
  port: "18006",
  image: "ghcr.io/openclaw/openclaw:extended-stable",
  pinned: false,
  state: "running",
});

check("a stopped ssh deployment names its host and an unpinned tag", byName.get("unpinned"), {
  name: "unpinned",
  target: "ssh:user@example.com",
  port: "18002",
  image: "ghcr.io/openclaw/openclaw:extended-stable",
  pinned: false,
  state: "stopped",
});

check("a malformed digest is not a pin", byName.get("bad-digest")?.pinned, false);

check("NotBootstrapped becomes its own state, not a generic error", byName.get("not-bootstrapped"), {
  name: "not-bootstrapped",
  target: "local",
  port: "18003",
  image: "ghcr.io/openclaw/openclaw:extended-stable@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  pinned: true,
  state: "not-bootstrapped",
});

const connError = byName.get("conn-error");
check("an unreachable target is an error row, not a thrown exception", connError?.state, "error");
check("its reason names the actual failure", connError?.reason?.includes("connection refused"), true);
check("its configuration is still shown despite the failed status check", connError?.port, "18004");
check("its target is still resolved from context, even on a failed status check", connError?.target, "local");

const brokenApp = byName.get("broken-app");
check("a broken app.ts is an error row, not a thrown exception", brokenApp?.state, "error");
check("its reason says app.ts specifically", brokenApp?.reason?.includes("app.ts"), true);
check("its reason carries the underlying message", brokenApp?.reason?.includes("intentionally broken"), true);
check("its configuration is still shown despite the broken app.ts", brokenApp?.port, "18005");

check("a missing .env is an error row, not a thrown exception", byName.get("no-env"), {
  name: "no-env",
  state: "error",
  reason: "no .env — run ./clawwright --app no-env bootstrap",
});

const badEnv = byName.get("bad-env");
check("a malformed .env is an error row, not a thrown exception", badEnv?.state, "error");
check("its reason names the fixture's .env path", badEnv?.reason?.includes(resolve(root, "bad-env", ".env")), true);
check("its reason is the parse refusal, not the missing-.env advice", badEnv?.reason?.includes("bootstrap"), false);
check("the row carries the structured parse refusal", badEnv?.envError, { code: "ENV_LINE_WITHOUT_EQUALS", line: 3 });

check(
  "the active-deployment global is restored to what it was before list ran",
  selectedDeployment(),
  sentinel,
);

// --- --no-status: configuration only, no target queried, no app.ts even loaded -------------

let contextBuilds = 0;
const unchecked = await listDeployments({
  appsRoot: root,
  checkStatus: false,
  buildContext: async (app, directory) => {
    contextBuilds += 1;
    return buildContext(app, directory);
  },
});

check("--no-status builds no context at all", contextBuilds, 0);
check(
  "--no-status still reports configuration, with state unchecked",
  unchecked.find((entry) => entry.name === "healthy"),
  {
    name: "healthy",
    target: "local",
    port: "18001",
    image: "ghcr.io/openclaw/openclaw:extended-stable@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    pinned: true,
    state: "unchecked",
  },
);
check(
  "--no-status leaves a broken app.ts unread — nothing calls it",
  unchecked.find((entry) => entry.name === "broken-app")?.state,
  "unchecked",
);
check(
  "--no-status flags an unresolved auto target instead of showing it bare",
  unchecked.find((entry) => entry.name === "auto-target"),
  {
    name: "auto-target",
    target: "auto (not resolved)",
    port: "18006",
    image: "ghcr.io/openclaw/openclaw:extended-stable",
    pinned: false,
    state: "unchecked",
  },
);

// --- only directories with app.ts and a valid name are deployments ------------------------

check("an empty, a hidden and an invalid-name directory are not deployments", await deploymentNames(root), [
  "auto-target", "bad-digest", "bad-env", "broken-app", "conn-error", "healthy", "no-env", "not-bootstrapped", "unpinned",
]);
const withOthers = await listDeployments({ appsRoot: root, checkStatus: false, includeOthers: true });
check(
  "list can show the others, one line each",
  withOthers.filter((entry) => entry.state === "error" && entry.reason?.startsWith("not a deployment")).map((entry) => [entry.name, entry.reason]),
  [
    ["Bad_Name", "not a deployment: invalid deployment name \"Bad_Name\" — use lowercase letters, digits and dashes, starting with a letter"],
    ["empty-dir", "not a deployment: no app.ts"],
  ],
);
const soleRoot = resolve(root, "sole-root");
await mkdir(resolve(soleRoot, "x"), { recursive: true });
await mkdir(resolve(soleRoot, ".x"), { recursive: true });
check("empty and hidden directories alone leave no sole deployment", soleDeploymentFallback(false, await deploymentNames(soleRoot)), undefined);
await mkdir(resolve(soleRoot, "real"), { recursive: true });
await writeFile(resolve(soleRoot, "real", "app.ts"), FIXTURE_APP, "utf8");
check("beside them the one real deployment is still the sole one", soleDeploymentFallback(false, await deploymentNames(soleRoot)), "real");

// --- an apps/ directory that does not exist at all: an empty list, not a crash -------------

check(
  "a nonexistent apps root is an empty list",
  await listDeployments({ appsRoot: resolve(root, "does-not-exist") }),
  [],
);

await rm(root, { recursive: true, force: true });

finish("deployment-list");

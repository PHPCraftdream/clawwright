// `./clawwright bootstrap` — the provider is configured AFTER declared settings are applied,
// never before.
//
// Confirmed against OpenClaw's real config schema (github.com/openclaw/openclaw
// src/config/zod-schema.core.ts): a provider id that is not one of OpenClaw's built-in
// overlays must have baseUrl (and a models array) present, or the write is rejected. For a
// brand-new custom provider those come from config/desired-state.json, applied by
// applyConfig; configureProvider only ever writes models.providers.<id>.apiKey. Configuring
// the provider first leaves that provider's entry with just an apiKey and no baseUrl — an
// incomplete provider object OpenClaw's own `config set` refuses — which stopped bootstrap
// before applyConfig ever ran. Built-in providers are exempt from that rule, which is why
// this defect was invisible against them.
//
// A live OpenClaw instance is what actually proves the schema requirement; this check
// proves the narrower, still real thing that regresses silently otherwise — that bootstrap
// asks for these two steps in the order that requirement demands, recorded through the same
// runtime.runOneOff seam every other command in this codebase is checked through.

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { useDeployment, deploymentDir } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";

const DATA_DIR = "/srv/openclaw/data";
const CONFIG_PATH = `${DATA_DIR}/config/openclaw.json`;
const TARGET_ENV_PATH = `${DATA_DIR}/config/.env`;

// A genuinely new custom provider: not one of OpenClaw's built-in overlays, and its entry
// carries nothing yet — exactly the shape whose apiKey-only write the real schema refuses
// until baseUrl exists too.
const LIVE_CONFIG = { models: { providers: { custom: {} } } };

const deployment = await mkdtemp(join(tmpdir(), "oc-bootstrap-order-check-"));
try {
  await mkdir(resolve(deployment, "config"), { recursive: true });
  await writeFile(
    resolve(deployment, "config", "desired-state.json"),
    JSON.stringify([
      { path: "models.providers.custom.baseUrl", value: "http://localhost:11434/v1" },
      { path: "models.providers.custom.models", value: [{ id: "local-model" }] },
    ]),
  );
  useDeployment(deployment);

  const calls: { kind: string; args: string[] }[] = [];
  let conflictingContainer: string | undefined;
  const ctx = {
    settings: {
      dataDir: DATA_DIR,
      env: { OPENCLAW_GATEWAY_TOKEN: "test-token" },
      image: "ghcr.io/openclaw/openclaw:extended-stable",
      bindAddress: "127.0.0.1",
      gatewayPort: "18789",
      serviceUrl: "http://127.0.0.1:18789",
    },
    transport: {
      description: "stub",
      async exists(path: string): Promise<boolean> {
        // No declaration record yet: the first apply on this data directory.
        return path !== `${DATA_DIR}/clawwright-declared.json`;
      },
      async readFile(path: string): Promise<string> {
        if (path === CONFIG_PATH) return JSON.stringify(LIVE_CONFIG);
        if (path === TARGET_ENV_PATH) return "CUSTOM_API_KEY=secret-value\n";
        if (path === `${DATA_DIR}/clawwright-declared.json`) { const error = new Error("missing"); (error as NodeJS.ErrnoException).code = "ENOENT"; throw error; }
        return "";
      },
      async writeFile(): Promise<void> {},
      async remove(): Promise<void> {},
      async mkdirp(): Promise<void> {},
      async exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
        // Not a symlink — ensureDataDirs' root guard checks this first, and the
        // otherwise-unconditional "everything succeeds" stub below would misread it as one.
        if (command === "test" && args[0] === "-L") return { code: 1, stdout: "", stderr: "" };
        // The canonical-ancestry check resolves through the ancestors: no symlinks
        // here, so every path resolves to itself.
        if (command === "readlink" && args[0] === "-f") return { code: 0, stdout: `${args[1] ?? ""}\n`, stderr: "" };
        // The tree pre-exists with the right owner, so ensureDataDirs' provenance gate
        // adopts it without any ownership change.
        if (command === "stat" && args[0] === "-c" && args[1] === "%u:%g") return { code: 0, stdout: "1000:1000\n", stderr: "" };
        if (command === "stat" && args[0] === "-c" && args[1] === "%a") return { code: 0, stdout: "700\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    paths: {
      toContainer: (path: string) => path,
    },
    runtime: {
      async portConflict(): Promise<string | undefined> {
        calls.push({ kind: "port-check", args: [] });
        return conflictingContainer;
      },
      // preflightPort also checks raw listening sockets unless this
      // deployment's own gateway is already running, which it never is at bootstrap time.
      async isRunning(): Promise<boolean> {
        return false;
      },
      async pullImage(): Promise<void> {
        calls.push({ kind: "pull", args: [] });
      },
      async runOneOff(_service: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
        if (args[1] === "config" && args[2] === "patch" && args[3] === "--file") calls.push({ kind: "apply-config", args });
        else if (args[1] === "config" && typeof args[3] === "string" && args[3].startsWith("models.providers.")) {
          calls.push({ kind: "configure-provider", args });
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      async start(): Promise<void> {
        calls.push({ kind: "start", args: [] });
      },
      async waitForHealth(): Promise<void> {
        calls.push({ kind: "wait-for-health", args: [] });
      },
      async imageReference(): Promise<string | undefined> {
        return undefined;
      },
    },
  } as unknown as Context;

  await withOutputSink(() => {}, () => openclawCommands.bootstrap.run(ctx, ["--no-pull"]));

  const kinds = calls.map((call) => call.kind);
  check("port conflict is checked before pulling or mutating the instance", kinds[0], "port-check");
  check("both steps ran", kinds.includes("apply-config") && kinds.includes("configure-provider"), true);
  check(
    "declared settings are applied before the provider's apiKey is written",
    kinds.indexOf("apply-config") < kinds.indexOf("configure-provider"),
    true,
  );
  check(
    "the provider write names the new custom provider, not a built-in one",
    calls.find((call) => call.kind === "configure-provider")?.args.includes("models.providers.custom.apiKey"),
    true,
  );
  check("the start sequence still runs after both", kinds.indexOf("configure-provider") < kinds.indexOf("start"), true);

  const callsBeforeConflict = calls.length;
  conflictingContainer = "occupied-1 (compose project other)";
  let refusal = "";
  try {
    await withOutputSink(() => {}, () => openclawCommands.bootstrap.run(ctx, ["--no-pull"]));
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
  }
  check("bootstrap names an occupied target port", refusal.includes("occupied-1 (compose project other)"), true);
  check("bootstrap stops at the target port check before further work", calls.length, callsBeforeConflict + 1);
  conflictingContainer = undefined;
} finally {
  await rm(deployment, { recursive: true, force: true });
}

// --- set try: the exact same ordering requirement, at a lower cost than another full run --
//
// set try's own bring-up (packages/clawwright/commands/sets/set-try.ts) makes the identical two
// calls for the identical reason — its provider comes from the SAME desired-state.json a set
// carries. Driving it behaviourally here would mean building a real, checksum-valid set
// artifact and unpacking it just to prove a two-line reorder already proven above; that cost
// buys nothing this file's own live-instance test suite has not already paid for elsewhere.
// What this guards against is a future edit silently swapping the two calls back — a plain
// source-order check is honest about being exactly that, not a second behavioural proof.
{
  const setTrySource = await (await import("node:fs/promises")).readFile(
    new URL("../../../../../packages/clawwright/commands/sets/set-try.ts", import.meta.url),
    "utf8",
  );
  const applyAt = setTrySource.indexOf("await applyConfig(tryCtx, [], { restartAdvice: false });");
  const configureAt = setTrySource.indexOf("await configureProvider(tryCtx, []);");
  check("set try's own bring-up makes both calls", applyAt >= 0 && configureAt >= 0, true);
  check("set try applies declared settings before configuring the provider, same as bootstrap", applyAt < configureAt, true);
}

// --- a bootstrap that ends with no model provider configured says so in its final
// next steps — "OpenClaw is up" read as done, while an agent could not answer a single
// prompt until an operator noticed doctor's separate PROVIDER_MISSING finding on a LATER
// run. Read from the live config the same way collectConfiguredProviders() (secrets.ts)
// does, not guessed from which env vars happen to be set. --------------------------------
//
// A bootstrap-shaped stub distinct from the fixture above: every step succeeds
// unconditionally, and the live config `readFile` answers with exactly what each case hands
// in — the same file bootstrap re-reads after start() to decide whether to print the hint.
// `targetEnv` supplies whatever conventional provider key preflightSecrets ends up
// requiring, so each case is about the hint, never a refusal that belongs to a different
// command.
function providerHintContext(liveConfig: unknown, targetEnv = ""): Context {
  return {
    settings: {
      dataDir: DATA_DIR,
      env: { OPENCLAW_GATEWAY_TOKEN: "test-token" },
      image: "ghcr.io/openclaw/openclaw:extended-stable",
      gatewayPort: "18789",
      bindAddress: "127.0.0.1",
      serviceUrl: "http://127.0.0.1:18789",
    },
    transport: {
      description: "stub",
      async exists(path: string): Promise<boolean> {
        return path === CONFIG_PATH || path === TARGET_ENV_PATH;
      },
      async readFile(path: string): Promise<string> {
        if (path === CONFIG_PATH) return JSON.stringify(liveConfig);
        if (path === TARGET_ENV_PATH) return targetEnv;
        const error = new Error(`missing: ${path}`); (error as NodeJS.ErrnoException).code = "ENOENT"; throw error;
      },
      async writeFile(): Promise<void> {},
      async remove(): Promise<void> {},
      async mkdirp(): Promise<void> {},
      async exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
        if (command === "test" && args[0] === "-L") return { code: 1, stdout: "", stderr: "" };
        if (command === "readlink" && args[0] === "-f") return { code: 0, stdout: `${args[1] ?? ""}\n`, stderr: "" };
        if (command === "stat" && args[0] === "-c" && args[1] === "%u:%g") return { code: 0, stdout: "1000:1000\n", stderr: "" };
        if (command === "stat" && args[0] === "-c" && args[1] === "%a") return { code: 0, stdout: "700\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    paths: { toContainer: (path: string) => path },
    runtime: {
      async portConflict(): Promise<string | undefined> { return undefined; },
      async isRunning(): Promise<boolean> { return false; },
      async pullImage(): Promise<void> {},
      async runOneOff(): Promise<{ code: number; stdout: string; stderr: string }> { return { code: 0, stdout: "", stderr: "" }; },
      async start(): Promise<void> {},
      async waitForHealth(): Promise<void> {},
      async imageReference(): Promise<string | undefined> { return undefined; },
    },
  } as unknown as Context;
}

{
  const previousHint = (() => { try { return deploymentDir(); } catch { return undefined; } })();
  const hintDeployment = await mkdtemp(join(tmpdir(), "oc-bootstrap-provider-hint-check-"));
  try {
    await mkdir(resolve(hintDeployment, "config"), { recursive: true });
    await writeFile(resolve(hintDeployment, "config", "desired-state.json"), "[]");
    useDeployment(hintDeployment);

    {
      let output = "";
      await withOutputSink((chunk) => { output += chunk; }, () => openclawCommands.bootstrap.run(providerHintContext({ models: { providers: {} } }), ["--no-pull"]));
      check("no provider configured prints the configure-provider hint", output.includes("./clawwright configure-provider"), true);
      check("the hint says an agent cannot answer yet", output.includes("cannot answer"), true);
    }

    {
      let output = "";
      await withOutputSink(
        (chunk) => { output += chunk; },
        () => openclawCommands.bootstrap.run(providerHintContext({ models: { providers: { zai: { apiKey: "k" } } } }), ["--no-pull"]),
      );
      check("a configured provider prints no hint at all", output.includes("configure-provider"), false);
    }

    {
      // auth.profiles alone still counts, the same way collectConfiguredProviders() reads it
      // — this must not re-derive its own, narrower guess.
      let output = "";
      await withOutputSink(
        (chunk) => { output += chunk; },
        () => openclawCommands.bootstrap.run(providerHintContext({ models: { providers: {} }, auth: { profiles: { mine: { provider: "zai" } } } }, "ZAI_API_KEY=k\n"), ["--no-pull"]),
      );
      check("a provider named only through auth.profiles prints no hint either", output.includes("configure-provider"), false);
    }
  } finally {
    if (previousHint !== undefined) useDeployment(previousHint);
    await rm(hintDeployment, { recursive: true, force: true });
  }
}

finish("bootstrap provider-order");

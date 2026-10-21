// Regression: after `compose up`, install used to
// print "<name> is running" and call afterStart the instant `up` returned, with no check
// beyond "does a container from this project exist" — which a single live sidecar
// satisfies even while a multi-service recipe's own main service crashed. A recipe that
// declares `readiness.services` must now catch exactly that: primary down, sidecar up.
// Split out of recipe.check.ts, which outgrew the check-file line limit when this landed.

import { UserError } from "#framework/core/io/log.ts";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readName } from "#framework/core/values/names.ts";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { recipe } from "#framework/commands/management/recipe/index.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { listBrokenRecipes, loadRecipe, listRecipes, useRecipesDir } from "#framework/service/recipe.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import { DockerRuntime } from "#framework/runtime/docker/runtime-docker.ts";
import type { Settings } from "#framework/core/env.ts";
import type { PathBridge } from "#framework/core/paths.ts";
import type { Transport } from "#framework/runtime/transport/transport.ts";
import type { Stack, StackServiceState } from "#framework/runtime/runtime.ts";
import { check, finish } from "#checks/kit/harness.ts";

function readinessReport(output: string): { recipe: string; status: string; detail: string; services: Record<string, StackServiceState> } {
  const reports = output.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
  check("exactly one readiness report", reports.length, 1);
  return reports[0];
}

async function refusalOf<T>(name: string, fn: () => Promise<T>): Promise<unknown> {
  try { await fn(); } catch (error) { return error; }
  check(name, false, true);
  return undefined;
}

/** A fresh stub `ctx` whose stack() returns spies recording build/up calls, and whose transport is
 *  an in-memory filesystem with just enough shell for the instance lock: plain `mkdir` of an
 *  existing directory fails, which is the entire acquisition mechanism — `mkdir -p` and `mkdir -m`
 *  only prepare directories, `rmdir` refuses a non-empty one, and `test -d` reads it back. Copied
 *  in reduced form from recipe.check.ts's, same reasoning as recipe-hook-freshness.check.ts's copy:
 *  check files run for their side effects, and a shared fixture would make this one's passing
 *  depend on another file's. */
function stubContext(env: Record<string, string>): { ctx: Context; calls: string[] } {
  const calls: string[] = [];
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const ctx = {
    settings: { env, dataDir: "/srv/clawwright-recipe-readiness-check" },
    transport: {
      description: "stub",
      async exec(command: string, args: string[]) {
        if (command === "mkdir" && args[0] !== "-p" && args[0] !== "-m") {
          const target = args[args.length - 1];
          if (dirs.has(target)) return { code: 1, stdout: "", stderr: "File exists" };
          dirs.add(target);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "mkdir") {
          dirs.add(args[args.length - 1]);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "rmdir") {
          const target = args[args.length - 1];
          const hasFile = [...files.keys()].some((entry) => entry.startsWith(`${target}/`));
          const hasChild = [...dirs].some((entry) => entry.startsWith(`${target}/`));
          if (hasFile || hasChild) return { code: 1, stdout: "", stderr: "Directory not empty" };
          dirs.delete(target);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "test" && args[0] === "-d") {
          return { code: dirs.has(args[1]) ? 0 : 1, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      async readFile(path: string): Promise<string> {
        const content = files.get(path);
        if (content === undefined) throw new Error(`no such file: ${path}`);
        return content;
      },
      async writeFile(path: string, content: string): Promise<void> {
        files.set(path, content);
      },
      async remove(path: string): Promise<void> {
        files.delete(path);
        dirs.delete(path);
        for (const key of files.keys()) {
          if (key.startsWith(`${path}/`)) files.delete(key);
        }
        for (const key of dirs) {
          if (key.startsWith(`${path}/`)) dirs.delete(key);
        }
      },
    },
    runtime: {
      stack() {
        return {
          async build() {
            calls.push("build");
          },
          async up() {
            calls.push("up");
          },
          async down() {},
          async status() {},
          async followLogs() {},
          async readLogs(tail: string) {
            return `stubbed log tail=${tail}\n`;
          },
          async isRunning() {
            return false;
          },
          async serviceStates() {
            return { app: { running: true } };
          },
        };
      },
    },
  } as unknown as Context;
  return { ctx, calls };
}

/** A stub stack with scripted per-poll service states, the shape install's readiness loop
 *  consumes; `states` is called once per poll. */
function stubStack(calls: string[], states: () => Record<string, StackServiceState> | Promise<Record<string, StackServiceState>>): Stack {
  return {
    async build() { calls.push("build"); },
    async up() { calls.push("up"); },
    async down() {},
    async status() {},
    async followLogs() {},
    async readLogRecords(tail: string) { return [{ text: `stubbed log tail=${tail}` }]; },
    async readLogs(tail: string) { return `stubbed log tail=${tail}\n`; },
    async isRunning() { return true; },
    // Wrapped, not assigned directly: Stack.serviceStates() must answer a promise, and the
    // readiness loop hands that answer to a bounding helper that calls .then on it.
    serviceStates: async () => states(),
  };
}

const scratch = resolve(tmpdir(), `clawwright-recipe-readiness-check-${Date.now()}`);

async function writeRecipe(name: string, json: unknown): Promise<void> {
  const dir = resolve(scratch, name);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, "recipe.json"), JSON.stringify(json), "utf8");
}

try {
  await mkdir(scratch, { recursive: true });
  useRecipesDir(scratch);
  useDeployment(resolve(scratch, "example-deployment"));

  // --- install: readiness checks every required service, not just "any container alive" ----

  await writeRecipe("multi-service", {
    description: "Multi-service recipe",
    readiness: { services: ["primary", "sidecar"], timeoutMs: 50 },
  });

  {
    const { ctx, calls } = stubContext({});
    ctx.runtime.stack = () => ({
      async build() { calls.push("build"); },
      async up() { calls.push("up"); },
      async down() {},
      async status() {},
      async followLogs() {},
      async readLogRecords(tail: string) { return [{ text: `stubbed log tail=${tail}` }]; },
      async readLogs(tail: string) { return `stubbed log tail=${tail}\n`; },
      // The old, coarse probe: still true, because the sidecar is alive. Proves the fix does
      // not lean on isRunning() at all for this decision.
      async isRunning() { return true; },
      async serviceStates() {
        return { primary: { running: false }, sidecar: { running: true } };
      },
    });
    let output = "";
    let refusal: unknown;
    try {
      await withOutputSink((chunk) => { output += chunk; }, () => recipe(ctx, ["install", "multi-service"]));
    } catch (error) {
      refusal = error;
    }
    check("build and up still ran before readiness caught the failure", calls, ["build", "up"]);
    check("install refuses instead of silently reporting running", refusal instanceof UserError, true);
    const report = readinessReport(output);
    check("failed primary report is degraded", report.status, "degraded");
    check("failed primary remains in consumer report", report.services, { primary: { running: false }, sidecar: { running: true } });
  }

  // The healthy counterpart: every declared service running clears readiness and afterStart runs.

  await writeRecipe("multi-service-healthy", {
    description: "Multi-service recipe, all services up",
    readiness: { services: ["primary", "sidecar"], timeoutMs: 50 },
  });

  {
    const { ctx, calls } = stubContext({});
    ctx.runtime.stack = () => ({
      async build() { calls.push("build"); },
      async up() { calls.push("up"); },
      async down() {},
      async status() {},
      async followLogs() {},
      async readLogRecords(tail: string) { return [{ text: `stubbed log tail=${tail}` }]; },
      async readLogs(tail: string) { return `stubbed log tail=${tail}\n`; },
      async isRunning() { return true; },
      async serviceStates() {
        return { primary: { running: true }, sidecar: { running: true, health: "healthy" } };
      },
    });
    let output = "";
    await withOutputSink((chunk) => { output += chunk; }, () => recipe(ctx, ["install", "multi-service-healthy"]));
    check("build and up ran", calls, ["build", "up"]);
    check("install reports ready once every declared service is up and healthy", readinessReport(output).status, "ready");
  }

  // --- malformed ports/variables are rejected at load, isolated at listing, and ----------
  // --- surfaced as a visible catalog entry rather than a thrown render -------------------

  const malformedManifests: Array<{ name: string; json: unknown }> = [
    { name: "bad-port-host-type", json: { description: "port host is not an integer", ports: [{ host: "8080", container: 80 }] } },
    { name: "bad-port-host-range-low", json: { description: "port host is 0", ports: [{ host: 0, container: 80 }] } },
    { name: "bad-port-host-range-high", json: { description: "port host exceeds 65535", ports: [{ host: 70000, container: 80 }] } },
    { name: "bad-port-null-element", json: { description: "ports array holds a null element", ports: [null] } },
    { name: "bad-variables-array", json: { description: "variables is an array, not an object", variables: ["FOO"] } },
    { name: "bad-variables-value-type", json: { description: "variables has a non-string value", variables: { FOO: 42 } } },
  ];

  for (const { name, json } of malformedManifests) {
    await writeRecipe(name, json);
    const manifestPath = resolve(scratch, name, "recipe.json");
    const before = await readFile(manifestPath, "utf8");
    const error = await refusalOf(`loadRecipe rejects ${name}`, () => loadRecipe(readName("recipe", name)));
    check(`${name}: malformed manifest refuses load`, error instanceof Error, true);
    check(`${name}: refused load preserves manifest`, await readFile(manifestPath, "utf8"), before);
  }

  const namesAfterMalformedManifests = (await listRecipes()).map((entry) => entry.name).sort();
  check(
    "(a) malformed ports/variables manifests do not break listRecipes for the working recipes",
    namesAfterMalformedManifests,
    ["multi-service", "multi-service-healthy"],
  );

  const brokenEntries = await listBrokenRecipes();
  const brokenNames = brokenEntries.map((entry) => entry.name).sort();
  check(
    "(b) every malformed manifest is reported by listBrokenRecipes, none silently dropped",
    brokenNames,
    malformedManifests.map((entry) => entry.name).sort(),
  );

  {
    const { ctx } = stubContext({});
    let listed = "";
    await withOutputSink((chunk) => {
      listed += chunk;
    }, () => recipe(ctx, ["list"]));
    check(
      "(a) recipe list renders the working recipes without throwing over a broken manifest",
      listed.includes("multi-service"),
      true,
    );
    for (const { name } of malformedManifests) {
      check(`(b) recipe list surfaces ${name} as a visible broken entry, not a silent omission`, listed.includes(name), true);
    }
  }

  // --- runtime backend: the compose ps listing must include stopped containers -----------
  // --- (--all) and aggregate replicas, or a crashed service silently leaves the -----------
  // --- requirement set and a surviving sidecar answers for the whole recipe ----------------

  {
    const dockerCalls: string[][] = [];
    let psOutput = "";
    const transport = {
      description: "stub",
      async mkdirp(_path: string): Promise<void> {},
      async exec(command: string, args: string[]) {
        if (command === "sh" && args[2] === "recipe-docker" && args[3] === "compose" && args.includes("ps")) {
          dockerCalls.push(args.slice(3));
          return { code: 0, stdout: psOutput, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      async writeFile(_path: string, _content: string | Uint8Array, _mode?: string): Promise<void> {},
      async remove(_path: string): Promise<void> {},
    };
    const runtime = new DockerRuntime(
      transport as unknown as Transport,
      { env: {}, dataDir: "/srv/clawwright-recipe-readiness-check" } as unknown as Settings,
      { toTarget: async (path: string) => path } as unknown as PathBridge,
      { service: "app" },
    );
    const stack = runtime.stack("readiness-check", "/tmp/readiness-check/compose.yml");

    psOutput = [
      JSON.stringify({ Service: "gateway", State: "running" }),
      JSON.stringify({ Service: "worker", State: "exited" }),
    ].join("\n");
    const states = await stack.serviceStates();
    check(
      "(a) the compose ps listing is requested with --all so stopped containers are reported",
      dockerCalls.some((args) => args.includes("ps") && args.includes("--all") && args.includes("--format")),
      true,
    );
    // health is present-but-undefined, not absent: a service that declares no healthcheck
    // has no health opinion at all (runtime.ts's StackServiceState), a fact distinct from
    // never having asked — the field is always reported, only its value is unset.
    check(
      "(a) a stopped container is part of the reported states, not filtered out of them",
      { ...states },
      { gateway: { running: true, health: undefined }, worker: { running: false, health: undefined } },
    );

    psOutput = [
      JSON.stringify({ Service: "worker", State: "running" }),
      JSON.stringify({ Service: "worker", State: "exited" }),
      JSON.stringify({ Service: "api", State: "running", Health: "healthy" }),
      JSON.stringify({ Service: "api", State: "running", Health: "starting" }),
    ].join("\n");
    const replicas = await stack.serviceStates();
    check("(d) one stopped replica out of several keeps the whole service not running", replicas.worker?.running, false);
    check(
      "(d) one unhealthy replica out of several keeps the whole service not healthy",
      replicas.api,
      { running: true, health: "starting" },
    );
  }

  // --- default derivation: with no readiness declared, the required set comes ------------
  // --- from the full listing, so a crashed service is a named failure, not a shrunk set ----

  await writeRecipe("no-readiness-crashed-service", {
    description: "No readiness declaration; one of two services crashed",
  });

  {
    const { ctx, calls } = stubContext({});
    ctx.runtime.stack = () => stubStack(calls, () => ({ sidecar: { running: true }, worker: { running: false } }));
    let output = "";
    let refusal: unknown;
    try {
      await withOutputSink((chunk) => { output += chunk; }, () => recipe(ctx, ["install", "no-readiness-crashed-service"]));
    } catch (error) {
      refusal = error;
    }
    check("(a) default readiness derivation fails install over the stopped service", refusal instanceof UserError, true);
    const report = readinessReport(output);
    check("default-derived readiness is degraded", report.status, "degraded");
    check("stopped worker cannot be answered by sidecar", report.services, { sidecar: { running: true }, worker: { running: false } });
  }

  // --- grace: a ready answer must HOLD for the grace window; a flip inside it -------------
  // --- fails readiness, naming the service that flipped ------------------------------------

  await writeRecipe("ready-then-crash", {
    description: "Reports running on the first poll, crashes before the grace window closes",
  });

  {
    const { ctx, calls } = stubContext({});
    const polls: Array<Record<string, StackServiceState>> = [
      { app: { running: true } },
      { app: { running: false } },
    ];
    let poll = 0;
    ctx.runtime.stack = () => stubStack(calls, () => polls[Math.min(poll++, polls.length - 1)]);
    let output = "";
    let refusal: unknown;
    try {
      await withOutputSink((chunk) => { output += chunk; }, () => recipe(ctx, ["install", "ready-then-crash"]));
    } catch (error) {
      refusal = error;
    }
    check("(b) grace-window failure refuses install", refusal instanceof UserError, true);
    check("grace window observes more than the initial ready poll", poll >= 2, true);
    const report = readinessReport(output);
    check("grace-window flip is degraded", report.status, "degraded");
    check("grace-window flip retains failed service", report.services, { app: { running: false } });
  }

  // --- probe bound: a hung serviceStates() must not defeat the readiness -----------------
  // --- deadline — it fires with a timeout message and an unknown verdict -------------------

  await writeRecipe("hung-state-probe", {
    description: "serviceStates never resolves",
    readiness: { services: ["app"], timeoutMs: 50 },
  });

  {
    const { ctx, calls } = stubContext({});
    ctx.runtime.stack = () => stubStack(calls, () => new Promise<Record<string, StackServiceState>>(() => {}));
    let output = "";
    let refusal: unknown;
    const startedAt = Date.now();
    try {
      await withOutputSink((chunk) => { output += chunk; }, () => recipe(ctx, ["install", "hung-state-probe"]));
    } catch (error) {
      refusal = error;
    }
    check("(c) a hung state probe still lets the readiness deadline fire", refusal instanceof UserError, true);
    check("hung probe is unknown rather than ready or degraded", readinessReport(output).status, "unknown");
    check("hung probe invents no service observations", readinessReport(output).services, {});
    check("(c) the deadline bounded the hung probe instead of waiting forever", Date.now() - startedAt < 5000, true);
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

finish("recipe readiness");

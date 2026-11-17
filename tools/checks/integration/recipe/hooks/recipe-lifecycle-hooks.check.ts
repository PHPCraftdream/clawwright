// Checks the recipe lifecycle hooks: a recipe that declares quiesce.ts/resume.ts is
// quiesced for exactly the window backup pauses the gateway for, and resumed on every exit
// path; an uncovered or failed hook refuses the snapshot and still compensates; and the two
// caller-owned modes (--hot, leaveStopped) call nothing.
//
// No target and no real recipe services: a stub transport drives the real createBackup(),
// and the hooks are real .ts files under a fixture recipes directory, imported through the
// same checksum-versioned loader prepare/verify/onboard use. Hook calls and the archive
// step record into one ordered event array, so the assertions pin ORDER, not just
// occurrence: quiesce between pause and tar, resume after the gateway is healthy.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createBackup, BACKUP_REFUSED, SIDECARS_RUNNING, GATEWAY_LEFT_STOPPED } from "#framework/commands/lifecycle/backup/index.ts";
import { WITHOUT_RESUME, QUIESCE_HOOK_FAILED, QUIESCED_FOR_SNAPSHOT, STILL_QUIESCED, INVALID_MANIFEST, timeoutMessage } from "#framework/commands/management/recipe/run/lifecycle.ts";
import type { BackupOptions } from "#framework/commands/lifecycle/backup/index.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { useDeployment, useComposeProjectOverride } from "#framework/runtime/deployment.ts";
import { clearRecipesDir, useRecipesDir } from "#framework/service/recipe.ts";
import type { Context } from "#framework/core/context.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { asDirectTest } from "#checks/runtime/service/restore/file-test-stub.ts";

useDeployment(resolve(monorepoRoot, "apps", "example app"));
useComposeProjectOverride("example-app");

const HOOK_LOG = "__clawwrightRecipeLifecycleEvents";
const dataDir = "/srv/clawwright/data";
const backupDir = "/srv/clawwright/backups";

interface Stub {
  ctx: Context;
  events: string[];
  probed: string[];
}

/** A transport/runtime stub answering every command createBackup() issues against a modeled
 *  target (the same shape convergence/backup/backup.check.ts drives), plus the recipe-stack probes
 *  runningRecipeStacks() makes. The archive step and the runtime transitions record into
 *  `events` — the same array the fixture hooks push to — so hook ordering against
 *  pause/tar/start is assertable as one sequence. */
const PROBE_FAILURE = "simulated stack probe failure";

const PAUSE_REFUSAL = "refuses to pause today";

function stub(failProbe = false): Stub {
  const events: string[] = [];
  const probed: string[] = [];
  const files = new Set<string>([dataDir]);
  const ctx = {
    settings: { dataDir, backupDir, env: {} },
    transport: {
      description: "recipe-lifecycle-stub",
      async exists(path: string): Promise<boolean> {
        return files.has(path);
      },
      async exec(rawCommand: string, rawArgs: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
        const { command, args } = asDirectTest(rawCommand, rawArgs);
        if (command === "test" && args[0] === "-L") return { code: 1, stdout: "", stderr: "" };
        if (command === "test" && args[0] === "-w") return { code: 0, stdout: "", stderr: "" };
        if (command === "test" && args[0] === "-e") return { code: files.has(args[1] ?? "") ? 0 : 1, stdout: "", stderr: "" };
        if (command === "tar" && args.includes("-czf")) {
          files.add(args[args.indexOf("-czf") + 1] ?? "");
          events.push("tar");
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "tar" && args.includes("-tzf")) {
          return { code: 0, stdout: "data/\ndata/config/openclaw.json\n", stderr: "" };
        }
        if (command === "sh" && args.some((arg) => arg.includes("-1t"))) {
          const archives = [...files].filter((path) => path.startsWith(`${backupDir}/`) && path.endsWith(".tar.gz"));
          return { code: 0, stdout: `${archives.join("\n")}\n`, stderr: "" };
        }
        if (command === "mv") {
          const source = args.at(-2) ?? "";
          const destination = args.at(-1) ?? "";
          files.delete(source);
          files.add(destination);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "rm") {
          for (const arg of args.filter((value) => !value.startsWith("-"))) {
            for (const path of Array.from(files)) {
              if (path === arg || (args.includes("-rf") && path.startsWith(`${arg}/`))) files.delete(path);
            }
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "rmdir") {
          files.delete(args[0] ?? "");
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      async readFile(): Promise<string> {
        throw new Error("not modeled");
      },
      async writeFile(): Promise<void> {},
      async remove(): Promise<void> {},
      async mkdirp(): Promise<void> {},
    },
    runtime: {
      async isRunning(): Promise<boolean> {
        return true;
      },
      async pause(): Promise<void> {
        events.push("pause");
      },
      async start(): Promise<void> {
        events.push("start");
      },
      async waitForHealth(): Promise<void> {
        events.push("waitForHealth");
      },
      stack(project: string) {
        probed.push(project);
        return {
          async isRunning(): Promise<boolean> {
            if (failProbe) throw new Error(PROBE_FAILURE);
            return true;
          },
        };
      },
    },
  } as unknown as Context;
  return { ctx, events, probed };
}

/** Fixture hook bodies. Each pushes a "<phase>:<recipe>" event into the shared log. */
const HOOKS: Record<string, string> = {
  "hooked/quiesce.ts": `export function quiesce() { globalThis.${HOOK_LOG}.push("quiesce:hooked"); }\n`,
  "hooked/resume.ts": `export function resume() { globalThis.${HOOK_LOG}.push("resume:hooked"); }\n`,
  "failing/quiesce.ts": `export function quiesce() { globalThis.${HOOK_LOG}.push("quiesce:failing"); throw new Error("${PAUSE_REFUSAL}"); }\n`,
  "failing/resume.ts": `export function resume() { globalThis.${HOOK_LOG}.push("resume:failing"); }\n`,
  "hung/quiesce.ts": `export function quiesce() { globalThis.${HOOK_LOG}.push("quiesce:hung"); return new Promise(() => {}); }\n`,
  "hung/resume.ts": `export function resume() { globalThis.${HOOK_LOG}.push("resume:hung"); }\n`,
  "no-resume/quiesce.ts": `export function quiesce() { globalThis.${HOOK_LOG}.push("quiesce:no-resume"); }\n`,
  "resume-fails/quiesce.ts": `export function quiesce() { globalThis.${HOOK_LOG}.push("quiesce:resume-fails"); }\n`,
  "resume-fails/resume.ts": `export function resume() { globalThis.${HOOK_LOG}.push("resume:resume-fails"); throw new Error("resume refused"); }\n`,
};

/** Writes a fixture recipes root with the named recipes; hook files only for the ones that
 *  declare them ("quiet" deliberately ships none). */
async function recipesWith(names: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clawwright-recipe-lifecycle-"));
  for (const name of names) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, "recipe.json"), JSON.stringify({ description: `${name} fixture` }), "utf8");
  }
  for (const [relativePath, content] of Object.entries(HOOKS)) {
    const owner = relativePath.split("/")[0];
    if (!names.includes(owner)) continue;
    await writeFile(join(root, relativePath), content, "utf8");
  }
  return root;
}

async function run(name: string, options: BackupOptions, recipeNames: string[], failProbe = false, malformedRecipe?: string): Promise<{ archive: string | undefined; output: string; events: string[]; probed: string[] }> {
  const root = await recipesWith(recipeNames);
  if (malformedRecipe !== undefined) {
    await writeFile(join(root, malformedRecipe, "recipe.json"), JSON.stringify({ description: "broken fixture", ports: [{ host: "invalid", container: 80 }] }), "utf8");
  }
  useRecipesDir(root);
  const stubbed = stub(failProbe);
  (globalThis as unknown as Record<string, unknown>)[HOOK_LOG] = stubbed.events;
  let output = "";
  let archive: string | undefined;
  try {
    archive = await withOutputSink((line) => { output += line; }, () => createBackup(stubbed.ctx, options));
  } catch (error) {
    output += `\nTHROWN: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    clearRecipesDir();
    delete (globalThis as unknown as Record<string, unknown>)[HOOK_LOG];
    await rm(root, { recursive: true, force: true });
  }
  return { archive, output, events: stubbed.events, probed: stubbed.probed };
}

// A broken manifest still maps to its directory's compose project: if that project is live,
// backup cannot infer or run its quiesce hooks and must refuse before tar.
{
  const result = await run("a running sidecar with a malformed manifest blocks the backup", {}, ["broken-sidecar"], false, "broken-sidecar");
  check("the malformed live sidecar prevents archive publication", result.archive, undefined);
  check("the backup explains why quiescing could not be confirmed", result.output.includes(INVALID_MANIFEST) && result.output.includes("ports[0].host"), true);
  check("tar is never reached while the running sidecar is unknown", result.events.includes("tar"), false);
}

// A failed resume is a failed compensation, never a successful backup result.
{
  const result = await run("a failed resume is reported", {}, ["resume-fails"]);
  check("the failed compensation turns the operation into an error", result.archive, undefined);
  const resumeRefused = "resume refused";
  check("the result explains that the recipe may remain stopped", result.output.includes(STILL_QUIESCED) && result.output.includes(resumeRefused), true);
  check("backup and resume were both attempted in order", result.events, ["pause", "quiesce:resume-fails", "tar", "start", "waitForHealth", "resume:resume-fails"]);
}

// Discovery happens after pause and can fail too; the gateway still returns to its prior
// running state, and the original probe error remains visible.
{
  const result = await run("a failed sidecar probe restarts the gateway", {}, ["hooked"], true);
  check("the probe failure aborts the backup", result.archive, undefined);
  check("the probe failure is reported", result.output.includes(PROBE_FAILURE), true);
  check("gateway compensation follows the failed probe", result.events, ["pause", "start", "waitForHealth"]);
}

// (1) A paired recipe hook brackets the archive.
{
  const result = await run("declared hooks bracket the archive", {}, ["hooked"]);
  check("the backup succeeds", typeof result.archive === "string", true);
  check(
    "quiesce runs between pause and tar, resume after the gateway is healthy",
    result.events,
    ["pause", "quiesce:hooked", "tar", "start", "waitForHealth", "resume:hooked"],
  );
  const uncoveredHooked = `${BACKUP_REFUSED}: hooked`;
  const announcedHooked = `hooked: ${QUIESCED_FOR_SNAPSHOT}`;
  check("the declared recipe is not named as uncovered", result.output.includes(uncoveredHooked), false);
  check("the successful quiesce is announced", result.output.includes(announcedHooked), true);
}

// (2) A failed hook refuses the snapshot and runs resume because quiesce may have partially
// stopped its service.
{
  const result = await run("a failing quiesce hook aborts and compensates", {}, ["failing"]);
  check("the backup refuses the incomplete snapshot", result.archive, undefined);
  check("the hook failure and refusal are reported", result.output.includes(QUIESCE_HOOK_FAILED) && result.output.includes(BACKUP_REFUSED) && result.output.includes(PAUSE_REFUSAL), true);
  check("resume runs after gateway restart", result.events, ["pause", "quiesce:failing", "start", "waitForHealth", "resume:failing"]);
}

// (3) A hung quiesce is bounded, refuses the snapshot and receives resume compensation.
{
  process.env.CLAWWRIGHT_RECIPE_HOOK_TIMEOUT_MS = "250";
  try {
    const result = await run("a hung quiesce aborts and compensates", {}, ["hung"]);
    check("the backup refuses the incomplete snapshot", result.archive, undefined);
    check("the deadline is reported", result.output.includes(timeoutMessage("recipe hung quiesce hook", 250)), true);
    const refusedHung = `${BACKUP_REFUSED}: hung`;
    check("the timeout refuses publication", result.output.includes(refusedHung), true);
    check("resume runs after gateway restart", result.events, ["pause", "quiesce:hung", "start", "waitForHealth", "resume:hung"]);
  } finally {
    delete process.env.CLAWWRIGHT_RECIPE_HOOK_TIMEOUT_MS;
  }
}

// (4) A quiesce without resume is rejected before the hook can stop the service.
{
  const result = await run("a quiesce without resume.ts is refused", {}, ["no-resume"]);
  check("the quiesce never runs", result.events.includes("quiesce:no-resume"), false);
  check("the missing resume and refused backup are reported", result.output.includes(WITHOUT_RESUME) && result.output.includes(BACKUP_REFUSED), true);
  check("no resume event is recorded", result.events.filter((entry) => entry.startsWith("resume:")), []);
  check("the gateway restarts after preflight rejection", result.events, ["pause", "start", "waitForHealth"]);
}

// (5) leaveStopped: the caller (pull, smoke's round trip) owns the transaction that
// continues past this function, so no hook runs — exactly the pre-hook behavior.
{
  const result = await run("leaveStopped owns the transaction and calls no hooks", { leaveStopped: true }, ["hooked"]);
  check("no hook runs when the caller owns the transaction", result.events, ["pause", "tar"]);
  check("the gateway stays stopped for the caller", result.output.includes(GATEWAY_LEFT_STOPPED), true);
  check("the caller is told sidecars remain running", result.output.includes(SIDECARS_RUNNING), true);
}

// (6) --hot accepts a torn snapshot by definition: no pause, no hooks, warning kept.
{
  const result = await run("a hot backup calls no hooks either", { hot: true }, ["hooked"]);
  check("a hot backup pauses nothing and calls no hooks", result.events, ["tar"]);
  check("a hot backup names the running stack", result.output.includes(SIDECARS_RUNNING), true);
}

finish("recipe lifecycle hook");

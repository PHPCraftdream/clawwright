// `./clawwright restore --dry-run`: the same selection/validation a real restore runs
// (prepareRestore), reported instead of acted on. A recording transport proves the split —
// restoreDryRun() must never issue a mutating command (mv/tar -x/mkdir/rm/chmod) and must
// never touch runtime.stop/start, whether the archive validates or not.

import { restoreDryRun, restoreArchive } from "#framework/commands/lifecycle/restore/index.ts";
import { NATIVE_MANIFEST_DEFERRED, identityLine, restorePlanHeader, restoreStepsHeader } from "#framework/commands/lifecycle/restore/plan.ts";
import { NATIVE_MANIFEST_NAME } from "#framework/commands/lifecycle/backup/index.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { UserError } from "#framework/core/io/log.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";
import { resolve } from "node:path";
import { check, finish } from "#checks/kit/harness.ts";
import { asDirectTest } from "#checks/runtime/service/restore/file-test-stub.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";

useDeployment(resolve(monorepoRoot, "apps", "example app"));

const DATA_DIR = "/srv/openclaw/data";
const ARCHIVE = "/srv/openclaw/backups/openclaw-x.tar.gz";
const FULL_ENTRIES = ["data/", "data/config/", "data/config/openclaw.json", "data/config/identity/", "data/config/identity/device-auth.json"];
const NO_IDENTITY_ENTRIES = ["data/", "data/config/", "data/config/openclaw.json"];
// The steps are asserted by their declared text and the plan's literal step count, not by
// position in the product's own list: a plan that stops describing an option, or starts
// counting differently, must fail here instead of quietly reshaping the expectation.
const STEP_START = "start the gateway, after checking its secrets are available";
const STEP_NO_START = "leave the gateway stopped (--no-start)";
const STEP_FRESH_IDENTITY = "drop identity and paired devices (--fresh-identity)";

const MUTATING = new Set(["mv", "rm", "mkdir", "chmod", "chown"]);

/** A restore.check.ts-shaped stub, plus exec recording and a runtime that throws if ever
 *  touched — the check for "dry-run stops before the act phase" is that these never fire. */
function makeCtx(entries: string[], beforeRestore?: Context["applicationBeforeRestore"]): { ctx: Context; calls: { command: string; args: string[] }[] } {
  const calls: { command: string; args: string[] }[] = [];
  const ctx = {
    settings: { dataDir: DATA_DIR, backupDir: "/srv/openclaw/backups", snapshotDir: "/srv/openclaw/snapshots", env: {} },
    transport: {
      description: "stub",
      async exists(): Promise<boolean> { return true; },
      async readFile(): Promise<string> { return ""; },
      async writeFile(): Promise<void> {},
      async mkdirp(): Promise<void> {},
      async remove(): Promise<void> {},
      async exec(rawCommand: string, rawArgs: string[]): Promise<ExecResult> {
        const { command, args } = asDirectTest(rawCommand, rawArgs);
        calls.push({ command, args });
        if (command === "tar" && args.includes("-tzf")) return { code: 0, stdout: `${entries.join("\n")}\n`, stderr: "" };
        if (command === "tar" && args.includes("-tvzf")) return { code: 0, stdout: "", stderr: "" };
        if (command === "stat" && args[0] === "-c" && args[1] === "%s %Y") return { code: 0, stdout: "123456 1767225600", stderr: "" };
        if (command === "test" && args[0] === "-L") return { code: 1, stdout: "", stderr: "" };
        if (command === "readlink" && args[0] === "-f") return { code: 0, stdout: args[1] ?? "", stderr: "" };
        if (command === "test" && args[0] === "-r") return { code: 0, stdout: "", stderr: "" };
        if (command === "test" && args[0] === "-d") return { code: 1, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    runtime: {
      async isRunning(): Promise<boolean> { throw new Error("dry-run must never ask the runtime whether it is running"); },
      async stop(): Promise<void> { throw new Error("dry-run must never stop the gateway"); },
      async start(): Promise<void> { throw new Error("dry-run must never start the gateway"); },
      async waitForHealth(): Promise<void> { throw new Error("dry-run must never wait for health"); },
    },
    applicationBeforeRestore: beforeRestore,
  } as unknown as Context;
  return { ctx, calls };
}

// A hook may fetch or decrypt the actual archive; preview cannot safely run it.
{
  let called = false;
  const { ctx, calls } = makeCtx(FULL_ENTRIES, async () => { called = true; return "/other/archive.tar.gz"; });
  let output = "";
  await withOutputSink(() => {}, () => restoreDryRun(ctx, "/encrypted/input", {}, true), (line) => { output += line; });
  const plan = JSON.parse(output) as { includesIdentity: boolean | null; checksDeferred: string[]; archiveSizeBytes?: number };
  check("preview never invokes beforeRestore", called, false);
  check("preview does not list or stat an encrypted input", calls.some((call) => call.command === "tar" || call.command === "stat"), false);
  check("preview does not mutate the target with a hook", calls.some((call) => MUTATING.has(call.command)), false);
  check("identity remains unknown until the hook runs", plan.includesIdentity, null);
  check("plan identifies the deferred hook", plan.checksDeferred.some((item) => item.includes("beforeRestore")), true);
  check("uninspected archive has no size", plan.archiveSizeBytes, undefined);
}

// The embedded native manifest needs extraction under live data; preview defers that check.
{
  const { ctx, calls } = makeCtx([...FULL_ENTRIES, `data/${NATIVE_MANIFEST_NAME}`]);
  let output = "";
  await withOutputSink(() => {}, () => restoreDryRun(ctx, ARCHIVE, {}, true), (line) => { output += line; });
  const plan = JSON.parse(output) as { nativeManifestPresent: boolean; nativeManifestVerified: boolean; checksDeferred: string[] };
  check("preview sees the native manifest", plan.nativeManifestPresent, true);
  check("preview does not claim native verification", plan.nativeManifestVerified, false);
  check("plan identifies native verification as real-restore only", plan.checksDeferred.some((item) => item.includes(NATIVE_MANIFEST_DEFERRED)), true);
  check("native preview never extracts or writes", calls.some((call) => MUTATING.has(call.command) || (call.command === "tar" && call.args.includes("-xzf"))), false);
}

{
  let called = false;
  const { ctx, calls } = makeCtx(FULL_ENTRIES, async () => { called = true; return ARCHIVE; });
  let output = "";
  await withOutputSink(() => {}, () => openclawCommands.push.run(ctx, [ARCHIVE, "--dry-run", "--json"]), (line) => { output += line; });
  const plan = JSON.parse(output) as { checksDeferred: string[] };
  check("push preview never invokes beforeRestore", called, false);
  check("push preview reports the deferred hook", plan.checksDeferred.some((item) => item.includes("beforeRestore")), true);
  check("push preview does not inspect or mutate the archive", calls.some((call) => call.command === "tar" || MUTATING.has(call.command)), false);
}

// --- a passing archive: reported, nothing touched ------------------------------------------

{
  const { ctx, calls } = makeCtx(FULL_ENTRIES);
  let output = "";
  let threw = false;
  await withOutputSink((line) => { output += line; }, async () => {
    try { await restoreDryRun(ctx, ARCHIVE, { force: true }); } catch { threw = true; }
  });

  check("a valid archive does not throw", threw, false);
  check("no mutating command was issued", calls.some((call) => MUTATING.has(call.command)), false);
  check("no extraction was attempted", calls.some((call) => call.command === "tar" && call.args.includes("-xzf")), false);
  check("the plan names the archive", output.includes("openclaw-x.tar.gz"), true);
  check("the plan says identity is included", output.includes(identityLine(true)), true);
  check("the plan names the moved-aside pattern", output.includes(`${DATA_DIR}.replaced-<timestamp>`), true);
  check("the plan lists the ordered steps", output.includes(restoreStepsHeader(6)), true);
  check("the plan says the gateway would start", output.includes(STEP_START), true);
}

// --- an archive missing identity: reported as such ------------------------------------------

{
  const { ctx } = makeCtx(NO_IDENTITY_ENTRIES);
  let output = "";
  await withOutputSink((line) => { output += line; }, () => restoreDryRun(ctx, ARCHIVE, { force: true }));
  check("the plan says identity is not included", output.includes(identityLine(false)), true);
}

// --- --no-start / --fresh-identity change the reported steps, not the validation -----------

{
  const { ctx } = makeCtx(FULL_ENTRIES);
  let output = "";
  await withOutputSink((line) => { output += line; }, () =>
    restoreDryRun(ctx, ARCHIVE, { force: true, noStart: true, freshIdentity: true }),
  );
  check("--no-start is reflected in the plan", output.includes(STEP_NO_START), true);
  check("--fresh-identity is reflected in the plan", output.includes(STEP_FRESH_IDENTITY), true);
  check("the --no-start plan counts its extra step", output.includes(restoreStepsHeader(7)), true);
  check("and never starts the gateway", output.includes(STEP_START), false);
}

// --- a validation failure gives the same refusal a real restore gives, and still nothing
// mutating runs first --------------------------------------------------------------------

{
  const brokenEntries = ["data/", "/etc/passwd"]; // an absolute path — inspectArchive's fatal case
  const dryRun = makeCtx(brokenEntries);
  const real = makeCtx(brokenEntries);

  let dryRunError: unknown;
  await withOutputSink(() => {}, async () => {
    try { await restoreDryRun(dryRun.ctx, ARCHIVE, { force: true }); } catch (error) { dryRunError = error; }
  });
  let realError: unknown;
  await withOutputSink(() => {}, async () => {
    try { await restoreArchive(real.ctx, ARCHIVE, { force: true }); } catch (error) { realError = error; }
  });

  check("a broken archive refuses the dry run", dryRunError instanceof UserError, true);
  check(
    "the dry-run refusal is exactly the refusal a real restore gives",
    dryRunError instanceof Error && realError instanceof Error ? dryRunError.message : "mismatch",
    dryRunError instanceof Error && realError instanceof Error ? realError.message : "mismatch",
  );
  check("no mutating command ran before the dry-run refusal", dryRun.calls.some((call) => MUTATING.has(call.command)), false);
}

// --- the `restore` dispatcher itself, with --dry-run, never confirms and never locks -------
// (no TTY in this process — a real restore would die() asking for confirmation; --dry-run
// must never reach that call at all)

{
  const { ctx, calls } = makeCtx(FULL_ENTRIES);
  let output = "";
  let threw = false;
  await withOutputSink((line) => { output += line; }, async () => {
    try { await openclawCommands.restore.run(ctx, [ARCHIVE, "--dry-run"]); } catch { threw = true; }
  });
  check("restore --dry-run does not ask for confirmation", threw, false);
  check("restore --dry-run reports a plan", output.includes(restorePlanHeader(DATA_DIR, "openclaw-x.tar.gz")), true);
  check("restore --dry-run issues no mutating command", calls.some((call) => MUTATING.has(call.command)), false);
}

// --- --dry-run with --force is accepted (force is simply irrelevant) -----------------------

{
  const { ctx } = makeCtx(FULL_ENTRIES);
  let threw = false;
  await withOutputSink(() => {}, async () => {
    try { await openclawCommands.restore.run(ctx, [ARCHIVE, "--dry-run", "--force"]); } catch { threw = true; }
  });
  check("--dry-run --force does not throw", threw, false);
}

finish("restore --dry-run");

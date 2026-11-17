// The privacy ledger (see docs/internal/review-2026-09-22-xa-round-3.md) lives operator-side at
// <deployment>/config/private-paths.json, but a full backup publishes a copy into the data
// root at <dataDir>/config/clawwright-private-paths.json (createArchive, profile "full"), and
// restoreArchive imports it back into the deployment ledger after verifyRestoredLayout.
//
// The ledger describes the target while living on the operator side, so recording a private
// write used to help only while the backup was restored through the very deployment directory
// the write was recorded in. A restore through a different one — a new folder, a lost one,
// another machine managing the same target — arrived with the data and none of its history,
// and the next migrate/share built its exclusions from an empty record: fail-closed for a
// ledger that exists but cannot be read is still fail-open for one that is simply not there.
//
// Part A drives the ledger/history contract itself — the publish unit (including the
// adopt-existing-target and explicit-forget-still-clears-both-copies scenarios (see
// docs/internal/review-2026-09-23-xs-round-4.md), the import's merge and its two refusals. It needs no
// target and runs everywhere.
// Part B is the whole scenario over real GNU tar and a real POSIX filesystem (LocalTransport
// on Linux, a WSL distribution on it): a real private write through the fixture recipe's
// prepare hook, a full backup, then a restore through a DIFFERENT, fresh operator-side
// deployment with NO recipes — the written file is still classified private (excluded from
// share, refused by verify) — a corrupt history copy fails the restore with the previous data
// put back, and a repeated restore changes nothing. The lesson of the 2026-09-21 audit
// stands: a simulated tar cannot contradict the code it was modelled on.

import { randomBytes } from "node:crypto";
import { readName } from "#framework/core/values/names.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { restoreArchive } from "#framework/commands/lifecycle/restore/index.ts";
import { verifySnapshot } from "#framework/commands/lifecycle/verify.ts";
import { parseWslDistroListing } from "#framework/commands/interface/host/contexts.ts";
import type { Context } from "#framework/core/context.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { deploymentDir, useDeployment } from "#framework/runtime/deployment.ts";
import { LocalTransport, spawnLocal, WslTransport, type Transport } from "#framework/runtime/transport/transport.ts";
import { createArchive, listArchive } from "#framework/service/archive/index.ts";
import { sudoFor } from "#framework/runtime/files/datadir.ts";
import {
  clearRecipesDir,
  installedRecipePrivatePaths,
  loadRecipe,
  recipesDirectory,
  useRecipesDir,
  type Recipe,
} from "#framework/service/recipe.ts";
import {
  forgetPrivatePaths,
  importRestoredPrivatePathsHistory,
  persistedPrivatePaths,
  privatePathsHistoryFile,
  privatePathsLedgerFile,
  publishPrivatePathsHistory,
  recordPrivateWrite,
} from "#framework/security/privacy/private-paths-ledger.ts";
import { check, finish, requires } from "#checks/kit/harness.ts";
import { asDirectTest } from "#checks/kit/deployment-fixture.ts";

function skip(name: string): void {
  process.stderr.write(`  skip ${name}\n`);
}

/** The message a rejected promise failed with, or undefined when it did not reject. */
async function rejectionOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    return (error as Error).message;
  }
  return undefined;
}

/** A real POSIX filesystem with real GNU tar: this machine on Linux, a WSL distribution
 *  on it. Where neither exists the archive group is skipped, loudly. */
async function realPosixTransport(): Promise<Transport | undefined> {
  if (process.platform === "linux") return new LocalTransport();
  if (process.platform !== "win32") return undefined;
  try {
    const listing = await spawnLocal("wsl.exe", ["--list", "--quiet"], { allowFailure: true, timeoutMs: 30_000 });
    for (const distro of parseWslDistroListing(listing.stdout).slice(0, 2)) {
      const candidate = new WslTransport(distro);
      const shell = await candidate
        .exec("sh", ["-c", "true"], { allowFailure: true, timeoutMs: 30_000 })
        .then((result) => result.code === 0, () => false);
      if (shell) return candidate;
    }
  } catch {
    // wsl.exe missing or unlaunchable — reported as the skip below.
  }
  return undefined;
}

/** Writes test-fixture content into a real target path that a prior restore may already have
 *  re-owned to the fixed container uid: the content travels as a positional
 *  shell argument, never interpolated, so it needs no quoting regardless of what it contains. */
async function privilegedWrite(ctx: Context, transport: Transport, path: string, content: string): Promise<void> {
  const prefix = await sudoFor(ctx, path);
  const [head, ...rest] = [...prefix, "sh", "-c", 'printf %s "$1" > "$2"', "sh", content, path];
  await transport.exec(head, rest);
}

const previousRecipes = (() => {
  try { return recipesDirectory(); } catch { return undefined; }
})();
const previousDeployment = (() => {
  try { return deploymentDir(); } catch { return undefined; }
})();

// Checks share one process, so the deployment and recipes roots this file selects are
// restored in the finally — the same discipline snapshot.check.ts applies to the recipes
// root. Both deployments are real temporary directories WITH config/ (scaffold.ts creates
// that for every real deployment; recording and importing are live only then): A is the
// operator side the private write is really recorded in, B the fresh one the restore runs
// through. The recipe roots are the set that declares the write (A) and an empty one (B).
const tag = randomBytes(4).toString("hex");
const deploymentA = await mkdtemp(join(tmpdir(), `clawwright-pp-history-deployment-a-${tag}-`));
await mkdir(resolve(deploymentA, "config"), { recursive: true });
const deploymentB = await mkdtemp(join(tmpdir(), `clawwright-pp-history-deployment-b-${tag}-`));
await mkdir(resolve(deploymentB, "config"), { recursive: true });
const recipesA = await mkdtemp(join(tmpdir(), `clawwright-pp-history-recipes-a-${tag}-`));
const recipesB = await mkdtemp(join(tmpdir(), `clawwright-pp-history-recipes-b-${tag}-`));
await mkdir(join(recipesA, "history-sidecar"), { recursive: true });
await writeFile(
  join(recipesA, "history-sidecar", "recipe.json"),
  `${JSON.stringify({ description: "history fixture sidecar", privatePaths: ["sidecar-private"] }, null, 2)}\n`,
  "utf8",
);

const sorted = (paths: readonly string[]): string => JSON.stringify([...paths].sort());
// What the ledger holds after the fixture's two writes: the file and the private directory
// it was written through, plus their shared private ancestor — the same shape the
// declaration had, so exclusion and refusal outlive both it and the deployment change.
const RECORDED = ["sidecar-private", "sidecar-private/credentials.env", "sidecar-private/state"];

let transport: Transport | undefined;
let PARENT: string | undefined;

try {
  useDeployment(deploymentA);

  // === PART A — the ledger/history contract, no target needed =====================================

  check(
    "the history copy lives in the data root's config/",
    privatePathsHistoryFile("/srv/x/data"),
    "/srv/x/data/config/clawwright-private-paths.json",
  );
  check(
    "a trailing slash on the data directory is tolerated",
    privatePathsHistoryFile("/srv/x/data/"),
    "/srv/x/data/config/clawwright-private-paths.json",
  );

  // A real recorded write (the ledger itself, no target), then the publish unit: the copy is
  // written through the transport's private write into the data root, and names exactly what
  // was recorded — sorted, as writeLedger writes it. The declared boundary is passed
  // explicitly: recordPrivateWrite no longer infers ancestors from the path
  // alone, so a synthetic "vault" directory declaration is named here the way a real caller
  // (assertDeclaredPrivatePath) would.
  await recordPrivateWrite("vault/credentials.env", "vault");
  const privateWrites: { path: string; body?: string; mode?: string }[] = [];
  const plainWrites: { path: string; body?: string; mode?: string }[] = [];
  const publishCtx = {
    settings: { dataDir: "/tgt/data", env: {} },
    transport: {
      async exists(): Promise<boolean> { return false; },
      async mkdirp(): Promise<void> {},
      async writePrivateFile(path: string, body: string): Promise<void> { privateWrites.push({ path, body }); },
      async writeFile(path: string, body: string, mode?: string): Promise<void> { plainWrites.push({ path, body, mode }); },
    },
  } as unknown as Context;
  await publishPrivatePathsHistory(publishCtx);
  check("the copy is written exactly once", privateWrites.length + plainWrites.length, 1);
  check("it went into the data root's config/", plainWrites[0]?.path, "/tgt/data/config/clawwright-private-paths.json");
  check("and it was written owner-only through the atomic publish path", plainWrites.length === 1 && plainWrites[0]?.mode === "600", true);
  const published = JSON.parse(plainWrites[0]?.body ?? "null") as { privatePaths?: string[] } | null;
  check(
    "it names the recorded paths",
    sorted(published?.privatePaths ?? []),
    sorted(["vault", "vault/credentials.env"]),
  );
  // The entry was only publish's vehicle: Part B records the fixture's writes into this same
  // ledger and expects exactly RECORDED there.
  await rm(privatePathsLedgerFile(), { force: true });

  // An empty LOCAL ledger (see docs/internal/review-2026-09-23-xs-round-4.md) used to make
  // publishPrivatePathsHistory remove any target copy outright — which does not distinguish
  // "the operator explicitly forgot this history" from "this deployment folder never wrote a
  // ledger of its own, and the target is the only surviving record" (a lost or freshly
  // recreated deployment folder adopting an existing instance). A single stateful fake target
  // — exists()/exec("cat")/writePrivateFile()/remove() all read and write the same `body` slot
  // — carries the target-side file across the three publishes below the way a real one would.
  useDeployment(deploymentB);
  check("the fresh deployment B starts with no ledger of its own", sorted(await persistedPrivatePaths()), "[]");
  const fakeTarget: { body: string | undefined } = { body: undefined };
  const removals: string[] = [];
  const writes: { path: string; body: string }[] = [];
  const publishAgainstFakeTarget = (): Context =>
    ({
      settings: { dataDir: "/tgt/data", env: {} },
      transport: {
        async exists(): Promise<boolean> { return fakeTarget.body !== undefined; },
        async remove(path: string): Promise<void> { removals.push(path); fakeTarget.body = undefined; },
        async mkdirp(): Promise<void> {},
        async writePrivateFile(path: string, body: string): Promise<void> {
          writes.push({ path, body });
          fakeTarget.body = body;
        },
        async writeFile(path: string, body: string): Promise<void> {
          writes.push({ path, body });
          fakeTarget.body = body;
        },
        async exec(command: string): Promise<{ code: number; stdout: string; stderr: string }> {
          if (command === "cat") return { code: 0, stdout: fakeTarget.body ?? "", stderr: "" };
          // sudoFor's own probes ("test -w", "sh -c command -v sudo") never need to escalate here.
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    }) as unknown as Context;

  // Scenario 0: nothing anywhere. Publish must neither write nor remove.
  await publishPrivatePathsHistory(publishAgainstFakeTarget());
  check("nothing recorded and no target copy publishes nothing", removals.length + writes.length, 0);

  // Scenario 1 (adopt-existing-target): the local ledger file was never written on this
  // deployment folder, but the target already carries a history from elsewhere. Publish must
  // NOT delete it — it adopts it into the local ledger and republishes it.
  const ADOPTED = ["orphan-private", "orphan-private/secret.env"];
  fakeTarget.body = `${JSON.stringify({ privatePaths: ADOPTED })}\n`;
  await publishPrivatePathsHistory(publishAgainstFakeTarget());
  check("an existing target copy is NOT deleted when the local ledger was never written", removals.length, 0);
  check("it is republished instead", writes.length, 1);
  check(
    "and adopted into the local ledger",
    sorted(await persistedPrivatePaths()),
    sorted(ADOPTED),
  );
  check("the target copy still exists after adoption", fakeTarget.body !== undefined, true);

  // Scenario 2 (explicit forget still works): once the operator actually calls
  // forgetPrivatePaths, the local ledger file exists with zero entries — real proof of a
  // deliberate forget, not silence. The next publish now removes the target copy too, so both
  // sides end up cleared.
  await forgetPrivatePaths(ADOPTED);
  check("forgetPrivatePaths empties the local ledger", sorted(await persistedPrivatePaths()), "[]");
  writes.length = 0;
  await publishPrivatePathsHistory(publishAgainstFakeTarget());
  check("an explicit forget removes the target copy on the next publish", removals.length, 1);
  check("the removal names the published copy's path", removals[0], "/tgt/data/config/clawwright-private-paths.json");
  check("and nothing was (re)written for the now-forgotten history", writes.length, 0);
  check("the target copy is gone after the forget propagates", fakeTarget.body, undefined);

  // The import, against deployment B's real ledger: sudoFor probes first (`test -w` answers
  // "writable" for everything here), and only `cat` carries the restored copy's bytes.
  const HISTORY = privatePathsHistoryFile("/tgt/data");
  const importCtxFor = (payload: string): Context =>
    ({
      settings: { dataDir: "/tgt/data", env: {} },
      transport: {
        async exists(): Promise<boolean> { return true; },
        async exec(command: string): Promise<{ code: number; stdout: string; stderr: string }> {
          if (command === "cat") return { code: 0, stdout: payload, stderr: "" };
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    }) as unknown as Context;

  const MERGED = ["ledger-a", "ledger-a/secret.env"];
  const addedFirst = await importRestoredPrivatePathsHistory(importCtxFor(JSON.stringify({ privatePaths: MERGED })), HISTORY);
  check("the import merges the restored history into a fresh ledger", sorted(await persistedPrivatePaths()), sorted(MERGED));
  check("both entries are reported as added", sorted(addedFirst), sorted(MERGED));

  const addedSecond = await importRestoredPrivatePathsHistory(
    importCtxFor(JSON.stringify({ privatePaths: ["other"] })),
    HISTORY,
  );
  check("a second import unions with what is already there", sorted(await persistedPrivatePaths()), sorted([...MERGED, "other"]));
  check("and reports only the entries it added", sorted(addedSecond), JSON.stringify(["other"]));

  // Fail closed: a copy that exists but cannot be read or validated must never read as "no
  // history" — and the refusal happens before anything is written.
  const parseRejection = await rejectionOf(() => importRestoredPrivatePathsHistory(importCtxFor("{ not json"), HISTORY));
  check("a history copy that cannot be parsed fails the import", /could not parse/.test(parseRejection ?? ""), true);
  check("and the failed parse wrote nothing", sorted(await persistedPrivatePaths()), sorted([...MERGED, "other"]));

  const escapeRejection = await rejectionOf(() =>
    importRestoredPrivatePathsHistory(importCtxFor(JSON.stringify({ privatePaths: ["../escape"] })), HISTORY),
  );
  check(
    "a history entry that climbs out of the data directory is refused",
    /stay inside the data directory/.test(escapeRejection ?? ""),
    true,
  );

  // Part B restores into deployment B and expects its ledger to start genuinely fresh.
  await rm(privatePathsLedgerFile(), { force: true });

  // === PART B — the real end-to-end scenario (real POSIX filesystem + real GNU tar) ===============

  await requires("local-posix", "the private-history restore checks", async () => {
  transport = await realPosixTransport();
  if (transport === undefined) {
    skip("the private-history restore checks (no local POSIX filesystem and no WSL distribution with a shell)");
  } else {
    PARENT = `/tmp/clawwright-pp-history-${tag}`;
    const DATA_NAME = "data";
    const DATA = `${PARENT}/${DATA_NAME}`;
    const ARCHIVES = `${PARENT}/archives`;

    await transport.mkdirp(`${DATA}/config`);
    await transport.mkdirp(`${DATA}/workspace`);
    await transport.mkdirp(ARCHIVES);
    await transport.writeFile(`${DATA}/config/openclaw.json`, JSON.stringify({ models: { providers: {} } }));
    await transport.writeFile(`${DATA}/workspace/SOUL.md`, "# fixture\n");
    // Ordinary instance content only: the content scan then has nothing to search for and
    // stays out of the path-based assertions' way.
    const ctx = { settings: { dataDir: DATA, env: {} }, transport } as unknown as Context;

    // The operator side the private write is REALLY recorded in, and the recipe that declares
    // it — the deployment the audit's scenario starts from.
    useDeployment(deploymentA);
    useRecipesDir(recipesA);

    // The real private-write helpers, driven the way `recipe install` drives a prepare hook.
    const fixture = (await import(
      new URL("../../security/credentials/recipe-private-snapshot/fixture-recipe/fixture-sidecar/prepare.ts", import.meta.url).href
    )) as { prepare: (ctx: Context, recipe: Recipe) => Promise<void> };
    await fixture.prepare(ctx, await loadRecipe(readName("recipe", "history-sidecar")));
    check(
      "the fixture's private write really happened on the target",
      await transport.exists(`${DATA}/sidecar-private/credentials.env`),
      true,
    );
    check("the private write was recorded with its private ancestors", sorted(await persistedPrivatePaths()), sorted(RECORDED));

    // The backup carries the history physically: publish runs before tar, and full keeps it.
    const fullBackup = `${ARCHIVES}/full.tar.gz`;
    await createArchive(ctx, { archive: fullBackup, profile: "full" });
    const fullEntries = await listArchive(ctx, fullBackup);
    check("the full backup keeps the private file", fullEntries.includes("data/sidecar-private/credentials.env"), true);
    check(
      "the full backup carries the privacy history physically",
      fullEntries.includes("data/config/clawwright-private-paths.json"),
      true,
    );

    // The fresh operator-side deployment: a different directory, and a recipe set that holds
    // nothing that declares the write. The audit's precondition, verbatim.
    useDeployment(deploymentB);
    useRecipesDir(recipesB);
    check(
      "the fresh deployment starts with no declarations and no record",
      sorted(await installedRecipePrivatePaths()),
      "[]",
    );
    const runtimeStub = {
      async isRunning(): Promise<boolean> { return false; },
      async stop(): Promise<void> {},
      async start(): Promise<void> {},
      async waitForHealth(): Promise<void> {},
    };
    const restoreCtx = { settings: { dataDir: DATA, env: {} }, transport, runtime: runtimeStub } as unknown as Context;
    let restoreOutput = "";
    let restoreThrew = false;
    try {
      await withOutputSink((chunk) => { restoreOutput += chunk; }, () => restoreArchive(restoreCtx, fullBackup, { force: true }));
    } catch (error) {
      restoreThrew = true;
      process.stderr.write(`  (diagnostic) fresh-deployment restore threw: ${(error as Error).message}\n`);
    }
    check("the restore through the fresh deployment succeeds", restoreThrew, false);
    check("its ledger now holds the restored history", sorted(await persistedPrivatePaths()), sorted(RECORDED));
    check(
      "the whole policy is the history, with no declaration anywhere",
      sorted(await installedRecipePrivatePaths()),
      sorted(RECORDED),
    );
    check("the restore says the history was restored", restoreOutput.includes("privacy history"), true);

    // The acceptance criterion: what the next migrate/share does with the restored data.
    // createArchive runs under deployment B, whose policy now comes entirely from the
    // restored history.
    const shareAfterRestore = `${ARCHIVES}/share-after-restore.tar.gz`;
    await createArchive(ctx, { archive: shareAfterRestore, profile: "share" });
    const shareEntries = await listArchive(ctx, shareAfterRestore);
    check(
      "a share archive taken after the restore leaves the private file out",
      shareEntries.includes("data/sidecar-private/credentials.env"),
      false,
    );
    check(
      "and the history copy itself does not travel in share",
      shareEntries.includes("data/config/clawwright-private-paths.json"),
      false,
    );

    // Symmetrically for migrate — and it is not a duplicate of the share assert: the copy is
    // published into the LIVE data root by every full backup and stays on disk afterwards,
    // so once one full backup exists, an explicit exclusion is the only thing keeping it out
    // of every profile-limited archive taken later. The first assert re-pins the restored
    // policy (the union under deployment B); the second is the exclusion this file exists
    // to hold in place.
    const migrateAfterRestore = `${ARCHIVES}/migrate-after-restore.tar.gz`;
    await createArchive(ctx, { archive: migrateAfterRestore, profile: "migrate" });
    const migrateEntries = await listArchive(ctx, migrateAfterRestore);
    check(
      "a migrate archive taken after the restore leaves the private file out",
      migrateEntries.includes("data/sidecar-private/credentials.env"),
      false,
    );
    check(
      "and the history copy itself does not travel in migrate",
      migrateEntries.includes("data/config/clawwright-private-paths.json"),
      false,
    );

    // Defense in depth, the snapshot.check shape: an archive with no exclusions at all — so,
    // unlike createArchive, this deliberately walks straight into sidecar-private AND
    // auth-secrets. Real read access to either needs the same per-source escalation
    // createArchive itself now asks for: a CI
    // identity that owns this tree's other files outright still cannot open a directory
    // locked to 1000:1000 mode 700 — ensureDataDirs' own auth-secrets among them once its
    // ownership actually differs from this identity, not just the recipe's sidecar-private.
    const sidecarPrefix = await sudoFor(ctx, `${DATA}/sidecar-private`);
    const rawPrefix = sidecarPrefix.length > 0 ? sidecarPrefix : await sudoFor(ctx, `${DATA}/auth-secrets`);
    const [rawHead, ...rawRest] = [...rawPrefix, "tar", "--numeric-owner", "-czf", `${ARCHIVES}/raw.tar.gz`, "-C", PARENT, DATA_NAME];
    await transport.exec(rawHead, rawRest);
    check(
      "verify refuses the raw archive as share",
      await withOutputSink(() => {}, () => verifySnapshot(ctx, `${ARCHIVES}/raw.tar.gz`, "share")),
      false,
    );
    check(
      "verify refuses the same archive as migrate",
      await withOutputSink(() => {}, () => verifySnapshot(ctx, `${ARCHIVES}/raw.tar.gz`, "migrate")),
      false,
    );

    // A corrupt history copy must fail the restore — with the previous data put back and the
    // ledger untouched.
    await privilegedWrite(ctx, transport, `${DATA}/workspace/live-marker.md`, "previous data\n");
    // A separate archive tree, so its markers differ from the live ones.
    await transport.mkdirp(`${PARENT}/corrupt-src/data/config`);
    await transport.mkdirp(`${PARENT}/corrupt-src/data/workspace`);
    await transport.writeFile(`${PARENT}/corrupt-src/data/config/openclaw.json`, JSON.stringify({ models: { providers: {} } }));
    await transport.writeFile(`${PARENT}/corrupt-src/data/workspace/from-archive.md`, "archive data\n");
    await transport.writeFile(`${PARENT}/corrupt-src/data/config/clawwright-private-paths.json`, "{ not json");
    await transport.exec("tar", [
      "--numeric-owner",
      "-czf",
      `${ARCHIVES}/corrupt.tar.gz`,
      "-C",
      `${PARENT}/corrupt-src`,
      DATA_NAME,
    ]);
    // The successful restores above each keep their previous tree at data.replaced-<stamp>;
    // that is earlier history, not this restore's. Removed so the rollback assertions below
    // are about the failed restore alone.
    await transport.exec("sh", ["-c", "rm -rf -- \"$1\"/data.replaced-*", "sh", PARENT], { allowFailure: true });

    let corruptThrew = false;
    let corruptMessage = "";
    try {
      await withOutputSink(() => {}, () => restoreArchive(restoreCtx, `${ARCHIVES}/corrupt.tar.gz`, { force: true }));
    } catch (error) {
      corruptThrew = true;
      corruptMessage = (error as Error).message;
    }
    check("the restore with a corrupt history copy fails", corruptThrew, true);
    check("it fails closed on the parse", /could not parse/.test(corruptMessage), true);
    // Seen failing once under parallel load and never reproduced since: the booleans above
    // hide why, so a failure prints the restore's own message.
    if (!/could not parse/.test(corruptMessage)) process.stderr.write(`    restore message: ${corruptMessage || "(none — restore did not throw)"}\n`);
    check("the previous live data was put back", await transport.exists(`${DATA}/workspace/live-marker.md`), true);
    check("the archive's own marker never landed", await transport.exists(`${DATA}/workspace/from-archive.md`), false);
    const replacedLeft = await transport.exec(
      "sh",
      ["-c", "ls -1d \"$1\"/data.replaced-* 2>/dev/null", "sh", PARENT],
      { allowFailure: true },
    );
    check("no replaced-aside directory is left behind", replacedLeft.stdout.trim(), "");
    check("the failed restore never touched the ledger", sorted(await persistedPrivatePaths()), sorted(RECORDED));

    // Restoring the same full backup again must change nothing: the import is a union.
    let idempotentThrew = false;
    try {
      await withOutputSink(() => {}, () => restoreArchive(restoreCtx, fullBackup, { force: true }));
    } catch (error) {
      idempotentThrew = true;
      process.stderr.write(`    second restore message: ${(error as Error).message}\n`);
    }
    check("a second restore of the same backup succeeds", idempotentThrew, false);
    check(
      "and the ledger still holds exactly the recorded paths",
      sorted(await persistedPrivatePaths()),
      sorted(RECORDED),
    );
  }

  // === PART C — a failure staged AFTER the history import
  // succeeded must undo that import along with the data tree =========================================
  //
  // importRestoredHistory runs before fresh-identity and ensureDataDirs, inside the try whose
  // catch puts the data tree back from `aside` — but nothing put the ledger back too. A
  // failure in ensureDataDirs (after a successful import) used to leave deployment B's ledger
  // holding entries from an archive the restore ultimately rejected, so the OLD instance came
  // out of a failed restore with policy boundaries from an unaccepted archive. Driven with a
  // stub transport — the failure pinned down here is ensureDataDirs' own chmod, which no real
  // archive can trigger on demand, so this is genuinely a different failure point than Part
  // B's corrupt-history case above (which fails INSIDE the import, before anything is written).
  useDeployment(deploymentB);
  {
    const STUB_DATA_DIR = "/synthetic/pp-rollback/data";
    const STUB_PARENT = "/synthetic/pp-rollback";
    const STUB_ARCHIVE = `${STUB_PARENT}/backups/pp-rollback.tar.gz`;
    const RESTORED_ONLY = ["restored-only-path"];
    // Whatever this deployment's ledger already holds (Part B may have left RECORDED there,
    // or it may be empty if Part B was skipped) is the state a correct rollback must return to
    // — not merely "empty".
    const baseline = await persistedPrivatePaths();

    const stubCtx = {
      settings: { dataDir: STUB_DATA_DIR, env: {} },
      transport: {
        description: "stub",
        async exists(): Promise<boolean> { return true; },
        async readFile(): Promise<string> { return ""; },
        async writeFile(): Promise<void> {},
        async mkdirp(): Promise<void> {},
        async remove(): Promise<void> {},
        async exec(rawCommand: string, rawArgs: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
          const { command, args } = asDirectTest(rawCommand, rawArgs);
          if (command === "tar" && args.includes("-tzf")) {
            return {
              code: 0,
              stdout:
                "data/\ndata/config/\ndata/config/openclaw.json\ndata/config/clawwright-private-paths.json\n" +
                "data/workspace/\ndata/auth-secrets/\n",
              stderr: "",
            };
          }
          if (command === "tar" && args.includes("-tvzf")) return { code: 0, stdout: "", stderr: "" };
          // The restored history copy: a valid, parseable payload, so the import really
          // succeeds and really writes to deployment B's ledger before the later failure.
          if (command === "cat") return { code: 0, stdout: JSON.stringify({ privatePaths: RESTORED_ONLY }), stderr: "" };
          if (command === "stat" && args[1] === "%u:%g") return { code: 0, stdout: "1000:1000", stderr: "" };
          // Anything but "700": forces ensureDataDirs to attempt the chmod below.
          if (command === "stat" && args[1] === "%a") return { code: 0, stdout: "755", stderr: "" };
          if (command === "chmod" && args[0] === "700" && args[1] === `${STUB_DATA_DIR}/auth-secrets`) {
            throw new Error("simulated ensureDataDirs failure: chmod auth-secrets");
          }
          if (command === "test" && args[0] === "-L") return { code: 1, stdout: "", stderr: "" };
          if (command === "test" && args[0] === "-w") return { code: 0, stdout: "", stderr: "" };
          if (command === "readlink" && args[0] === "-f") return { code: 0, stdout: args[1] ?? "", stderr: "" };
          return { code: 0, stdout: "", stderr: "" };
        },
      },
      runtime: {
        async isRunning(): Promise<boolean> { return false; },
        async stop(): Promise<void> {},
        async start(): Promise<void> {
          throw new Error("the gateway must never start from this restore");
        },
        async waitForHealth(): Promise<void> {},
      },
    } as unknown as Context;

    let stubThrew = false;
    await withOutputSink(
      () => {},
      async () => {
        try {
          await restoreArchive(stubCtx, STUB_ARCHIVE, { force: true });
        } catch {
          stubThrew = true;
        }
      },
    );

    check("a failure staged after a successful history import still fails the restore", stubThrew, true);
    check(
      "the ledger reverts to what it held before this restore, not the rejected entries",
      sorted(await persistedPrivatePaths()),
      sorted(baseline),
    );
  }
  });
} finally {
  await rm(deploymentA, { recursive: true, force: true }).catch(() => {});
  await rm(deploymentB, { recursive: true, force: true }).catch(() => {});
  await rm(recipesA, { recursive: true, force: true }).catch(() => {});
  await rm(recipesB, { recursive: true, force: true }).catch(() => {});
  if (transport !== undefined && PARENT !== undefined) await transport.remove(PARENT).catch(() => {});
  if (previousRecipes === undefined) clearRecipesDir();
  else useRecipesDir(previousRecipes);
  if (previousDeployment !== undefined) useDeployment(previousDeployment);
}

finish("private-history-restore");

// The privacy history (see docs/internal/review-2026-09-23-xxa-round-6.md) has TWO
// copies — the operator-side ledger at <deployment>/config/private-paths.json and the
// target-side copy at <dataDir>/config/clawwright-private-paths.json — and every reader that
// never publishes used to ask only the first one.
//
// A deployment folder pointed at already-existing target data — a lost or freshly
// recreated one, another machine adopting the same instance — reaches migrate or share with
// no restore and no full backup ever run, and built its exclusions from a record that was
// not there. createArchive() now reconciles the target copy into the ledger before the
// policy is read, and the forget became a state of the ledger's own protocol — tombstones
// — so "deliberately forgotten" and "history missing" can no longer be confused, including
// by a failed restore's rollback, which used to fabricate an empty ledger file (a witness
// to a forget nobody asked for) where none had existed.
//
// publishPrivatePathsHistory wrote the target copy through the private writer,
// which is an EXCLUSIVE create on every real transport — the second full backup died
// against the copy the first one had just written, and the republish after an adoption hit
// the same wall. It is now an atomic replace that skips the write when the bytes are
// already identical.
//
// Part A drives the tombstone protocol and reconcile against fake transports: the ledger
// and the target copy never meet a real filesystem, so every answer is the fake's and the
// assertions are about the protocol alone (adoption, suppression, the legacy-empty shape,
// the two loud refusals, the no-op). Part B pins the rollback's fidelity through
// restoreArchive with a stub transport whose staged failure lands exactly after a
// successful history import — absence must roll back to absence, a tombstone to itself.
// Part C drives the publish against a REAL LocalTransport, where the replace, the
// byte-identical skip and the old copy's survival of a failed write are the filesystem's
// own answers, not a fake's. Part D is the audit's own scenario end to end over a real
// POSIX filesystem and real GNU tar: a fresh operator folder straight to migrate/share
// against a target that carries its history, then two sequential full backups. Checks
// share one process, so the deployments and recipes roots this file selects are restored
// in the finally.

import { randomBytes } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { restoreArchive } from "#framework/commands/lifecycle/restore/index.ts";
import { parseWslDistroListing } from "#framework/commands/interface/host/contexts.ts";
import type { Context } from "#framework/core/context.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { deploymentDir, useDeployment } from "#framework/runtime/deployment.ts";
import { LocalTransport, spawnLocal, WslTransport, type Transport } from "#framework/runtime/transport/transport.ts";
import { createArchive, listArchive } from "#framework/service/archive/index.ts";
import { clearRecipesDir, installedRecipePrivatePaths, recipesDirectory, useRecipesDir } from "#framework/service/recipe.ts";
import {
  forgetPrivatePaths,
  persistedPrivatePaths,
  privatePathsHistoryFile,
  privatePathsLedgerFile,
  privatePathsLedgerState,
  publishPrivatePathsHistory,
  reconcilePrivatePathsHistory,
  recordPrivateWrite,
} from "#framework/security/privacy/private-paths-ledger.ts";
import { check, checkTrue, finish, requires } from "#checks/kit/harness.ts";
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

const sorted = (paths: readonly string[]): string => JSON.stringify([...paths].sort());

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

const previousRecipes = (() => {
  try { return recipesDirectory(); } catch { return undefined; }
})();
const previousDeployment = (() => {
  try { return deploymentDir(); } catch { return undefined; }
})();

const tag = randomBytes(4).toString("hex");
// Every local temporary this file creates — the Part A/B/C/D deployments, the Part D
// recipes root and the Part C publish tree — removed in the finally.
const temporaries: string[] = [];
/** A fresh operator-side deployment: scaffold.ts creates config/ for every real one, and
 *  the ledger's readers and writers are live only then. */
const freshDeployment = async (label: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), `clawwright-pp-reconcile-${label}-${tag}-`));
  await mkdir(join(directory, "config"), { recursive: true });
  temporaries.push(directory);
  return directory;
};

/** Whether the selected deployment's ledger file exists, without parsing it. */
const ledgerPresent = (): Promise<boolean> => access(privatePathsLedgerFile()).then(() => true, () => false);

/** The ledger file's JSON, for the assertions that pin its exact content. */
const ledgerJson = async (): Promise<{ privatePaths?: string[]; forgotten?: string[] }> =>
  JSON.parse(await readFile(privatePathsLedgerFile(), "utf8")) as { privatePaths?: string[]; forgotten?: string[] };

/** A fake target carrying at most one history copy, the way createArchive, reconcile and
 *  publish see it: exists() answers whether the copy is there, cat hands its bytes over (or
 *  fails with the given code), and every other command a probe could ask answers "writable,
 *  nothing to see here" — sudoFor's own probes never need to escalate against a fake. */
const fakeTargetCtx = (body: string | undefined, catCode = 0): Context =>
  ({
    settings: { dataDir: "/tgt/data", env: {} },
    transport: {
      async exists(): Promise<boolean> { return body !== undefined; },
      async remove(): Promise<void> {},
      async mkdirp(): Promise<void> {},
      async writeFile(): Promise<void> {},
      async writePrivateFile(): Promise<void> {},
      async exec(command: string): Promise<{ code: number; stdout: string; stderr: string }> {
        if (command === "cat") {
          return catCode === 0
            ? { code: 0, stdout: body ?? "", stderr: "" }
            : { code: catCode, stdout: "", stderr: "cat failed" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  }) as unknown as Context;

let transport: Transport | undefined;
let PARENT: string | undefined;

try {
  // === PART A — the tombstone protocol and reconcile, against fake transports ============

  // --- A1 — the forget writes a tombstone; only the forget writes one ---------------------
  // The recorded entry is the written path itself, so the tombstone below names exactly it
  // and the ledger's two arrays stay disjoint — the shape readLedgerPayload validates.
  {
    useDeployment(await freshDeployment("a1"));
    await recordPrivateWrite("vault/credentials.env");
    await forgetPrivatePaths(["vault/credentials.env"]);
    check("a forgotten path leaves the recorded set", sorted(await persistedPrivatePaths()), "[]");
    const forgotten1 = await ledgerJson();
    check("and the tombstone is written beside the now-empty record", sorted(forgotten1.forgotten ?? []), JSON.stringify(["vault/credentials.env"]));
    check("the record half is empty", sorted(forgotten1.privatePaths ?? []), "[]");
    checkTrue("the forget is a state of the file, not of a missing one", (await privatePathsLedgerState()).existed);

    // A deployment whose ledger file was never written stays absent: absence is the honest
    // "nothing recorded here", and a forget against it has nothing to drop.
    useDeployment(await freshDeployment("a1-absent"));
    await forgetPrivatePaths(["x"]);
    check("a forget against a never-written ledger writes no file", await ledgerPresent(), false);
  }

  // --- A2 — a write after a forget clears its tombstone -----------------------------------
  {
    useDeployment(await freshDeployment("a2"));
    await recordPrivateWrite("vault/credentials.env", "vault");
    await forgetPrivatePaths(["vault/credentials.env"]);
    // The data is back: the same private write is recorded again, and the tombstone no
    // longer describes reality.
    await recordPrivateWrite("vault/credentials.env", "vault");
    const rerecorded = await ledgerJson();
    check("a write after a forget carries no tombstone anymore", sorted(rerecorded.forgotten ?? []), "[]");
    check("and the path is recorded again, with its declared boundary", sorted(await persistedPrivatePaths()), sorted(["vault", "vault/credentials.env"]));
  }

  // --- A3 — reconcile adopts a target-only history and is then a no-op ---------------------
  {
    useDeployment(await freshDeployment("a3"));
    const adopted = ["orphan-private", "orphan-private/secret.env"];
    const targetBody = `${JSON.stringify({ privatePaths: adopted })}\n`;
    await reconcilePrivatePathsHistory(fakeTargetCtx(targetBody));
    check("reconcile adopts a target-only history into a ledger that had none", sorted(await persistedPrivatePaths()), sorted(adopted));
    checkTrue("the adoption actually wrote the ledger file", await ledgerPresent());
    const afterFirst = await readFile(privatePathsLedgerFile(), "utf8");
    await reconcilePrivatePathsHistory(fakeTargetCtx(targetBody));
    check("a second reconcile leaves the ledger byte-identical", await readFile(privatePathsLedgerFile(), "utf8"), afterFirst);
  }

  // --- A4 — tombstones suppress resurrection ----------------------------------------------
  {
    useDeployment(await freshDeployment("a4"));
    await writeFile(
      privatePathsLedgerFile(),
      `${JSON.stringify({ privatePaths: ["kept"], forgotten: ["orphan-private"] }, null, 2)}\n`,
      "utf8",
    );
    await reconcilePrivatePathsHistory(
      fakeTargetCtx(`${JSON.stringify({ privatePaths: ["orphan-private", "kept", "new-private"] })}\n`),
    );
    check("reconcile unions the target history with the ledger's own entries", sorted(await persistedPrivatePaths()), sorted(["kept", "new-private"]));
    const suppressed = await ledgerJson();
    check("a deliberately forgotten path is not resurrected by the target", sorted(suppressed.forgotten ?? []), JSON.stringify(["orphan-private"]));
  }

  // --- A5 — the legacy empty ledger is honored as the forget it can only be -----------------
  {
    useDeployment(await freshDeployment("a5"));
    // The pre-tombstone shape: written, empty, no tombstones. Only an old-protocol forget
    // ever wrote it, so it is honored rather than adopted into.
    const legacy = `${JSON.stringify({ privatePaths: [] })}\n`;
    await writeFile(privatePathsLedgerFile(), legacy, "utf8");
    await reconcilePrivatePathsHistory(fakeTargetCtx(`${JSON.stringify({ privatePaths: ["orphan-private"] })}\n`));
    check("a legacy empty ledger is honored as a forget", sorted(await persistedPrivatePaths()), "[]");
    check("and it is left exactly as it was", await readFile(privatePathsLedgerFile(), "utf8"), legacy);
  }

  // --- A6 — a copy that cannot be read or parsed refuses loudly, writing nothing -----------
  {
    useDeployment(await freshDeployment("a6"));
    await recordPrivateWrite("vault/keeps.env", "vault");
    const before = sorted(await persistedPrivatePaths());
    const parseRefusal = await rejectionOf(() => reconcilePrivatePathsHistory(fakeTargetCtx("{ not json")));
    checkTrue("a target copy that cannot be parsed refuses the reconcile", /could not parse/.test(parseRefusal ?? ""));
    check("and the refusal wrote nothing", sorted(await persistedPrivatePaths()), before);
    const readRefusal = await rejectionOf(() => reconcilePrivatePathsHistory(fakeTargetCtx("unreadable", 1)));
    checkTrue("a target copy that cannot be read refuses the reconcile", /could not read the existing privacy history/.test(readRefusal ?? ""));
    check("and that refusal wrote nothing either", sorted(await persistedPrivatePaths()), before);
  }

  // --- A7 — no target copy is a no-op, not a fabricated ledger ------------------------------
  {
    useDeployment(await freshDeployment("a7"));
    await reconcilePrivatePathsHistory(fakeTargetCtx(undefined));
    check("with no target copy, reconcile creates no ledger file", await ledgerPresent(), false);
  }

  // === PART B — a failed restore's rollback restores the ledger's state, absence included =

  // The same stub shape private-history-restore.check.ts Part C pins with: the history
  // import really succeeds (cat hands over a valid payload), and the staged failure is
  // ensureDataDirs' own chmod on auth-secrets — a point AFTER the import, which no real
  // archive can trigger on demand. DATA is synthetic: nothing here touches a filesystem.
  const STUB_DATA_DIR = "/synthetic/pp-reconcile-rollback/data";
  const STUB_PARENT = "/synthetic/pp-reconcile-rollback";
  const STUB_ARCHIVE = `${STUB_PARENT}/backups/pp-reconcile-rollback.tar.gz`;
  const RESTORED_ONLY = ["restored-only"];
  const rollbackStubCtx = (): Context =>
    ({
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
          if (command === "cat") return { code: 0, stdout: `${JSON.stringify({ privatePaths: RESTORED_ONLY })}\n`, stderr: "" };
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
        async stop(): Promise<void> {},
        async start(): Promise<void> {
          throw new Error("the gateway must never start from this restore");
        },
        async waitForHealth(): Promise<void> {},
      },
    }) as unknown as Context;
  const runStagedFailureRestore = async (): Promise<boolean> => {
    let threw = false;
    await withOutputSink(
      () => {},
      async () => {
        try {
          await restoreArchive(rollbackStubCtx(), STUB_ARCHIVE, { force: true });
        } catch {
          threw = true;
        }
      },
    );
    return threw;
  };

  // Absence is preserved as absence: the old rollback wrote an empty ledger file here,
  // a false witness to a forget the operator never asked for — and a fresh ledger would
  // then have read as "deliberately empty" to the next publish or reconcile.
  {
    useDeployment(await freshDeployment("b1"));
    check("this deployment's ledger starts absent", await ledgerPresent(), false);
    checkTrue("the staged failure fails the restore", await runStagedFailureRestore());
    check("and the ledger file is still absent afterwards", await ledgerPresent(), false);
    check("nothing was recorded out of the failed restore", sorted(await persistedPrivatePaths()), "[]");
    // Absence is an adoptable state, not a forget: a target that still remembers the path
    // must still be able to teach this deployment about it.
    await reconcilePrivatePathsHistory(fakeTargetCtx(`${JSON.stringify({ privatePaths: RESTORED_ONLY })}\n`));
    check("a preserved absence still adopts the target's history", sorted(await persistedPrivatePaths()), sorted(RESTORED_ONLY));
  }

  // A deliberate forget survives the same rollback: the import resurrects the path the
  // tombstone names (an archive that brings the data back supersedes the forget), and the
  // rollback must put that tombstone back, or the rejected archive's entry survives.
  {
    useDeployment(await freshDeployment("b2"));
    const tombstoned = `${JSON.stringify({ privatePaths: [], forgotten: RESTORED_ONLY }, null, 2)}\n`;
    await writeFile(privatePathsLedgerFile(), tombstoned, "utf8");
    checkTrue("the staged failure fails this restore too", await runStagedFailureRestore());
    check("the rollback restored the tombstone state exactly", await readFile(privatePathsLedgerFile(), "utf8"), tombstoned);
    await reconcilePrivatePathsHistory(fakeTargetCtx(`${JSON.stringify({ privatePaths: RESTORED_ONLY })}\n`));
    check("the deliberate forget survives the reconcile", sorted(await persistedPrivatePaths()), "[]");
    const afterReconcile = await ledgerJson();
    check("and the tombstone still names the forgotten path", sorted(afterReconcile.forgotten ?? []), JSON.stringify(RESTORED_ONLY));
  }

  // === PART C — publish is an atomic replace, against a real LocalTransport ===============

  const base = await mkdtemp(join(tmpdir(), `clawwright-pp-reconcile-publish-${tag}-`));
  temporaries.push(base);
  // POSIX-style: the published copy is read back through the same names the transport used.
  const DATA_C = `${base.split(sep).join("/")}/data`;
  useDeployment(await freshDeployment("c1"));
  await recordPrivateWrite("vault/credentials.env", "vault");
  const local = new LocalTransport();
  const realWrite = local.writeFile.bind(local);
  let writeCount = 0;
  (local as { writeFile: typeof local.writeFile }).writeFile = async (path, content, mode) => {
    writeCount += 1;
    await realWrite(path, content, mode);
  };
  const publishCtx = { settings: { dataDir: DATA_C, env: {} }, transport: local } as unknown as Context;
  const historyPath = privatePathsHistoryFile(DATA_C);
  const CANONICAL = `${JSON.stringify({ privatePaths: ["vault", "vault/credentials.env"] }, null, 2)}\n`;

  await publishPrivatePathsHistory(publishCtx);
  checkTrue("the first publish creates the history copy", await access(historyPath).then(() => true, () => false));
  check("and it holds exactly the canonical bytes", await readFile(historyPath, "utf8"), CANONICAL);
  check("through exactly one write", writeCount, 1);

  let secondPublishFailed = false;
  try {
    await publishPrivatePathsHistory(publishCtx);
  } catch {
    secondPublishFailed = true;
  }
  check("a second publish resolves against the copy the first one wrote", secondPublishFailed, false);
  check("it left those bytes alone", await readFile(historyPath, "utf8"), CANONICAL);
  check("and it did not write again", writeCount, 1);

  // The exclusive-create contract publish no longer uses, pinned against the real writer:
  // the old copy's presence is what made every second full backup die.
  const exclusive = await rejectionOf(async () => {
    await local.writePrivateFile?.(historyPath, "x");
  });
  checkTrue("the real private writer still refuses an existing name", exclusive !== undefined && /EEXIST|already exists/.test(exclusive));

  await recordPrivateWrite("vault/state", "vault");
  let changedPublishFailed = false;
  try {
    await publishPrivatePathsHistory(publishCtx);
  } catch {
    changedPublishFailed = true;
  }
  check("a publish of changed content replaces the copy instead of dying on it", changedPublishFailed, false);
  check("through a second write", writeCount, 2);
  checkTrue("and the copy now carries the newly recorded path", (await readFile(historyPath, "utf8")).includes("vault/state"));
  const afterReplace = await readFile(historyPath, "utf8");

  // A fresh deployment folder adopting the same target: the ledger was never written here,
  // so publish adopts what the target holds and republishes — but those bytes are already
  // canonical, so the republish must write nothing.
  useDeployment(await freshDeployment("c2"));
  await publishPrivatePathsHistory(publishCtx);
  check("the fresh deployment adopted the target copy into its own ledger", sorted(await persistedPrivatePaths()), sorted(["vault", "vault/credentials.env", "vault/state"]));
  check("the adoption's republish wrote nothing new", writeCount, 2);
  check("and the copy's bytes are unchanged", await readFile(historyPath, "utf8"), afterReplace);

  // A failed publish must never destroy the old history: the replace stages a sibling and
  // renames, so a write that cannot land leaves the previous copy exactly where it was.
  await requires("posix-modes", "the read-only-config publish refusal (POSIX permission bits only)", async () => {
    await recordPrivateWrite("vault/extra.env", "vault");
    const beforeLock = await readFile(historyPath, "utf8");
    await chmod(`${DATA_C}/config`, 0o500);
    let lockedPublishFailed = false;
    try {
      await publishPrivatePathsHistory(publishCtx);
    } catch {
      lockedPublishFailed = true;
    }
    checkTrue("a publish onto a read-only config directory refuses", lockedPublishFailed);
    check("and the previous history survives the refusal", await readFile(historyPath, "utf8"), beforeLock);
    await chmod(`${DATA_C}/config`, 0o700);
    let finalPublishFailed = false;
    try {
      await publishPrivatePathsHistory(publishCtx);
    } catch {
      finalPublishFailed = true;
    }
    check("restoring the directory's mode lets the publish land", finalPublishFailed, false);
    checkTrue("with the newly recorded path in it", (await readFile(historyPath, "utf8")).includes("vault/extra.env"));
    check("and the published copy is owner-only", (await stat(historyPath)).mode & 0o777, 0o600);
  });

  // === PART D — the audit's scenario: a fresh folder straight to migrate/share ============
  //
  // A target that already exists, already holds private files, and already carries its own
  // history copy — written by an earlier full backup from some other deployment. No restore
  // and no full backup has ever run on THIS operator side. The ledger is empty, no recipe
  // declares anything, and the next command is migrate or share anyway.

  await requires("local-posix", "the fresh-folder reconcile scenario", async () => {
  transport = await realPosixTransport();
  if (transport === undefined) {
    skip("the fresh-folder reconcile scenario (no local POSIX filesystem and no WSL distribution with a shell)");
  } else {
    PARENT = `/tmp/clawwright-pp-reconcile-${tag}`;
    const DATA = `${PARENT}/data`;
    const ARCHIVES = `${PARENT}/archives`;
    const TARGET_HISTORY = ["sidecar-private", "sidecar-private/credentials.env"];

    await transport.mkdirp(`${DATA}/config`);
    await transport.mkdirp(`${DATA}/sidecar-private`);
    await transport.mkdirp(ARCHIVES);
    await transport.writeFile(`${DATA}/config/openclaw.json`, JSON.stringify({ models: { providers: {} } }));
    await transport.writeFile(`${DATA}/sidecar-private/credentials.env`, "target-only credentials\n");
    // The only surviving record of this instance's private paths: a history copy no
    // deployment here has ever read, in the exact canonical bytes a full backup publishes.
    await transport.writeFile(
      `${DATA}/config/clawwright-private-paths.json`,
      `${JSON.stringify({ privatePaths: TARGET_HISTORY }, null, 2)}\n`,
    );

    const deploymentH = await freshDeployment("d1");
    const recipesH = await mkdtemp(join(tmpdir(), `clawwright-pp-reconcile-recipes-${tag}-`));
    temporaries.push(recipesH);
    useDeployment(deploymentH);
    // A recipe set that declares nothing: the audit's precondition, verbatim.
    useRecipesDir(recipesH);

    check("before any archive, the policy is blind to target-only history", sorted(await installedRecipePrivatePaths()), "[]");

    const ctx = { settings: { dataDir: DATA, env: {} }, transport } as unknown as Context;

    // The share straight from the fresh folder: the reconcile at the head of createArchive
    // is the ONLY thing that can tell this deployment what the target still remembers.
    const shareFresh = `${ARCHIVES}/share-fresh.tar.gz`;
    await createArchive(ctx, { archive: shareFresh, profile: "share" });
    const shareEntries = await listArchive(ctx, shareFresh);
    check("a share straight from the fresh folder leaves the private file out", shareEntries.includes("data/sidecar-private/credentials.env"), false);
    check("the reconcile adopted the target's history into the ledger", sorted(await persistedPrivatePaths()), sorted(TARGET_HISTORY));
    check("and the policy now excludes what the target alone remembered", sorted(await installedRecipePrivatePaths()), sorted(TARGET_HISTORY));

    const migrateFresh = `${ARCHIVES}/migrate-fresh.tar.gz`;
    await createArchive(ctx, { archive: migrateFresh, profile: "migrate" });
    const migrateEntries = await listArchive(ctx, migrateFresh);
    check("a migrate straight from the fresh folder leaves the private file out", migrateEntries.includes("data/sidecar-private/credentials.env"), false);

    // Two sequential full backups: the first carries the history physically (the copy is
    // already canonical, so its publish writes nothing), the second — with a newly recorded
    // path — used to die exclusive-creating the copy the first had just written.
    const fullFresh = `${ARCHIVES}/full-fresh.tar.gz`;
    await createArchive(ctx, { archive: fullFresh, profile: "full" });
    const fullEntries = await listArchive(ctx, fullFresh);
    checkTrue("the first full backup keeps the private file", fullEntries.includes("data/sidecar-private/credentials.env"));
    checkTrue("and it carries the privacy history physically", fullEntries.includes("data/config/clawwright-private-paths.json"));

    await recordPrivateWrite("vault/extra.env", "vault");
    const fullFreshAgain = `${ARCHIVES}/full-fresh-again.tar.gz`;
    let secondFullFailed = false;
    try {
      await createArchive(ctx, { archive: fullFreshAgain, profile: "full" });
    } catch {
      secondFullFailed = true;
    }
    check("a second full backup resolves against the existing history copy", secondFullFailed, false);
    const publishedCopy = await transport.readFile(`${DATA}/config/clawwright-private-paths.json`);
    checkTrue("its replace actually landed", publishedCopy.includes("vault/extra.env"));
    checkTrue("and the second full still carries the history copy", (await listArchive(ctx, fullFreshAgain)).includes("data/config/clawwright-private-paths.json"));
  }
  });
} finally {
  for (const directory of temporaries) await rm(directory, { recursive: true, force: true }).catch(() => {});
  if (transport !== undefined && PARENT !== undefined) await transport.remove(PARENT).catch(() => {});
  if (previousRecipes === undefined) clearRecipesDir();
  else useRecipesDir(previousRecipes);
  if (previousDeployment !== undefined) useDeployment(previousDeployment);
}

finish("private-paths-history reconcile");

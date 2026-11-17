// Full backup and isolated restore preserve live instance state and private bytes.

import { locksDir } from "#framework/core/env.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";
import { checks } from "#framework/commands/lifecycle/smoke/index.ts";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useDeployment, deploymentDir } from "#framework/runtime/deployment.ts";
import { deploymentName } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { parseBackupArchive } from "#framework/service/archive/index.ts";
import { recordPrivateWrite } from "#framework/security/privacy/private-paths-ledger.ts";
import { installedRecipePrivatePaths } from "#framework/service/recipe.ts";
import { createHash } from "node:crypto";
import { check, finish } from "#checks/kit/harness.ts";
import { asDirectTest } from "#checks/runtime/service/restore/file-test-stub.ts";

// --- full backup restored into an isolated root, preserving live state -----------------------
// The modeled tar snapshots files at archive time and replays those bytes at extraction.

{
  const PARENT = "/srv/openclaw";
  const DATA_DIR = `${PARENT}/data`;
  const BACKUP_DIR = `${PARENT}/backups`;
  const MARKER = `${DATA_DIR}/workspace/SMOKE-MARKER.md`;
  const EXISTING_MARKER = "user-owned marker must survive\n";
  const PRIVATE_RELATIVE = "workspace/private-vault";
  const PRIVATE_FILE = `${DATA_DIR}/${PRIVATE_RELATIVE}/credentials.env`;
  const BINARY_FILE = `${DATA_DIR}/${PRIVATE_RELATIVE}/opaque.bin`;
  const SECRET_CONTENT = "generated-credential-bytes\n";
  const BINARY_CONTENT = "\u0000\u00ff\u0080\n";
  const LOCK_PATH = `${locksDir(DATA_DIR)}/operation.lock`;
  const MUTATION_GUARD = `${locksDir(DATA_DIR)}/operation.mutation`;

  /** Everything below runs with a disposable deployment directory selected. */
  async function withRecordedPrivatePath<T>(body: () => Promise<T>, record = true): Promise<T> {
    const root = await mkdtemp(join(tmpdir(), "clawwright-smoke-roundtrip-"));
    let previous: string | undefined;
    try { previous = deploymentDir(); } catch { /* no deployment selected in this check */ }
    try {
      await mkdir(join(root, "config"), { recursive: true });
      useDeployment(root);
      if (record) await recordPrivateWrite(PRIVATE_RELATIVE);
      return await body();
    } finally {
      if (previous === undefined) useDeployment(root);
      else useDeployment(previous);
      await rm(root, { recursive: true, force: true });
    }
  }

  /** Keeps removed bytes available for assertions about the isolated restore. */
  class InstanceFiles extends Map<string, string> {
    private readonly removedContent = new Map<string, string>();

    override delete(path: string): boolean {
      const content = super.get(path);
      if (content !== undefined) this.removedContent.set(path, content);
      return super.delete(path);
    }

    override get(path: string): string | undefined {
      return super.get(path) ?? this.removedContent.get(path);
    }
  }

  interface RoundTripOptions {
    initialRunning?: boolean;
    failBackup?: boolean;
    failRestore?: boolean;
    failIsRunning?: boolean;
    missingConfig?: boolean;
    omitConfigFromSnapshot?: boolean;
    corruptConfigOnRestore?: boolean;
  }

  function roundTripContext(options: RoundTripOptions = {}): {
    ctx: Context;
    files: Map<string, string>;
    events: string[];
    lock: () => boolean;
    running: () => boolean;
    restoredRoots: () => string[];
    publishedBackups: () => string[];
  } {
    const files = new InstanceFiles();
    const events: string[] = [];
    const restoreRoots: string[] = [];
    const backups: string[] = [];
    let lockExists = false;
    let mutationGuardExists = false;
    let runningNow = options.initialRunning === true;
    let snapshot: Map<string, string> | undefined;

    if (options.missingConfig !== true) files.set(`${DATA_DIR}/config/openclaw.json`, "{}\n");
    files.set(`${DATA_DIR}/config/.env`, "OPENAI_API_KEY=x\n");
    files.set(PRIVATE_FILE, SECRET_CONTENT);
    files.set(BINARY_FILE, BINARY_CONTENT);
    files.set(MARKER, EXISTING_MARKER);

    const present = (path: string): boolean => {
      if (files.has(path)) return true;
      for (const known of files.keys()) if (known.startsWith(`${path}/`)) return true;
      return path === DATA_DIR;
    };

    const transport = {
      description: "round-trip-stub",
      async exists(path: string): Promise<boolean> {
        return present(path);
      },
      async readFile(path: string): Promise<string> {
        const content = files.get(path);
        if (content === undefined) throw new Error(`no such file: ${path}`);
        return content;
      },
      async writeFile(path: string, content: string): Promise<void> {
        events.push(`write:${path}`);
        files.set(path, content);
      },
      async remove(path: string): Promise<void> {
        if (path === LOCK_PATH) lockExists = false;
        if (path === MUTATION_GUARD) mutationGuardExists = false;
        files.delete(path);
      },
      async listFiles(path: string): Promise<string[]> {
        const prefix = `${path}/`;
        return [...files.keys()].filter((entry) => entry.startsWith(prefix)).map((entry) => entry.slice(prefix.length));
      },
      async mkdirp(): Promise<void> {},
      async exec(rawCommand: string, rawArgs: string[]): Promise<ExecResult> {
        const { command, args } = asDirectTest(rawCommand, rawArgs);
        events.push(`${command}:${args.join(" ")}`);
        if (command === "mkdir" && args[0] === MUTATION_GUARD) {
          if (mutationGuardExists) return { code: 1, stdout: "", stderr: "File exists" };
          mutationGuardExists = true;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "mkdir" && args[0] === LOCK_PATH) {
          // The bare mkdir claims the instance lock.
          if (lockExists) return { code: 1, stdout: "", stderr: "File exists" };
          lockExists = true;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "ln") {
          const [source, destination] = args;
          if (source === undefined || destination === undefined || !files.has(source)) return { code: 1, stdout: "", stderr: "No such file" };
          if (files.has(destination)) return { code: 1, stdout: "", stderr: "File exists" };
          files.set(destination, files.get(source)!);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "test" && args[0] === "-d") {
          const path = args[1] ?? "";
          return { code: path === LOCK_PATH ? Number(lockExists) : path === MUTATION_GUARD ? Number(mutationGuardExists) : 1, stdout: "", stderr: "" };
        }
        if (command === "test" && args[0] === "-w") return { code: 0, stdout: "", stderr: "" };
        if (command === "test" && args[0] === "-x") return { code: 0, stdout: "", stderr: "" };
        if (command === "test" && args[0] === "-L") return { code: 1, stdout: "", stderr: "" };
        if (command === "test" && args[0] === "-e") return { code: present(args[1] ?? "") ? 0 : 1, stdout: "", stderr: "" };
        // Release removes the empty lock directory.
        if (command === "rmdir") {
          if (args[0] === LOCK_PATH) lockExists = false;
          if (args[0] === MUTATION_GUARD) mutationGuardExists = false;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "readlink" && args[0] === "-f") return { code: 0, stdout: args[1] ?? "", stderr: "" };
        if (command === "stat" && args[1] === "%u:%g") return { code: 0, stdout: "1000:1000", stderr: "" };
        if (command === "stat" && args[1] === "%a") return { code: 0, stdout: "700", stderr: "" };
        if (command === "cat") {
          const content = files.get(args[0] ?? "");
          return content === undefined
            ? { code: 1, stdout: "", stderr: `cat: ${args[0]}: No such file` }
            : { code: 0, stdout: content, stderr: "" };
        }
        if (command === "bash" && args.some((arg) => arg.includes("sha256sum"))) {
          const name = args[args.length - 1] ?? "";
          const parent = args[args.length - 2] ?? "";
          const root = `${parent}/${name}`;
          const digest = createHash("sha256");
          const entries = [...files]
            .filter(([path]) => path === root || path.startsWith(`${root}/`))
            .sort(([left], [right]) => left.localeCompare(right));
          digest.update(`${name}\0`);
          for (const [path, content] of entries) {
            const relative = path === root ? "" : path.slice(root.length + 1);
            digest.update(`${relative}\0${content}\0`);
          }
          return { code: 0, stdout: `${digest.digest("hex")}  -\n`, stderr: "" };
        }
        if (command === "cp") {
          const source = args[args.length - 2] ?? "";
          const destination = args[args.length - 1] ?? "";
          files.set(destination, files.get(source) ?? "");
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "mv") {
          const source = args[args.length - 2] ?? "";
          const destination = args[args.length - 1] ?? "";
          if (files.has(source)) {
            if (options.failBackup === true && destination.startsWith(`${BACKUP_DIR}/`) && destination.endsWith(".tar.gz")) {
              return { code: 1, stdout: "", stderr: "publish failed" };
            }
            if (files.has(destination)) return { code: 1, stdout: "", stderr: "File exists" };
            files.set(destination, files.get(source) ?? "");
            files.delete(source);
            if (destination.startsWith(`${BACKUP_DIR}/`) && destination.endsWith(".tar.gz")) backups.push(destination);
            return { code: 0, stdout: "", stderr: "" };
          }
          if (options.failBackup === true && destination.startsWith(`${BACKUP_DIR}/`) && destination.endsWith(".tar.gz")) {
            return { code: 1, stdout: "", stderr: "publish failed" };
          }
          files.set(destination, files.get(source) ?? "");
          files.delete(source);
          // Only the final rename makes this a published backup.
          if (destination.startsWith(`${BACKUP_DIR}/`) && destination.endsWith(".tar.gz")) backups.push(destination);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "rm") {
          for (const arg of args.filter((value) => !value.startsWith("-"))) {
            if (arg === LOCK_PATH) lockExists = false;
            if (arg === MUTATION_GUARD) mutationGuardExists = false;
            for (const path of files.keys()) if (path === arg || path.startsWith(`${arg}/`)) files.delete(path);
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "tar" && args.includes("-czf")) {
          const archive = args[args.indexOf("-czf") + 1] ?? "";
          // What the backup captures is what the data directory holds NOW.
          snapshot = new Map(
            [...files].filter(([path]) =>
              path.startsWith(`${DATA_DIR}/`) && !(options.omitConfigFromSnapshot === true && path === `${DATA_DIR}/config/openclaw.json`),
            ),
          );
          files.set(archive, "archive\n");
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "tar" && args.includes("-tzf")) {
          const name = DATA_DIR.slice(DATA_DIR.lastIndexOf("/") + 1);
          const entries = [
            `${name}/`,
            ...[...(snapshot?.keys() ?? [])].map((path) => `${name}/${path.slice(DATA_DIR.length + 1)}`),
          ].sort();
          return { code: 0, stdout: `${entries.join("\n")}\n`, stderr: "" };
        }
        if (command === "tar" && args.includes("-tvzf")) {
          const name = DATA_DIR.slice(DATA_DIR.lastIndexOf("/") + 1);
          const rows = [`drwxr-xr-x user/user 0 2026-01-01 00:00 ${name}/`];
          for (const path of snapshot?.keys() ?? []) {
            rows.push(`-rw-r--r-- user/user 6 2026-01-01 00:00 ${name}/${path.slice(DATA_DIR.length + 1)}`);
          }
          return { code: 0, stdout: `${rows.join("\n")}\n`, stderr: "" };
        }
        if (command === "tar" && args.includes("-xzf")) {
          if (options.failRestore === true) throw new Error("simulated extraction failure");
          const destination = args[args.indexOf("-C") + 1] ?? "";
          const name = DATA_DIR.slice(DATA_DIR.lastIndexOf("/") + 1);
          for (const [path, content] of snapshot ?? []) {
            const relative = path.slice(DATA_DIR.length + 1);
            const restoredContent = options.corruptConfigOnRestore === true && relative === "config/openclaw.json" ? `${content}corrupted` : content;
            files.set(`${destination}/${name}/${relative}`, restoredContent);
          }
          restoreRoots.push(`${destination}/${name}`);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "sh" && args.some((arg) => arg.includes("ls -1t"))) {
          const matching = [...files.keys()].filter((path) => {
            if (!path.startsWith(`${BACKUP_DIR}/`) || !path.endsWith(".tar.gz")) return false;
            return parseBackupArchive(path.slice(path.lastIndexOf("/") + 1), deploymentName()) !== undefined;
          });
          return { code: 0, stdout: `${matching.join("\n")}\n`, stderr: "" };
        }
        if (command === "du") return { code: 0, stdout: "1K\tarchive\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    };

    const runtime = {
      async isRunning(): Promise<boolean> {
        if (options.failIsRunning === true) throw new Error("docker unreachable");
        return runningNow;
      },
      async pause(): Promise<void> {
        events.push("runtime:pause");
        runningNow = false;
      },
      async start(): Promise<void> {
        events.push("runtime:start");
        runningNow = true;
      },
      async stop(): Promise<void> {
        events.push("runtime:stop");
        runningNow = false;
      },
      async waitForHealth(): Promise<void> {
        events.push("runtime:waitForHealth");
      },
      stack() {
        return {
          async isRunning(): Promise<boolean> { return false; },
        };
      },
    };

    return {
      ctx: {
        settings: { dataDir: DATA_DIR, backupDir: BACKUP_DIR, snapshotDir: `${PARENT}/snapshots`, env: {} },
        transport,
        runtime,
        paths: { toContainer: (path: string) => path },
      } as unknown as Context,
      files,
      events,
      lock: () => lockExists,
      running: () => runningNow,
      restoredRoots: () => restoreRoots,
      publishedBackups: () => backups,
    };
  }

  /** Every bare `mkdir <lockPath>` is a real, separate acquisition of the instance lock —
   *  the claim-marker and lock-home mkdirs both carry flags and never match this shape (see
   *  instance-lock.ts's claimDirectory). One outer lock covering the whole transaction means
   *  exactly one of these; createBackup()'s own guardedWith() finds the lock already held on its
   *  async chain and is a no-op. */
  function lockAcquisitions(events: string[]): number {
    return events.filter((event) => event === `mkdir:${LOCK_PATH}`).length;
  }

  const roundTrip = checks.find((entry) => entry.name === "snapshot round-trip is byte-identical");
  if (roundTrip === undefined) throw new Error("smoke.ts no longer has the round-trip check under its documented name");

  const runRoundTrip = async (ctx: Context): Promise<{ threw: boolean; message: string }> => {
    try {
      await withOutputSink(() => {}, () => roundTrip.run(ctx));
      return { threw: false, message: "" };
    } catch (error) {
      return { threw: true, message: error instanceof Error ? error.message : String(error) };
    }
  };

  await withRecordedPrivatePath(async () => {
    const runtimeEvents = (events: string[]): string[] => events.filter((event) => event.startsWith("runtime:"));
    const litterLeft = (files: Map<string, string>): boolean =>
      [...files.keys()].some((path) => path.includes(".clawwright-smoke-roundtrip-"));
    // A plain `.includes(DATA_DIR)` would also match the lock's own sibling directory
    // (`${DATA_DIR}-locks`, see core/env.ts's locksDir) — the instance lock's release now
    // moves its own generation marker within that directory, which is an
    // `mv:` event but not a move of the data root. Only an exact arg, or a path properly
    // rooted under it, counts.
    const movedDataDir = (events: string[]): boolean =>
      events.some(
        (event) =>
          event.startsWith("mv:")
          && event.slice(3).split(" ").some((arg) => arg === DATA_DIR || arg.startsWith(`${DATA_DIR}/`)),
      );

    // Success from a running gateway: paused for the consistent snapshot, back up at the
    // very end. The private subtree and the marker come back byte-identical inside the
    // isolated root; the live root is never moved aside; the full backup is the only thing
    // published, and the scratch root leaves with the check.
    {
      const { ctx, files, events, lock, running, restoredRoots, publishedBackups } = roundTripContext({ initialRunning: true });
      const outcome = await runRoundTrip(ctx);

      check("a clean round trip from a running gateway does not throw", outcome.threw, false);
      check("the gateway was paused for the backup and started again at the very end", runtimeEvents(events), ["runtime:pause", "runtime:start", "runtime:waitForHealth"]);
      check("the gateway ended the check as it began: running", running(), true);
      check("the lock was acquired exactly once for the whole transaction", lockAcquisitions(events), 1);
      check("the lock was released by the time the check returns", lock(), false);
      check("the check published a full backup, not a migrate snapshot", publishedBackups().map((path) => parseBackupArchive(path.slice(path.lastIndexOf("/") + 1), deploymentName())?.profile), ["full"]);
      check("no pull-style snapshot was published", events.some((event) => event.includes("-state-")), false);
      check("the live data root was never moved aside", movedDataDir(events), false);
      check("the live private file is untouched", files.get(PRIVATE_FILE), SECRET_CONTENT);
      check("the private directory's file survived the isolated restore byte-identically", restoredRoots().map((root) => files.get(`${root}/${PRIVATE_FILE.slice(DATA_DIR.length + 1)}`)), [SECRET_CONTENT]);
      check("binary bytes below the private directory survive unchanged", restoredRoots().map((root) => files.get(`${root}/${BINARY_FILE.slice(DATA_DIR.length + 1)}`)), [BINARY_CONTENT]);
      check("a pre-existing same-name user file survives unchanged", files.get(MARKER), EXISTING_MARKER);
      check("the same-name user file is preserved in the isolated restore", restoredRoots().map((root) => files.get(`${root}/workspace/SMOKE-MARKER.md`)), [EXISTING_MARKER]);
      check("smoke never writes or removes its former fixed marker path", events.some((event) => (event.startsWith("write:") || event.startsWith("rm:")) && event.includes(MARKER)), false);
      check("the scratch root left no litter behind", litterLeft(files), false);
    }

    // Success from a stopped gateway: nothing may start it — not the backup (it never
    // pauses a stopped gateway), not the restore (noStart), not the compensation.
    {
      const { ctx, files, events, running, restoredRoots } = roundTripContext({ initialRunning: false });
      const outcome = await runRoundTrip(ctx);

      check("a clean round trip from a stopped gateway does not throw", outcome.threw, false);
      check("a stopped gateway was never started, not even on success", runtimeEvents(events), []);
      check("and it ended the check stopped, as it began", running(), false);
      check("the private directory's file still survived the isolated restore", restoredRoots().map((root) => files.get(`${root}/${PRIVATE_FILE.slice(DATA_DIR.length + 1)}`)), [SECRET_CONTENT]);
      check("binary bytes below the private directory still survive unchanged", restoredRoots().map((root) => files.get(`${root}/${BINARY_FILE.slice(DATA_DIR.length + 1)}`)), [BINARY_CONTENT]);
      check("the live data root was still never moved aside", movedDataDir(events), false);
    }

    // Failure in every stage, from both initial states. The contract: the check
    // fails, the scratch root is still cleaned up, and the gateway always ends
    // in its initial state — started back up only when it was running before, never
    // started when it was not.
    for (const stage of ["failBackup", "failRestore"] as const) {
      for (const initialRunning of [true, false]) {
        const { ctx, files, events, lock, running, restoredRoots } = roundTripContext({ initialRunning, [stage]: true });
        const outcome = await runRoundTrip(ctx);

        const stageName = stage.replace("fail", "");
        check(`a ${stageName} failure fails the check (gateway initially ${initialRunning ? "running" : "stopped"})`, outcome.threw, true);
        check(`a ${stageName} failure restores the initial gateway state (${initialRunning ? "running" : "stopped"})`, running(), initialRunning);
        check(
          `a ${stageName} failure with the gateway initially ${initialRunning ? "running" : "stopped"} ${initialRunning ? "starts it back up" : "never starts it"}`,
          runtimeEvents(events).includes("runtime:start"),
          initialRunning,
        );
        check(`a ${stageName} failure leaves the same-name user file unchanged`, files.get(MARKER), EXISTING_MARKER);
        check(`a ${stageName} failure still releases the instance lock`, lock(), false);
        check(`a ${stageName} failure leaves no scratch-root litter`, litterLeft(files), false);
        check(`a ${stageName} failure never moves the live data root aside`, movedDataDir(events), false);
        check(`a ${stageName} failure leaves the live private file intact`, files.get(PRIVATE_FILE), SECRET_CONTENT);
        if (stage === "failRestore") {
          check("a restore failure never claims an isolated root came back", restoredRoots().length, 0);
        }
      }
    }

    // The irreducible boundary: if even reading the initial state fails, the check aborts
    // before its first mutation, so there is nothing to restore — but it must fail loudly
    // and leave the instance exactly as it found it.
    {
      const { ctx, events, lock } = roundTripContext({ failIsRunning: true });
      const outcome = await runRoundTrip(ctx);
      check("failing to read the initial service state fails the check", outcome.threw, true);
      check("and says the state could not be asked", outcome.message.includes("could not ask whether the gateway is running"), true);
      check("nothing on the instance was written before the abort", events.some((event) => event.startsWith("write:") && !event.includes(locksDir(DATA_DIR))), false);
      check("the gateway was never touched before the abort", runtimeEvents(events), []);
      check("the lock was still released", lock(), false);
    }
  });

  // Without any private paths, the required live config remains a read-only byte witness.
  await withRecordedPrivatePath(async () => {
    const { ctx, files, events, restoredRoots } = roundTripContext({ initialRunning: false });
    check("the no-private-path fixture has no private paths", await installedRecipePrivatePaths(), []);
    const outcome = await runRoundTrip(ctx);
    check("smoke still verifies a round trip when no private paths are declared", outcome.threw, false);
    check("the config witness is hashed before and after restore", events.filter((event) => event.startsWith("bash:")).length, 2);
    check("the required live config returns unchanged", restoredRoots().map((root) => files.get(`${root}/config/openclaw.json`)), ["{}\n"]);
  }, false);

  // A config that exists live but is altered by extraction must fail the no-private-path check.
  await withRecordedPrivatePath(async () => {
    const { ctx } = roundTripContext({ initialRunning: false, corruptConfigOnRestore: true });
    const outcome = await runRoundTrip(ctx);
    check("corrupting the config without private paths fails the round trip", outcome.threw, true);
    check("the required config is named as the failed witness", outcome.message.includes("restore changed the smoke witness config/openclaw.json"), true);
  }, false);

  // Absence of the required witness fails before creating an archive.
  await withRecordedPrivatePath(async () => {
    const { ctx, events, publishedBackups } = roundTripContext({ initialRunning: false, missingConfig: true });
    const outcome = await runRoundTrip(ctx);
    check("a missing live config fails closed", outcome.threw, true);
    check("the failure names the missing witness", outcome.message.includes("required smoke witness config/openclaw.json is missing"), true);
    check("a missing witness publishes no backup", publishedBackups().length, 0);
    check("a missing witness does not pause the gateway", events.some((event) => event.startsWith("runtime:pause")), false);
  }, false);
}

finish("smoke round-trip");

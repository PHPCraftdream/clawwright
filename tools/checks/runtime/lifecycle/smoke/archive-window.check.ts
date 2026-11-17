// The three archive-based checks (reject-secrets, accept-share, round-trip) share one
// gateway stop/start cycle instead of each managing its own — a stub runtime counts pause()/
// start() calls to prove exactly one cycle covers the whole trio, however many of them are
// selected and however many of them fail.

import { checks, runSmokeSuite } from "#framework/commands/lifecycle/smoke/index.ts";
import type { Check, SmokeResult } from "#framework/commands/lifecycle/smoke/index.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";
import { locksDir } from "#framework/core/env.ts";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useDeployment, deploymentDir } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { dataDirName } from "#framework/service/archive/index.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { asDirectTest } from "#checks/kit/deployment-fixture.ts";

const REJECTS_SECRETS_CHECK = "verifier rejects an archive with secrets";
const ACCEPTS_SHARE_CHECK = "verifier accepts a share snapshot";
const ROUND_TRIP_CHECK = "snapshot round-trip is byte-identical";
const ARCHIVE_CHECK_NAMES = [REJECTS_SECRETS_CHECK, ACCEPTS_SHARE_CHECK, ROUND_TRIP_CHECK];

const archiveChecks: Check[] = ARCHIVE_CHECK_NAMES.map((name) => {
  const found = checks.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`smoke.ts no longer has the "${name}" check under its documented name`);
  return found;
});
check("found all three archive-based checks smoke consolidates", archiveChecks.map((entry) => entry.name), ARCHIVE_CHECK_NAMES);

// --- a stub target realistic enough to drive createBackup/pull/verify/restore end to end ------

{
  const PARENT = "/srv/openclaw";
  const DATA_DIR = `${PARENT}/data`;
  const DATA_NAME = dataDirName(DATA_DIR);
  const BACKUP_DIR = `${PARENT}/backups`;
  const SNAPSHOT_DIR = `${PARENT}/snapshots`;
  const LOCK_PATH = `${locksDir(DATA_DIR)}/operation.lock`;
  const MUTATION_GUARD = `${locksDir(DATA_DIR)}/operation.mutation`;

  /** GNU tar reads --exclude as a glob; only `*` is used by this repo's exclusion lists. */
  function globToRegExp(glob: string): RegExp {
    const escaped = glob.replace(/[.+^${}()|[\]\\]/g, String.raw`\$&`).replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`);
  }

  interface ArchiveWindowOptions {
    initialRunning?: boolean;
    /** Fails the `mv` that would publish a specific destination path — used to fail one
     *  archive's publish step without touching the others. */
    failMove?: (destination: string) => boolean;
    failIsRunning?: boolean;
    failPause?: boolean;
    failStart?: boolean;
  }

  function archiveWindowContext(options: ArchiveWindowOptions = {}): {
    ctx: Context;
    events: string[];
    running: () => boolean;
  } {
    const files = new Map<string, string>();
    // Archive bytes, tracked by path so two archives taken in the same run (full, then
    // share) each read back as what they were written as — cp/mv below carry an entry's
    // content along with its path, the same way the real bytes would travel.
    const archiveContents = new Map<string, Map<string, string>>();
    const events: string[] = [];
    let lockExists = false;
    let mutationGuardExists = false;
    let runningNow = options.initialRunning === true;

    files.set(`${DATA_DIR}/config/openclaw.json`, "{}\n");
    // The one thing a share archive must never carry, and a full archive always does —
    // real content for the reject/accept checks to actually disagree about.
    files.set(`${DATA_DIR}/config/.env`, "OPENAI_API_KEY=a-fake-but-long-enough-secret\n");

    const present = (path: string): boolean => {
      if (files.has(path)) return true;
      for (const known of files.keys()) if (known.startsWith(`${path}/`)) return true;
      return path === DATA_DIR;
    };

    const transport = {
      description: "archive-window-stub",
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
          if (lockExists) return { code: 1, stdout: "", stderr: "File exists" };
          lockExists = true;
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
          if (archiveContents.has(source)) archiveContents.set(destination, archiveContents.get(source)!);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "mv") {
          const source = args[args.length - 2] ?? "";
          const destination = args[args.length - 1] ?? "";
          if (options.failMove?.(destination) === true) return { code: 1, stdout: "", stderr: "publish failed" };
          if (files.has(destination)) return { code: 1, stdout: "", stderr: "File exists" };
          files.set(destination, files.get(source) ?? "");
          files.delete(source);
          if (archiveContents.has(source)) {
            archiveContents.set(destination, archiveContents.get(source)!);
            archiveContents.delete(source);
          }
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
          const excludeRegexes = args
            .filter((arg) => arg.startsWith("--exclude="))
            .map((arg) => globToRegExp(arg.slice("--exclude=".length)));
          const content = new Map(
            [...files].filter(([path]) => {
              if (!path.startsWith(`${DATA_DIR}/`)) return false;
              const entryPath = `${DATA_NAME}/${path.slice(DATA_DIR.length + 1)}`;
              return !excludeRegexes.some((re) => re.test(entryPath));
            }),
          );
          archiveContents.set(archive, content);
          files.set(archive, "archive\n");
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "tar" && args.includes("-tzf")) {
          const archive = args[args.indexOf("-tzf") + 1] ?? "";
          const content = archiveContents.get(archive) ?? new Map<string, string>();
          const entries = [`${DATA_NAME}/`, ...[...content.keys()].map((path) => `${DATA_NAME}/${path.slice(DATA_DIR.length + 1)}`)].sort();
          return { code: 0, stdout: `${entries.join("\n")}\n`, stderr: "" };
        }
        if (command === "tar" && args.includes("-tvzf")) {
          const archive = args[args.indexOf("-tvzf") + 1] ?? "";
          const content = archiveContents.get(archive) ?? new Map<string, string>();
          const rows = [`drwxr-xr-x user/user 0 2026-01-01 00:00 ${DATA_NAME}/`];
          for (const path of content.keys()) rows.push(`-rw-r--r-- user/user 6 2026-01-01 00:00 ${DATA_NAME}/${path.slice(DATA_DIR.length + 1)}`);
          return { code: 0, stdout: `${rows.join("\n")}\n`, stderr: "" };
        }
        if (command === "tar" && args.includes("-xzf")) {
          const archive = args[args.indexOf("-xzf") + 1] ?? "";
          const destination = args[args.indexOf("-C") + 1] ?? "";
          const content = archiveContents.get(archive) ?? new Map<string, string>();
          for (const [path, fileContent] of content) {
            const relative = path.slice(DATA_DIR.length + 1);
            files.set(`${destination}/${DATA_NAME}/${relative}`, fileContent);
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "sh" && args.some((arg) => arg.includes("command -v sudo"))) return { code: 1, stdout: "", stderr: "" };
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
        if (options.failPause === true) throw new Error("docker pause failed");
        events.push("runtime:pause");
        runningNow = false;
      },
      async start(): Promise<void> {
        if (options.failStart === true) throw new Error("docker start failed");
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
        settings: { dataDir: DATA_DIR, backupDir: BACKUP_DIR, snapshotDir: SNAPSHOT_DIR, env: {} },
        transport,
        runtime,
        paths: { toContainer: (path: string) => path },
      } as unknown as Context,
      events,
      running: () => runningNow,
    };
  }

  const runtimeEvents = (events: string[]): string[] => events.filter((event) => event.startsWith("runtime:"));
  const pauseCount = (events: string[]): number => runtimeEvents(events).filter((event) => event === "runtime:pause").length;
  const startCount = (events: string[]): number => runtimeEvents(events).filter((event) => event === "runtime:start").length;
  const statusOf = (results: SmokeResult[], name: string): string | undefined => results.find((result) => result.name === name)?.status;

  /** Everything below runs with a disposable deployment directory selected — the archive
   *  checks read installedRecipePrivatePaths()/privatePathsPolicy() off the real filesystem,
   *  the same way roundtrip.check.ts's fixture does. */
  async function withTempDeployment<T>(body: () => Promise<T>): Promise<T> {
    const root = await mkdtemp(join(tmpdir(), "clawwright-smoke-archive-window-"));
    let previous: string | undefined;
    try { previous = deploymentDir(); } catch { /* no deployment selected in this check */ }
    try {
      await mkdir(join(root, "config"), { recursive: true });
      useDeployment(root);
      return await body();
    } finally {
      if (previous === undefined) useDeployment(root);
      else useDeployment(previous);
      await rm(root, { recursive: true, force: true });
    }
  }

  await withTempDeployment(async () => {
    // Success: all three archive checks pass, and the whole trio costs exactly one
    // stop/start cycle instead of three.
    {
      const { ctx, events, running } = archiveWindowContext({ initialRunning: true });
      const results: SmokeResult[] = [];
      await withOutputSink(() => {}, () => runSmokeSuite(ctx, archiveChecks, (result) => results.push(result)));

      check("all three archive-based checks passed", results.map((result) => result.status), ["passed", "passed", "passed"]);
      check("exactly one pause across all three archive checks", pauseCount(events), 1);
      check("exactly one start across all three archive checks", startCount(events), 1);
      check("the gateway ends running, as it began", running(), true);
    }

    // A stopped gateway stays stopped: nothing in the shared window may start it just to
    // take archives from it.
    {
      const { ctx, events, running } = archiveWindowContext({ initialRunning: false });
      const results: SmokeResult[] = [];
      await withOutputSink(() => {}, () => runSmokeSuite(ctx, archiveChecks, (result) => results.push(result)));

      check("archive checks still pass from a stopped gateway", results.map((result) => result.status), ["passed", "passed", "passed"]);
      check("a stopped gateway is never paused", pauseCount(events), 0);
      check("a stopped gateway is never started", startCount(events), 0);
      check("and it ends the run stopped, as it began", running(), false);
    }

    // One archive check fails (the share snapshot's own publish step) — the sibling checks,
    // which depend only on the full archive, still get their own verdicts, and the gateway
    // still comes back up exactly once.
    {
      const { ctx, events, running } = archiveWindowContext({
        initialRunning: true,
        failMove: (destination) => destination.endsWith("-share.tar.gz"),
      });
      const results: SmokeResult[] = [];
      await withOutputSink(() => {}, () => runSmokeSuite(ctx, archiveChecks, (result) => results.push(result)));

      check("the failing share check is reported, not silently dropped", results.length, 3);
      check("the failing share check did not pass", statusOf(results, ACCEPTS_SHARE_CHECK) === "passed", false);
      check("the sibling check built on the full archive still passed", statusOf(results, REJECTS_SECRETS_CHECK), "passed");
      check("the round-trip check, also built on the full archive, still passed", statusOf(results, ROUND_TRIP_CHECK), "passed");
      check("still exactly one pause when one archive check fails", pauseCount(events), 1);
      check("still exactly one start when one archive check fails", startCount(events), 1);
      check("the gateway still ends running despite the failure", running(), true);
    }

    // The mirror case: the full backup fails. The share check, independent of it, still
    // gets its own verdict; the two checks that needed the full archive report what they
    // could — could-not-check, not a crash of the whole run — and the gateway still comes
    // back up exactly once.
    {
      const { ctx, events, running } = archiveWindowContext({
        initialRunning: true,
        failMove: (destination) => destination.endsWith(".tar.gz") && !destination.endsWith("-share.tar.gz") && !destination.includes("-state-"),
      });
      const results: SmokeResult[] = [];
      await withOutputSink(() => {}, () => runSmokeSuite(ctx, archiveChecks, (result) => results.push(result)));

      check("the share check, unaffected by the full backup failing, still passed", statusOf(results, ACCEPTS_SHARE_CHECK), "passed");
      check("the reject check could not get its full archive to verify", statusOf(results, REJECTS_SECRETS_CHECK), "could-not-check");
      check("the round trip could not get its full archive to restore", statusOf(results, ROUND_TRIP_CHECK), "could-not-check");
      check("still exactly one pause when the full backup fails", pauseCount(events), 1);
      check("still exactly one start when the full backup fails", startCount(events), 1);
      check("the gateway still ends running despite the failure", running(), true);
    }

    // --quick drops the round-trip check; the two it keeps still share one window.
    {
      const { ctx, events, running } = archiveWindowContext({ initialRunning: true });
      const quickChecks = archiveChecks.filter((entry) => entry.name !== ROUND_TRIP_CHECK);
      const results: SmokeResult[] = [];
      await withOutputSink(() => {}, () => runSmokeSuite(ctx, quickChecks, (result) => results.push(result)));

      check("--quick's two remaining archive checks both passed", results.map((result) => result.status), ["passed", "passed"]);
      check("--quick still costs exactly one pause", pauseCount(events), 1);
      check("--quick still costs exactly one start", startCount(events), 1);
      check("--quick still ends the gateway running", running(), true);
    }
  });
}

finish("smoke archive-window");

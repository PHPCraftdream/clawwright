// `./clawwright backup --native` — a consistent snapshot without stopping the gateway, via
// OpenClaw's own `backup create --verify` in the sidecar, reshaped into the classic archive
// layout so rotation, naming and restore need no native-specific case.

import { resolve } from "node:path";
import { createBackup, NativeBackupUnsupportedError, NATIVE_MANIFEST_NAME, omittedOnPurpose } from "#framework/commands/lifecycle/backup/index.ts";
import { useDeployment, deploymentName } from "#framework/runtime/deployment.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import { mountPoints } from "#framework/runtime/mounts.ts";
import { toContainerPath, fromContainerPath } from "#framework/core/paths.ts";
import { excludesFor } from "#framework/service/archive/index.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { asDirectTest } from "#checks/kit/deployment-fixture.ts";

useDeployment(resolve(monorepoRoot, "apps", "example app"));

const DATA_DIR = "/srv/clawwright/data";
const BACKUP_DIR = "/srv/clawwright/backups";
const NATIVE_ROOT = "20260101T000000-openclaw-backup";
const NATIVE_LISTING = [
  `${NATIVE_ROOT}/`,
  `${NATIVE_ROOT}/manifest.json`,
  `${NATIVE_ROOT}/payload/posix/home/node/.openclaw/`,
  `${NATIVE_ROOT}/payload/posix/home/node/.openclaw/openclaw.json`,
  `${NATIVE_ROOT}/payload/posix/home/node/.openclaw/workspace/`,
  `${NATIVE_ROOT}/payload/posix/home/node/.openclaw/workspace/note.md`,
].join("\n");

/** `openclaw backup create` reports the exact path it was told to use as `--output` when
 *  that names a file directly rather than a directory — verified against the real image
 *  (see the task's own probes). Simulated here the same way. */
type NativeCreateOutcome = "ok" | "verify-false" | "unsupported" | "write-fail";

/** Whether nothing else tracked sits underneath `path` — the stub's crude stand-in for
 *  `find -type f`, since its one `files` set carries directories and files alike. */
function isLeaf(files: ReadonlySet<string>, path: string): boolean {
  return ![...files].some((other) => other !== path && other.startsWith(`${path}/`));
}

function stubNativeCtx(
  outcome: NativeCreateOutcome,
  options: { extraLiveFile?: string; failOnExtract?: boolean } = {},
): { ctx: Context; calls: string[]; files: Set<string> } {
  const calls: string[] = [];
  const files = new Set([DATA_DIR, `${DATA_DIR}/config`, `${DATA_DIR}/auth-secrets`]);
  if (options.extraLiveFile !== undefined) files.add(options.extraLiveFile);
  const mounts = mountPoints(DATA_DIR);
  const holder = JSON.stringify({ operationId: "op", what: "x", by: "a@b pid 1", takenAt: new Date().toISOString() });

  const ctx = {
    settings: { dataDir: DATA_DIR, backupDir: BACKUP_DIR, env: {} },
    paths: {
      toContainer: (path: string) => toContainerPath(path, mounts),
      fromContainer: (path: string) => fromContainerPath(path, mounts),
    },
    transport: {
      description: "stub",
      async exists(path: string): Promise<boolean> {
        return files.has(path);
      },
      async exec(rawCommand: string, rawArgs: string[]): Promise<ExecResult> {
        const { command, args } = asDirectTest(rawCommand, rawArgs);
        calls.push(`exec ${command} ${args.join(" ")}`);
        if (command === "test" && args[0] === "-L") return { code: 1, stdout: "", stderr: "" };
        if (command === "test" && (args[0] === "-w" || args[0] === "-r" || args[0] === "-x")) return { code: 0, stdout: "", stderr: "" };
        if (command === "test" && args[0] === "-d") return { code: files.has(args[1] ?? "") ? 0 : 1, stdout: "", stderr: "" };
        if (command === "test" && args[0] === "-e") return { code: files.has(args[1] ?? "") ? 0 : 1, stdout: "", stderr: "" };
        if (command === "mkdir" && args.length === 1) return { code: 0, stdout: "", stderr: "" };
        if (command === "mkdir") { files.add(args.at(-1) ?? ""); return { code: 0, stdout: "", stderr: "" }; }
        if (command === "tar" && args.includes("-tzf")) {
          const archive = args.at(-1) ?? "";
          const stdout = archive.includes(".clawwright-native-") ? NATIVE_LISTING : "data/\ndata/config/openclaw.json\n";
          return { code: 0, stdout, stderr: "" };
        }
        if (command === "tar" && args.includes("-xzf")) {
          // Real transport throws on a non-zero exit when allowFailure is not set, exactly
          // like createNativeArchive's own extraction call — simulated here the same way.
          if (options.failOnExtract === true) throw new Error("tar: unexpected end of file");
          // Simulates the native archive's extraction: its payload lands under -C's target.
          const dest = args[args.indexOf("-C") + 1] ?? "";
          files.add(`${dest}/${NATIVE_ROOT}/payload/posix/home/node/.openclaw`);
          files.add(`${dest}/${NATIVE_ROOT}/payload/posix/home/node/.openclaw/workspace`);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "tar" && args.includes("-czf")) {
          files.add(args[args.indexOf("-czf") + 1] ?? "");
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "mv") {
          const source = args.at(-2) ?? "";
          const destination = args.at(-1) ?? "";
          for (const file of Array.from(files)) {
            if (file === source) { files.delete(file); files.add(destination); }
            else if (file.startsWith(`${source}/`)) { files.delete(file); files.add(`${destination}${file.slice(source.length)}`); }
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "cp") {
          const source = args.at(-2) ?? "";
          const destination = args.at(-1) ?? "";
          if (files.has(source)) files.add(destination);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "find" && args.includes("-printf")) {
          const prefix = `${args[0] ?? ""}/`;
          const relatives = [...files].filter((file) => file.startsWith(prefix) && isLeaf(files, file)).map((file) => file.slice(prefix.length));
          return { code: 0, stdout: relatives.length > 0 ? `${relatives.join("\n")}\n` : "", stderr: "" };
        }
        if (command === "find") return { code: 0, stdout: "", stderr: "" };
        if (command === "rm") {
          const target = args.at(-1) ?? "";
          for (const file of Array.from(files)) {
            if (file === target || (args.includes("-rf") && file.startsWith(`${target}/`))) files.delete(file);
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      async readFile(path: string): Promise<string> {
        if (path.endsWith("holder.json")) return holder;
        throw new Error(`no such file: ${path}`);
      },
      async writeFile(): Promise<void> {},
      async remove(): Promise<void> {},
    },
    runtime: {
      async isRunning(): Promise<boolean> { return true; },
      async pause(): Promise<void> { calls.push("pause"); },
      async start(): Promise<void> { calls.push("start"); },
      async waitForHealth(): Promise<void> { calls.push("waitForHealth"); },
      async runOneOff(service: string, cliArgs: string[]): Promise<ExecResult> {
        calls.push(`runOneOff ${service} ${cliArgs.join(" ")}`);
        if (outcome === "unsupported") return { code: 1, stdout: "", stderr: "error: unknown command 'backup'" };
        const containerOutput = cliArgs[cliArgs.indexOf("--output") + 1] ?? "";
        // A verified create actually writes the archive at --output, addressable back on the
        // host at the same path createNativeArchive built it from — needed for the cleanup
        // checks below to have something real to find and remove.
        if (outcome === "ok" || outcome === "write-fail") files.add(fromContainerPath(containerOutput, mounts));
        return {
          code: outcome === "verify-false" || outcome === "write-fail" ? 1 : 0,
          stdout: outcome === "write-fail" ? "" : JSON.stringify({ verified: outcome === "ok", archivePath: containerOutput }),
          stderr: "",
        };
      },
    },
  } as unknown as Context;
  return { ctx, calls, files };
}

// --- native path invokes the right command, and parses the JSON result ---------------------

{
  const { ctx, calls, files } = stubNativeCtx("ok");
  const archive = await withOutputSink(() => {}, () => createBackup(ctx, { profile: "full", native: true }));
  const invoked = calls.find((call) => call.startsWith("runOneOff cli backup create"));
  check("native mode invokes openclaw backup create --verify --json --output", invoked !== undefined, true);
  check("the gateway is never paused for a native backup", calls.includes("pause"), false);
  check("a successful native backup returns the published archive path", typeof archive === "string" && archive.length > 0, true);

  // --- rotation still works: the published name is the ordinary full-backup name ----------
  check("a native backup keeps the plain full-backup name", new RegExp(`^${BACKUP_DIR}/${deploymentName()}-\\d{8}-\\d{6}\\.tar\\.gz$`).test(archive), true);
  check("the published archive exists where rotate()/newestArchive() look for it", files.has(archive), true);
  check("no leftover staging directory remains", [...files].some((path) => path.includes(".clawwright-backup-")), false);
  check("no leftover native staging file remains", [...files].some((path) => path.includes(".clawwright-native-")), false);
}

// --- --native refuses anything but the full profile -----------------------------------------

{
  const { ctx } = stubNativeCtx("ok");
  let message = "";
  await withOutputSink(() => {}, async () => {
    try { await createBackup(ctx, { profile: "share", native: true }); } catch (error) { message = (error as Error).message; }
  });
  check("--native refuses a non-full profile", message.includes("only supports the full profile"), true);
}

// --- unavailable native support is reported distinctly, for ./clawwright upgrade's fallback --

{
  const { ctx, files } = stubNativeCtx("unsupported");
  let threwUnsupported = false;
  await withOutputSink(() => {}, async () => {
    try { await createBackup(ctx, { profile: "full", native: true }); }
    catch (error) { threwUnsupported = error instanceof NativeBackupUnsupportedError; }
  });
  check("an image without native backup support throws NativeBackupUnsupportedError", threwUnsupported, true);
  check("an unsupported attempt leaves no archive under a normal-looking name", [...files].some((path) => path.endsWith(".tar.gz")), false);
}

// --- a verify:false result refuses to publish, and leaves no half archive ------------------

{
  const { ctx, files } = stubNativeCtx("verify-false");
  let message = "";
  await withOutputSink(() => {}, async () => {
    try { await createBackup(ctx, { profile: "full", native: true }); } catch (error) { message = (error as Error).message; }
  });
  check("refusing on verify failure is reported", message.length > 0, true);
  check("a refused verify never publishes an archive", [...files].some((path) => path.endsWith(".tar.gz")), false);
}

// --- a failed create after writing its output must clean the live credential-bearing file --

{
  const { ctx, files, calls } = stubNativeCtx("write-fail");
  let message = "";
  await withOutputSink(() => {}, async () => {
    try { await createBackup(ctx, { profile: "full", native: true }); } catch (error) { message = (error as Error).message; }
  });
  check("a create failure after writing surfaces as an error", message.length > 0, true);
  check(
    "the failed create output is removed from the live config directory",
    [...files].some((path) => path.startsWith(`${DATA_DIR}/config/.clawwright-native-`)),
    false,
  );
  check("cleanup explicitly removes the native output", calls.some((call) => call.startsWith("exec rm -f --") && call.includes(".clawwright-native-")), true);
}

// --- a live file the native archive omits (session transcripts, in the pinned image: the
// sessions/ directory is listed, the .jsonl/.log files in it are not) is copied into the
// published archive, generically — not by a hardcoded name — and the count is reported ----

{
  const transcript = `${DATA_DIR}/config/agents/main/sessions/s1.jsonl`;
  const { ctx, calls } = stubNativeCtx("ok", { extraLiveFile: transcript });
  let logged = "";
  const archive = await withOutputSink((line) => { logged += line; }, () => createBackup(ctx, { profile: "full", native: true }));
  check("a native backup still succeeds when a live file is missing from the native payload", typeof archive === "string" && archive.length > 0, true);
  check("the omitted live file is copied into the assembled tree", calls.some((call) => call.startsWith("exec cp") && call.includes(transcript)), true);
  check("how many omitted files were copied is reported", /copied 1 file/.test(logged), true);
}

// --- what OpenClaw leaves out on purpose stays out: a hot SQLite sidecar beside the native
// point-in-time database would corrupt it on restore; the run's own native archive sits in
// config/ while the difference is taken ---

{
  check("a -wal sidecar is never re-added", omittedOnPurpose("state/openclaw.sqlite-wal"), true);
  check("a -shm sidecar is never re-added", omittedOnPurpose("state/openclaw.sqlite-shm"), true);
  check("a -journal sidecar is never re-added", omittedOnPurpose("agents/main/agent/db.sqlite-journal"), true);
  check("a browser profile lock is never re-added", omittedOnPurpose("browser/profile/SingletonLock"), true);
  check("the run's own native archive is never re-added", omittedOnPurpose(".clawwright-native-1234.tar.gz"), true);
  check("a session transcript is still re-added", omittedOnPurpose("agents/main/sessions/s1.jsonl"), false);
  const wal = `${DATA_DIR}/config/state/openclaw.sqlite-wal`;
  const { ctx, calls } = stubNativeCtx("ok", { extraLiveFile: wal });
  await withOutputSink(() => {}, () => createBackup(ctx, { profile: "full", native: true }));
  check("a live -wal file is not copied into the native archive", calls.some((call) => call.startsWith("exec cp") && call.includes(wal)), false);
}

// --- a failure after the native archive is created (here: extraction) must not leave it
// sitting in the live data directory — until the mv into staging lands, that file carries a
// full backup's worth of secrets (config/.env, credentials) -------------------------------

{
  const { ctx, files } = stubNativeCtx("ok", { failOnExtract: true });
  let message = "";
  await withOutputSink(() => {}, async () => {
    try { await createBackup(ctx, { profile: "full", native: true }); } catch (error) { message = (error as Error).message; }
  });
  check("an extraction failure surfaces as an error", message.length > 0, true);
  check(
    "the in-flight native archive is removed from config/ rather than left behind",
    [...files].some((path) => path.startsWith(`${DATA_DIR}/config/.clawwright-native-`)),
    false,
  );
}

// --- an in-flight native archive left in config/ by a crash must not be swept into a LATER
// backup's own payload: excludesFor keeps it out without touching the published manifest,
// which sits at the archive root (name/NATIVE_MANIFEST_NAME), never under config/ -----------

{
  const name = "data";
  const excludes = excludesFor("full", name);
  check("excludesFor(full) excludes a native archive left live in config/", excludes.includes(`${name}/config/.clawwright-native-*`), true);
  check(
    "the published native manifest's own archive-root path is not among the exclude patterns",
    excludes.includes(`${name}/${NATIVE_MANIFEST_NAME}`),
    false,
  );
}

finish("native backup");

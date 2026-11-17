// afterBackup/beforeRestore — the AppDefinition-level extension point for a backup's own
// side effects (an off-host copy, encryption) and a restore's own archive preparation
// (decryption). Reuses the applicationSecrets model: AppDefinition declares a plain
// function, createContext() binds `ctx` into it once, and the command (backup.ts/
// restore.ts) calls the bound form off Context — never the AppDefinition itself.

import { join } from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createBackup } from "#framework/commands/lifecycle/backup/index.ts";
import { restoreArchive } from "#framework/commands/lifecycle/restore/index.ts";
import { createContext } from "#framework/core/context.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import type { AfterBackupInfo } from "#framework/core/app.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";
import { useLinuxHost } from "#checks/foundation/hygiene/linux-host.ts";

useLinuxHost();
import { check, finish } from "#checks/kit/harness.ts";
import { asDirectTest } from "#checks/kit/deployment-fixture.ts";

// --- createContext binds `ctx` into the AppDefinition-level hook, the same way it already
// binds applicationSecrets --------------------------------------------------------------

{
  const root = await mkdtemp(join(tmpdir(), "clawwright-backup-hooks-"));
  try {
    await mkdir(join(root, "data", "config"), { recursive: true });
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(
      join(root, ".env"),
      `OC_DATA_DIR=${join(root, "data")}\nOC_TARGET_LOCATION=local\nOPENCLAW_GATEWAY_TOKEN=synthetic-gateway-token\n`,
    );
    await writeFile(join(root, "data", "config", "openclaw.json"), "{}");
    useDeployment(root);

    let afterBackupCtx: Context | undefined;
    let afterBackupInfo: Omit<AfterBackupInfo, "ctx"> | undefined;
    let beforeRestoreCtx: Context | undefined;
    let beforeRestoreArchive: string | undefined;

    const ctx = await createContext({
      afterBackup: (info) => { afterBackupCtx = info.ctx; afterBackupInfo = { archive: info.archive, profile: info.profile, purpose: info.purpose }; },
      beforeRestore: (info) => { beforeRestoreCtx = info.ctx; beforeRestoreArchive = info.archive; return "decrypted.tar.gz"; },
    });

    check("createContext exposes applicationAfterBackup when the app declares one", typeof ctx.applicationAfterBackup, "function");
    await ctx.applicationAfterBackup!({ archive: "/x/a.tar.gz", profile: "full", purpose: "backup" });
    check("the bound afterBackup hook receives this same ctx", afterBackupCtx === ctx, true);
    check("...and the archive/profile/purpose given to it", JSON.stringify(afterBackupInfo), JSON.stringify({ archive: "/x/a.tar.gz", profile: "full", purpose: "backup" }));

    check("createContext exposes applicationBeforeRestore when the app declares one", typeof ctx.applicationBeforeRestore, "function");
    const prepared = await ctx.applicationBeforeRestore!({ archive: "/x/enc.tar.gz" });
    check("the bound beforeRestore hook receives this same ctx", beforeRestoreCtx === ctx, true);
    check("...and the archive given to it", beforeRestoreArchive, "/x/enc.tar.gz");
    check("its return value passes through unchanged", prepared, "decrypted.tar.gz");

    const plainCtx = await createContext({});
    check("no afterBackup declared means no applicationAfterBackup on the context", plainCtx.applicationAfterBackup, undefined);
    check("no beforeRestore declared means no applicationBeforeRestore on the context", plainCtx.applicationBeforeRestore, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// --- createBackup(): afterBackup fires after publication/rotation, with the right info ----

const DATA_DIR = "/srv/clawwright/hooks-data";
const BACKUP_DIR = "/srv/clawwright/hooks-backups";

function stubBackupCtx(hooks: { applicationAfterBackup?: Context["applicationAfterBackup"] } = {}): { ctx: Context; files: Set<string> } {
  const files = new Set([DATA_DIR]);
  const ctx = {
    settings: { dataDir: DATA_DIR, backupDir: BACKUP_DIR, env: {} },
    transport: {
      description: "stub",
      async exists(path: string): Promise<boolean> { return files.has(path); },
      async exec(rawCommand: string, rawArgs: string[]): Promise<ExecResult> {
        const { command, args } = asDirectTest(rawCommand, rawArgs);
        if (command === "test" && args[0] === "-L") return { code: 1, stdout: "", stderr: "" };
        if (command === "test" && args[0] === "-e") return { code: files.has(args[1] ?? "") ? 0 : 1, stdout: "", stderr: "" };
        if (command === "test" && (args[0] === "-w" || args[0] === "-r" || args[0] === "-x")) return { code: 0, stdout: "", stderr: "" };
        if (command === "tar" && args.includes("-tzf")) return { code: 0, stdout: "data/\ndata/config/openclaw.json\n", stderr: "" };
        if (command === "tar" && args.includes("-czf")) {
          files.add(args[args.indexOf("-czf") + 1] ?? "");
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "mkdir") return { code: 0, stdout: "", stderr: "" };
        if (command === "mv") {
          const source = args.at(-2) ?? "";
          const destination = args.at(-1) ?? "";
          if (files.has(source)) { files.delete(source); files.add(destination); }
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "rm") {
          const target = args.at(-1) ?? "";
          for (const file of files) {
            if (file === target || (args.includes("-rf") && file.startsWith(`${target}/`))) files.delete(file);
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "find") return { code: 0, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
      async readFile(): Promise<string> { return ""; },
      async writeFile(): Promise<void> {},
      async remove(): Promise<void> {},
    },
    runtime: {
      async isRunning(): Promise<boolean> { return false; },
      async pause(): Promise<void> {},
      async start(): Promise<void> {},
      async waitForHealth(): Promise<void> {},
    },
    ...hooks,
  } as unknown as Context;
  return { ctx, files };
}

{
  let received: Omit<AfterBackupInfo, "ctx"> | undefined;
  const { ctx } = stubBackupCtx({ applicationAfterBackup: async (info) => { received = info; } });
  const archive = await withOutputSink(() => {}, () => createBackup(ctx, { profile: "full" }));
  check("afterBackup receives the published archive path", received?.archive, archive);
  check("afterBackup receives the profile", received?.profile, "full");
  check("with no purpose given, afterBackup sees purpose \"backup\"", received?.purpose, "backup");
}

{
  let purpose: string | undefined;
  const { ctx } = stubBackupCtx({ applicationAfterBackup: async (info) => { purpose = info.purpose; } });
  await withOutputSink(() => {}, () => createBackup(ctx, { profile: "full", purpose: "pull" }));
  check("purpose is passed through unchanged to the hook", purpose, "pull");
}

{
  let called = false;
  const { ctx } = stubBackupCtx({ applicationAfterBackup: async () => { called = true; } });
  await withOutputSink(() => {}, () => createBackup(ctx, { profile: "full", purpose: "internal" }));
  check("purpose \"internal\" (smoke's own archives) never fires afterBackup", called, false);
}

{
  const { ctx } = stubBackupCtx();
  const archive = await withOutputSink(() => {}, () => createBackup(ctx, { profile: "full" }));
  check("no afterBackup declared: backup still succeeds and returns the archive", typeof archive === "string" && archive.length > 0, true);
}

// A failing hook must leave the archive exactly where it landed — a hook error is never
// read as the backup itself failing, and never causes a delete.
{
  const { ctx, files } = stubBackupCtx({ applicationAfterBackup: async () => { throw new Error("upload failed: disk full"); } });
  let message = "";
  await withOutputSink(() => {}, async () => {
    try { await createBackup(ctx, { profile: "full" }); } catch (error) { message = (error as Error).message; }
  });
  check("a failing afterBackup hook names the published archive and its own error", message.includes("backup published at") && message.includes("afterBackup hook failed") && message.includes("upload failed: disk full"), true);
  check("the published archive is not deleted when the hook fails", [...files].some((path) => path.endsWith(".tar.gz")), true);
  check("no staging leftovers remain either", [...files].some((path) => path.includes(".clawwright-backup-")), false);
}

// --- restoreArchive(): beforeRestore runs first, can redirect the archive, and a failure
// stops the restore before anything on the target is touched --------------------------------

// The stub's tar -tzf listing always reports a "data/" root (below) — restore refuses
// unless the data directory's own name matches, so this must end in "data" too.
const RESTORE_DATA_DIR = "/srv/openclaw/hooks/data";
const REAL_ARCHIVE = "/srv/openclaw/backups/hooks-real.tar.gz";
const PLACEHOLDER_ARCHIVE = "/srv/openclaw/backups/hooks-placeholder.enc";
const CONFIG_PATH = `${RESTORE_DATA_DIR}/config/openclaw.json`;

function stubRestoreCtx(hooks: { applicationBeforeRestore?: Context["applicationBeforeRestore"] } = {}): { ctx: Context; calls: string[] } {
  const calls: string[] = [];
  let running = true;
  const ctx = {
    settings: { dataDir: RESTORE_DATA_DIR, env: {} },
    transport: {
      description: "stub",
      async exists(path: string): Promise<boolean> {
        if (path === CONFIG_PATH) return true;
        // No target .env: preflightSecrets fails gracefully afterwards, leaving the
        // gateway stopped rather than throwing — restoreArchive() still returns normally.
        if (path === `${RESTORE_DATA_DIR}/config/.env`) return false;
        return true;
      },
      async readFile(path: string): Promise<string> {
        if (path === CONFIG_PATH) return JSON.stringify({ provider: { key: { source: "env", id: "REQUIRED_VAR" } } });
        return "";
      },
      async writeFile(): Promise<void> {},
      async mkdirp(): Promise<void> {},
      async remove(): Promise<void> {},
      async exec(command: string, args: string[]): Promise<ExecResult> {
        calls.push(`exec ${command} ${args.join(" ")}`);
        if (command === "tar" && args.includes("-tzf")) return { code: 0, stdout: "data/\ndata/config/openclaw.json\n", stderr: "" };
        if (command === "tar" && args.includes("-tvzf")) return { code: 0, stdout: "", stderr: "" };
        if (command === "stat") return { code: 0, stdout: "1000:1000", stderr: "" };
        if (command === "test" && args[0] === "-L") return { code: 1, stdout: "", stderr: "" };
        if (command === "readlink" && args[0] === "-f") return { code: 0, stdout: args[1] ?? "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    runtime: {
      async isRunning(): Promise<boolean> { return running; },
      async stop(): Promise<void> { calls.push("stop"); running = false; },
      async start(): Promise<void> { calls.push("start"); running = true; },
      async waitForHealth(): Promise<void> {},
    },
    ...hooks,
  } as unknown as Context;
  return { ctx, calls };
}

{
  let receivedArchive: string | undefined;
  const { ctx, calls } = stubRestoreCtx({
    applicationBeforeRestore: async (info) => { receivedArchive = info.archive; return REAL_ARCHIVE; },
  });
  await withOutputSink(() => {}, () => restoreArchive(ctx, PLACEHOLDER_ARCHIVE, { force: true }));
  check("beforeRestore receives the archive path restore was given", receivedArchive, PLACEHOLDER_ARCHIVE);
  check("restore lists the hook's returned path", calls.some((call) => call === `exec tar -tzf ${REAL_ARCHIVE}`), true);
  check("restore never lists the original placeholder path", calls.some((call) => call.includes(PLACEHOLDER_ARCHIVE)), false);
}

{
  let called = false;
  const { ctx } = stubRestoreCtx({ applicationBeforeRestore: async () => { called = true; return undefined; } });
  await withOutputSink(() => {}, () => restoreArchive(ctx, REAL_ARCHIVE, { force: true }));
  check("returning nothing keeps the given archive path as-is (no throw)", called, true);
}

{
  let called = false;
  const { ctx } = stubRestoreCtx({ applicationBeforeRestore: async () => { called = true; return REAL_ARCHIVE; } });
  await withOutputSink(() => {}, () => restoreArchive(ctx, REAL_ARCHIVE, { force: true, internal: true }));
  check("internal: true (smoke's own restores) never fires beforeRestore", called, false);
}

{
  const { ctx, calls } = stubRestoreCtx({ applicationBeforeRestore: async () => { throw new Error("decrypt failed: bad key"); } });
  let message = "";
  await withOutputSink(() => {}, async () => {
    try { await restoreArchive(ctx, PLACEHOLDER_ARCHIVE, { force: true }); } catch (error) { message = (error as Error).message; }
  });
  check("a failing beforeRestore hook says the restore did not start, with its own error", message.includes("beforeRestore hook failed") && message.includes("restore did not start") && message.includes("decrypt failed: bad key"), true);
  check("nothing on the target is stopped when beforeRestore fails", calls.includes("stop"), false);
}

finish("backup/restore hook");

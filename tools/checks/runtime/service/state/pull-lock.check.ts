// openclawCommands.pull.run() and the instance lock: one lock held through the archive and every sidecar, released
// again when a step fails, and every publication failure leaving neither a discoverable partial
// snapshot nor a held lock. A modelled target filesystem, no real target.

import { resolve } from "node:path";
import { useDeployment, deploymentName } from "#framework/runtime/deployment.ts";
import { takeLock } from "#framework/runtime/lock/instance-lock.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";
import { pullScenario, type PullFailure } from "./pull-harness.ts";
import { modelMutationGuard } from "./mutation-guard.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { asDirectTest } from "#checks/kit/deployment-fixture.ts";
import { selectSnapshotPaths } from "#framework/commands/lifecycle/state.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";

useDeployment(resolve(monorepoRoot, "apps", "example app"));
// --- pull holds one lock through the archive and every sidecar ---------------------------

// A competing operation must not slip in after createBackup() releases its nested lock.
// The fake transport invokes the competitor at the copy boundary, where the old pull
// implementation had already dropped its lock. It also records the archive source and the
// migrate sidecar so the two outputs can be checked as one snapshot.
{
  const dataDir = "/srv/openclaw/data";
  const backupDir = "/srv/openclaw/backups";
  const snapshotDir = "/srv/openclaw/snapshots";
  const files = new Map<string, string>();
  const events: string[] = [];
  let lockExists = false;
  let copySource = "";
  let snapshotPath = "";
  let competitorMessage = "";
  let competitorAttempts = 0;
  files.set(`${dataDir}/config/.env`, "OPENAI_API_KEY=OLD_KEY_VALUE\n");
  const ctx = {
    settings: { dataDir, backupDir, snapshotDir, env: {} },
    transport: {
      description: "pull-lock-stub",
      async exists(path: string): Promise<boolean> {
        return path === dataDir || path === snapshotDir || path.endsWith("openclaw.json") || path.endsWith("config/.env") || files.has(path);
      },
      async readFile(path: string): Promise<string> {
        if (path.endsWith("holder.json")) return files.get(path) ?? "";
        if (path.endsWith("openclaw.json")) {
          return JSON.stringify({ models: { providers: { openai: {} } } });
        }
        if (path.endsWith("config/.env")) return files.get(path) ?? "";
        return files.get(path) ?? "";
      },
      async writeFile(path: string, content: string): Promise<void> {
        files.set(path, content);
        events.push(`write:${path}`);
        if (path.endsWith(".tar.gz") && path.includes("-state-")) snapshotPath = path;
      },
      async remove(path: string): Promise<void> {
        if (path.endsWith("operation.lock")) {
          lockExists = false;
          for (const key of files.keys()) if (key.includes("/operation.lock/")) files.delete(key);
        }
        files.delete(path);
      },
      async mkdirp(): Promise<void> {},
      async exec(rawCommand: string, rawArgs: string[]): Promise<ExecResult> {
        const { command, args } = asDirectTest(rawCommand, rawArgs);
        events.push(`${command}:${args.join(" ")}`);
        if (command === "mkdir" && !args[0]?.startsWith("-")) {
          if (lockExists) return { code: 1, stdout: "", stderr: "File exists" };
          lockExists = true;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "test" && args[0] === "-d") {
          return { code: lockExists ? 0 : 1, stdout: "", stderr: "" };
        }
        if (command === "test" && args[0] === "-L") return { code: 1, stdout: "", stderr: "" };
        if (command === "test" && args[0] === "-w") return { code: 0, stdout: "", stderr: "" };
        // The instance lock's release now empties its directory with `rmdir`, not a
        // recursive remove of the whole lock path.
        if (command === "rmdir") {
          if (args[0]?.endsWith("operation.lock")) lockExists = false;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "test" && args[0] === "-e") {
          const path = args[1] ?? "";
          return {
            code: path === dataDir || path === snapshotDir || path.endsWith("openclaw.json") || path.endsWith("config/.env") || files.has(path) ? 0 : 1,
            stdout: "",
            stderr: "",
          };
        }
        if (command === "cp") {
          copySource = args[args.length - 2] ?? "";
          snapshotPath = args[args.length - 1] ?? "";
          if (copySource !== "" && snapshotPath !== "") files.set(snapshotPath, files.get(copySource) ?? "");
          competitorAttempts += 1;
          let competitorLock: Awaited<ReturnType<typeof takeLock>> | undefined;
          try {
            competitorLock = await takeLock(ctx as unknown as Context, "competing-operation", "op-competing");
            files.set(`${dataDir}/config/.env`, "OPENAI_API_KEY=NEW_KEY_VALUE\n");
            await competitorLock.release();
          } catch (error) {
            competitorMessage = (error as Error).message;
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "mv") {
          const source = args[args.length - 2] ?? "";
          const destination = args[args.length - 1] ?? "";
          files.set(destination, files.get(source) ?? "");
          files.delete(source);
          if (snapshotPath === source) snapshotPath = destination;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "tar" && args.includes("-czf")) {
          const archive = args[args.indexOf("-czf") + 1];
          if (archive !== undefined) files.set(archive, "state=OLD\n");
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "sh" && args.some((arg) => arg.includes("ls -1t"))) {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "tar" && args.includes("-tzf")) {
          return { code: 0, stdout: "data/\ndata/config/openclaw.json\ndata/workspace/SOUL.md\n", stderr: "" };
        }
        if (command === "du") return { code: 0, stdout: "1K\tarchive\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    runtime: { async isRunning(): Promise<boolean> { return false; } },
  } as unknown as Context;
  modelMutationGuard(ctx);

  await withOutputSink(() => {}, () => openclawCommands.pull.run(ctx, []));
  const sidecar = files.get(`${snapshotPath}.secrets.env`) ?? "";
  check("pull refuses a competing lock at the copy boundary", competitorMessage.includes("another operation is changing this instance"), true);
  check("the competing operation attempted to take the lock", competitorAttempts, 1);
  check("the snapshot was copied from the backup created by this pull", copySource.endsWith(".tar.gz"), true);
  check("the copied snapshot keeps the pre-copy state", files.get(snapshotPath), "state=OLD\n");
  check("the migrate sidecar belongs to the same pre-copy state", sidecar, "OPENAI_API_KEY=OLD_KEY_VALUE\n");
  check("the published snapshot is selected as newest", selectSnapshotPaths(`${snapshotPath}\n`, deploymentName())[0], snapshotPath);
  check("pull releases its lock after all sidecars are written", lockExists, false);
  check("the lock release leaves no holder file", [...files.keys()].some((path) => path.endsWith("holder.json")), false);
  const archiveMove = events.findIndex((event) => event.startsWith("mv:") && event.endsWith(` ${snapshotPath}`));
  const sidecarWrite = events.findIndex((event) => event.includes(".secrets.env"));
  check("the final archive is published after its sidecar was written", archiveMove > sidecarWrite, true);
}

// A failure after lock acquisition must release it as well. This uses the same atomic
// mkdir state, then proves a fresh operation can claim the instance after pull throws.
{
  const dataDir = "/srv/openclaw/data";
  let lockExists = false;
  const files = new Map<string, string>();
  let failCopy = true;
  const ctx = {
    settings: { dataDir, backupDir: "/srv/openclaw/backups", snapshotDir: "/srv/openclaw/snapshots", env: {} },
    transport: {
      description: "pull-error-lock-stub",
      async exists(path: string): Promise<boolean> { return path === dataDir || path.endsWith("openclaw.json"); },
      async readFile(path: string): Promise<string> {
        if (path.endsWith("holder.json")) return files.get(path) ?? "";
        if (path.endsWith("openclaw.json")) return "{}";
        return files.get(path) ?? "";
      },
      async writeFile(path: string, content: string): Promise<void> { files.set(path, content); },
      async remove(path: string): Promise<void> { if (path.endsWith("operation.lock")) lockExists = false; files.delete(path); },
      async mkdirp(): Promise<void> {},
      async exec(rawCommand: string, rawArgs: string[]): Promise<ExecResult> {
        const { command, args } = asDirectTest(rawCommand, rawArgs);
        if (command === "mkdir" && !args[0]?.startsWith("-")) {
          if (lockExists) return { code: 1, stdout: "", stderr: "File exists" };
          lockExists = true;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "test" && args[0] === "-d") return { code: lockExists ? 0 : 1, stdout: "", stderr: "" };
        if (command === "test" && args[0] === "-L") return { code: 1, stdout: "", stderr: "" };
        if (command === "test" && args[0] === "-w") return { code: 0, stdout: "", stderr: "" };
        // The instance lock's release now empties its directory with `rmdir`, not a
        // recursive remove of the whole lock path.
        if (command === "rmdir") {
          if (args[0]?.endsWith("operation.lock")) lockExists = false;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "tar" && args.includes("-tzf")) return { code: 0, stdout: "data/\ndata/config/openclaw.json\n", stderr: "" };
        if (command === "sh" && args.some((arg) => arg.includes("ls -1t"))) return { code: 0, stdout: "", stderr: "" };
        if (command === "cp" && failCopy) { failCopy = false; throw new Error("copy failed"); }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    runtime: { async isRunning(): Promise<boolean> { return false; } },
  } as unknown as Context;
  modelMutationGuard(ctx);

  let failedPull = false;
  try { await withOutputSink(() => {}, () => openclawCommands.pull.run(ctx, [])); } catch { failedPull = true; }
  const next = await takeLock(ctx, "after-failure", "op-after-failure");
  await next.release();
  check("pull propagates a copy failure", failedPull, true);
  check("pull releases its lock when copy fails", lockExists, false);
}

// Publication failures must leave neither a discoverable partial snapshot nor a held lock.
// The fake is deliberately small but models the target filesystem, mv --no-clobber and the
// commands needed by createBackup/pull so each failure is exercised through the real command.

for (const failure of ["template", "secrets", "verify", "archive", "archive-after-move", "archive-lost-ack", "template-lost-ack", "collision", "dangling", "missing-secrets"] as PullFailure[]) {
  const scenario = pullScenario(failure);
  modelMutationGuard(scenario.ctx);
  let threw = false;
  try {
    await withOutputSink(() => {}, () => openclawCommands.pull.run(scenario.ctx, failure === "verify" ? ["--share"] : []));
  } catch {
    threw = true;
  }
  const snapshots = [...scenario.files.keys()].filter((path) => path.includes("-state-") && path.endsWith(".tar.gz"));
  check(`pull ${failure} failure is reported`, threw, true);
  check(`pull ${failure} failure releases its lock`, scenario.lock(), false);
  check(`pull ${failure} failure leaves the previous snapshot intact`, scenario.files.get(`${"/srv/openclaw/snapshots"}/${deploymentName()}-state-2020-01-01T00-00-00.tar.gz`), "previous\n");
  check(
    `pull ${failure} failure leaves no incomplete archive`,
    snapshots.length,
    failure === "archive-after-move" || failure === "archive-lost-ack" ? 2 : 1,
  );
  if (failure === "archive") {
    check("archive publication failure removes its already moved template", [...scenario.files.keys()].some((path) => path.endsWith(".template.env") && path.includes("-state-")), false);
  }
  if (failure === "archive-after-move") {
    const published = snapshots.find((path) => !path.endsWith("2020-01-01T00-00-00.tar.gz"));
    check("uncertain archive publication retains the archive", published !== undefined, true);
    check("uncertain archive publication retains the template", published === undefined ? false : scenario.files.has(`${published}.template.env`), true);
    check("uncertain archive publication retains the secrets", published === undefined ? false : scenario.files.has(`${published}.secrets.env`), true);
  }
  if (failure === "archive-lost-ack") {
    const published = snapshots.find((path) => !path.endsWith("2020-01-01T00-00-00.tar.gz"));
    check("lost archive acknowledgement retains the archive", published !== undefined, true);
    check("lost archive acknowledgement retains the template", published === undefined ? false : scenario.files.has(`${published}.template.env`), true);
    check("lost archive acknowledgement retains the secrets", published === undefined ? false : scenario.files.has(`${published}.secrets.env`), true);
  }
  if (failure === "template-lost-ack") {
    check("lost sidecar acknowledgement removes the uncertain sidecar", [...scenario.files.keys()].some((path) => path.endsWith(".template.env") && path.includes("-state-")), false);
  }
}

finish("state pull lock");

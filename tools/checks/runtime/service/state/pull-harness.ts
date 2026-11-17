// Shared harness for driving the real pull() command against a modeled target filesystem:
// the stub transport models mv --no-clobber, the operation-lock protocol and the commands
// createBackup/pull issue, so each failure shape is exercised through the real command.
// This module has no top-level side effects — check files import it.

import { parseSnapshotArchive } from "#framework/service/archive/index.ts";
import { deploymentName } from "#framework/runtime/deployment.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";
import { asDirectTest } from "#checks/runtime/service/restore/file-test-stub.ts";

export type PullFailure = "template" | "secrets" | "verify" | "archive" | "archive-after-move" | "archive-lost-ack" | "template-lost-ack" | "private-path" | "collision" | "dangling" | "missing-secrets" | "private-neighbor";
export function pullScenario(failure?: PullFailure): { ctx: Context; files: Map<string, string>; events: string[]; lock: () => boolean } {
  const dataDir = "/srv/openclaw/data";
  const snapshotDir = "/srv/openclaw/snapshots";
  const files = new Map<string, string>();
  const events: string[] = [];
  let lockExists = false;
  let mutationGuardExists = false;
  const lockMarkers = new Set<string>();
  let archiveMoved = false;
  const oldSnapshot = `${snapshotDir}/${deploymentName()}-state-2020-01-01T00-00-00.tar.gz`;
  files.set(oldSnapshot, "previous\n");

  const ctx = {
    settings: { dataDir, backupDir: "/srv/openclaw/backups", snapshotDir, env: { OPENCLAW_GATEWAY_TOKEN: "long-enough-token" } },
    transport: {
      description: "publication-failure-stub",
      async exists(path: string): Promise<boolean> {
        if (failure === "missing-secrets" && path.endsWith("config/.env")) return false;
        if (failure === "collision" && path.includes("-state-") && path.endsWith(".tar.gz")) return true;
        return path === dataDir || path === snapshotDir || path.endsWith("config/openclaw.json") || path.endsWith("config/.env") || files.has(path);
      },
      async readFile(path: string): Promise<string> {
        if (path.endsWith("holder.json")) return files.get(path) ?? "";
        if (path.endsWith("config/openclaw.json")) return JSON.stringify({ models: { providers: { openai: {} } } });
        return files.get(path) ?? "OPENAI_API_KEY=OLD_KEY_VALUE\n";
      },
      async writeFile(path: string, content: string): Promise<void> {
        events.push(`write:${path}`);
        if (failure === "template" && path.endsWith(".template.env")) throw new Error("template write failed");
        if (failure === "secrets" && path.endsWith(".secrets.env")) throw new Error("secrets write failed");
        files.set(path, content);
      },
      async remove(path: string): Promise<void> {
        if (path.endsWith("operation.lock")) lockExists = false;
        files.delete(path);
      },
      async mkdirp(): Promise<void> {},
      async exec(rawCommand: string, rawArgs: string[]): Promise<ExecResult> {
        const { command, args } = asDirectTest(rawCommand, rawArgs);
        events.push(`${command}:${args.join(" ")}`);
        if (command === "ln") {
          const [source, destination] = args;
          if (source === undefined || destination === undefined || !files.has(source)) {
            return { code: 1, stdout: "", stderr: "No such file" };
          }
          if (files.has(destination)) return { code: 1, stdout: "", stderr: "File exists" };
          files.set(destination, files.get(source)!);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "mkdir") {
          const path = args[0] === "-m" ? args[2] : args[0];
          if (path?.endsWith("/operation.mutation")) {
            if (mutationGuardExists) return { code: 1, stdout: "", stderr: "File exists" };
            mutationGuardExists = true;
          } else if (path?.endsWith("/operation.lock")) {
            if (lockExists) return { code: 1, stdout: "", stderr: "File exists" };
            lockExists = true;
          } else if (path?.match(/\/operation\.lock\/gen-[a-f0-9]+$/)) {
            if (lockMarkers.has(path)) return { code: 1, stdout: "", stderr: "File exists" };
            lockMarkers.add(path);
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "test" && args[0] === "-d") {
          const path = args[1] ?? "";
          const exists = path.endsWith("/operation.mutation") ? mutationGuardExists : path.endsWith("/operation.lock") ? lockExists : false;
          return { code: exists ? 0 : 1, stdout: "", stderr: "" };
        }
        if (command === "test" && args[0] === "-w") return { code: 0, stdout: "", stderr: "" };
        // createBackup() asks `test -L` before archiving; the modeled data directory is a
        // real one, and the fall-through below would answer 0 — "is a symlink".
        if (command === "test" && args[0] === "-L") return { code: 1, stdout: "", stderr: "" };
        // The instance lock's release now empties its directory with `rmdir`, not a
        // recursive remove of the whole lock path — the same event this stub
        // already answers for a plain `remove()` of the lock path.
        if (command === "rmdir") {
          if (args[0]?.endsWith("/operation.mutation")) mutationGuardExists = false;
          if (args[0]?.endsWith("/operation.lock") && lockMarkers.size === 0) lockExists = false;
          lockMarkers.delete(args[0] ?? "");
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "test" && args[0] === "-e") {
          const path = args[1] ?? "";
          if (failure === "archive-after-move" && archiveMoved) {
            archiveMoved = false;
            throw new Error("publication confirmation failed");
          }
          return { code: path === dataDir || path === snapshotDir || files.has(path) || (failure === "collision" && path.includes("-state-") && path.endsWith(".tar.gz")) ? 0 : 1, stdout: "", stderr: "" };
        }
        if (command === "cp") {
          const source = args[args.length - 2] ?? "";
          const destination = args[args.length - 1] ?? "";
          files.set(destination, files.get(source) ?? "archive\n");
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "mv") {
          const source = args[args.length - 2] ?? "";
          const destination = args[args.length - 1] ?? "";
          if (lockMarkers.has(source)) {
            lockMarkers.delete(source);
            lockMarkers.add(destination);
            return { code: 0, stdout: "", stderr: "" };
          }
          if (failure === "archive" && destination.includes("-state-") && destination.endsWith(".tar.gz")) {
            return { code: 1, stdout: "", stderr: "publish failed" };
          }
          // GNU mv -n also protects a dangling symlink, while test -e does not see it.
          if (failure === "dangling" && destination.includes("-state-") && destination.endsWith(".tar.gz")) {
            return { code: 0, stdout: "", stderr: "" };
          }
          if (failure === "collision" && files.has(destination)) return { code: 0, stdout: "", stderr: "" };
          files.set(destination, files.get(source) ?? "");
          files.delete(source);
          if (failure === "archive-after-move" && destination.includes("-state-") && destination.endsWith(".tar.gz")) archiveMoved = true;
          if (
            (failure === "archive-lost-ack" && destination.includes("-state-") && destination.endsWith(".tar.gz")) ||
            (failure === "template-lost-ack" && destination.endsWith(".template.env"))
          ) throw new Error("publication acknowledgement lost");
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "rm") {
          for (const arg of args.filter((value) => !value.startsWith("-"))) {
            lockMarkers.delete(arg);
            for (const path of files.keys()) if (path === arg || path.startsWith(`${arg}/`)) files.delete(path);
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "tar" && args.includes("-czf")) {
          const archive = args[args.indexOf("-czf") + 1];
          if (archive !== undefined) files.set(archive, "archive\n");
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "tar" && args.includes("-tzf")) {
          return {
            code: 0,
            stdout: failure === "private-path"
              ? "data/\ndata/config/openclaw.json\ndata/recipe-private/credentials.env\n"
              // Entries that share a string prefix with a declared private path
              // (`vault` vs `vault-public`, `config/private.env` vs `config/private.env.example`)
              // but are public content — the false positive that made pull delete the backup
              // it had just taken.
              : failure === "private-neighbor"
                ? "data/\ndata/config/openclaw.json\ndata/vault-public/notes.txt\ndata/config/private.env.example\n"
                : "data/\ndata/config/openclaw.json\n",
            stderr: "",
          };
        }
        if (command === "tar" && args.includes("-tvzf")) return { code: 0, stdout: "drwxr-xr-x user/user 0 2026-01-01 00:00 data/\n", stderr: "" };
        if (command === "grep" && failure === "verify") return { code: 2, stdout: "", stderr: "scan failed" };
        if (command === "sh" && args.some((arg) => arg.includes("ls -1t"))) {
          const snapshots = [...files.keys()].filter((path) => parseSnapshotArchive(path.slice(path.lastIndexOf("/") + 1), deploymentName()) !== undefined);
          return { code: 0, stdout: `${snapshots.join("\n")}\n`, stderr: "" };
        }
        if (command === "du") return { code: 0, stdout: "1K\tarchive\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    // createBackup() now probes installed recipes' sidecar stacks for its running-recipe warning
    // (backup.ts calls runningRecipeStacks, one Stack.isRunning() per recipe). The harness
    // has recipes installed and, like the gateway above, answers for them: none running.
    runtime: {
      async isRunning(): Promise<boolean> { return false; },
      stack() {
        return {
          async isRunning(): Promise<boolean> { return false; },
        };
      },
    },
  } as unknown as Context;

  return { ctx, files, events, lock: () => lockExists };
}

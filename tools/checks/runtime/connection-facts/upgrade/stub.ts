// The upgrade() stub shared by upgrade.check.ts and pin-and-digest.check.ts: a backup/
// restore-compatible POSIX context (per restore.check.ts and backup.check.ts) plus the
// runtime primitives ./clawwright upgrade itself drives.

import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";
import { mountPoints } from "#framework/runtime/mounts.ts";
import { toContainerPath, fromContainerPath } from "#framework/core/paths.ts";
import { asDirectTest } from "#checks/runtime/service/restore/file-test-stub.ts";

export const DATA_DIR = "/srv/clawwright/data";
export const SHARED_TAG = "ghcr.io/openclaw/openclaw:extended-stable";
// Full 64-hex digests: the explicit-digest format check refuses anything shorter.
export const TARGET_DIGEST = `${SHARED_TAG.split(":")[0]}@sha256:${"1".repeat(64)}`;
export const PREVIOUS_DIGEST = `${SHARED_TAG.split(":")[0]}@sha256:${"3".repeat(64)}`;
// A pin left by a healthy bootstrap/upgrade under the tag-preserving form — the exact digest
// here is never resolved again; only its channel (SHARED_TAG) is.
export const PINNED_WITH_TAG = `${SHARED_TAG}@sha256:${"2".repeat(64)}`;
// A pin with no tag alongside the digest — the channel it came from cannot be recovered
// without guessing.
export const PINNED_NO_TAG = `${SHARED_TAG.split(":")[0]}@sha256:${"2".repeat(64)}`;

/** One recorded runtime call, shared with the checks that assert the call log. */
export const loggedCall = (name: string, arg: string): string => `${name} ${arg}`;

export type Scenario = "success" | "health-fail" | "exit78" | "doctor-fail";

/** A backup/restore-compatible POSIX stub, permissive by default (matching the proven shape
 *  restore.check.ts's own makeCtx() and backup.check.ts's stubBackupCtx() already use), plus
 *  the runtime primitives ./clawwright upgrade itself asks for. `image` overrides the
 *  deployment's own OPENCLAW_IMAGE, for the pinned-channel scenarios below. */
export function makeUpgradeCtx(scenario: Scenario, options: { image?: string; running?: string } = {}): { ctx: Context; calls: string[]; runningDigest: () => string } {
  const calls: string[] = [];
  const files = new Set([DATA_DIR]);
  let runningDigest = options.running ?? PREVIOUS_DIGEST;
  const holder = JSON.stringify({ operationId: "op", what: "x", by: "a@b pid 1", takenAt: new Date().toISOString() });

  const mounts = mountPoints(DATA_DIR);
  const ctx = {
    settings: { dataDir: DATA_DIR, backupDir: "/srv/clawwright/backups", env: {}, image: options.image ?? SHARED_TAG },
    paths: {
      toContainer: (path: string) => toContainerPath(path, mounts),
      fromContainer: (path: string) => fromContainerPath(path, mounts),
    },
    transport: {
      description: "stub",
      async exists(path: string): Promise<boolean> { return files.has(path) || path === DATA_DIR; },
      async readFile(path: string): Promise<string> {
        if (path.endsWith("holder.json")) return holder;
        return "{}";
      },
      async writeFile(): Promise<void> {},
      async mkdirp(): Promise<void> {},
      async remove(): Promise<void> {},
      async exec(rawCommand: string, rawArgs: string[]): Promise<ExecResult> {
        // File-test probes arrive as the shell builtin; the rules below key on `test`.
        const { command, args } = asDirectTest(rawCommand, rawArgs);
        calls.push(`exec ${rawCommand} ${rawArgs.join(" ")}`);
        if (command === "test" && args[0] === "-L") return { code: 1, stdout: "", stderr: "" };
        if (command === "readlink" && args[0] === "-f") return { code: 0, stdout: args[1] ?? "", stderr: "" };
        if (command === "stat") return { code: 0, stdout: "1000:1000", stderr: "" };
        if (command === "test") return { code: files.has(args[1] ?? "") || args[0] !== "-e" ? 0 : 1, stdout: "", stderr: "" };
        if (command === "mkdir" && args.length === 1) return { code: 0, stdout: "", stderr: "" };
        if (command === "tar" && args.includes("-tzf")) return { code: 0, stdout: "data/\ndata/config/openclaw.json\n", stderr: "" };
        if (command === "tar" && args.includes("-tvzf")) return { code: 0, stdout: "", stderr: "" };
        if (command === "tar" && args.includes("-czf")) { files.add(args[args.indexOf("-czf") + 1] ?? ""); return { code: 0, stdout: "", stderr: "" }; }
        if (command === "mv") {
          const source = args.at(-2) ?? "";
          const destination = args.at(-1) ?? "";
          if (files.has(source)) { files.delete(source); files.add(destination); }
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "find") return { code: 0, stdout: "", stderr: "" };
        if (command === "rm") return { code: 0, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    runtime: {
      description: "docker",
      async isRunning(): Promise<boolean> { return runningDigest === PREVIOUS_DIGEST || (scenario !== "health-fail" && scenario !== "exit78") || (scenario === "health-fail"); },
      async pause(): Promise<void> {},
      // Migration compensation restores while stopped, then recreates the previous image.
      async start(): Promise<void> { runningDigest = PREVIOUS_DIGEST; },
      async stop(): Promise<void> {},
      // Health fails only for the freshly recreated gateway: the restart after the stopped
      // pre-upgrade backup must succeed, so the scenario reaches the health gate it exists
      // to test instead of dying inside the backup.
      async waitForHealth(): Promise<void> {
        if (scenario === "health-fail" && runningDigest === TARGET_DIGEST) throw new Error("the service did not become healthy");
      },
      async probe(): Promise<number> { return scenario === "exit78" ? 0 : 200; },
      async lastExitCode(): Promise<number | undefined> {
        if (scenario === "exit78") return 78;
        return scenario === "health-fail" ? 1 : 0;
      },
      async resolveImageDigest(reference: string): Promise<string | undefined> {
        calls.push(loggedCall("resolveImageDigest", reference));
        // A digest reference is verified at the "registry" like buildx imagetools inspect
        // would: known digests answer themselves, anything else (a typo) is unknown.
        if (reference.includes("@sha256:")) {
          return [TARGET_DIGEST, PREVIOUS_DIGEST, PINNED_NO_TAG, PINNED_WITH_TAG].includes(reference) ? reference : undefined;
        }
        return reference === SHARED_TAG ? TARGET_DIGEST : undefined;
      },
      async recreateWithImage(reference: string, onMutationStart?: () => void): Promise<void> {
        calls.push(loggedCall("recreateWithImage", reference));
        onMutationStart?.();
        runningDigest = reference;
      },
      async runningImageIdentity(): Promise<{ imageId: string; digests: string[]; containerId: string }> {
        return { imageId: "id", digests: [runningDigest], containerId: "c" };
      },
      async runOneOff(_service: string, cliArgs: string[]): Promise<ExecResult> {
        calls.push(`runOneOff ${cliArgs.join(" ")}`);
        if (cliArgs[0] === "backup" && cliArgs[1] === "create") {
          // Simulates an image without native support: createBackup() falls back to its
          // classic stopped path, which this stub's transport already knows how to drive.
          return { code: 1, stdout: "", stderr: "error: unknown command 'backup'" };
        }
        if (cliArgs[0] === "doctor") {
          const findings = scenario === "doctor-fail" ? [{ severity: "error", checkId: "x", message: "broken" }] : [];
          return { code: findings.length > 0 ? 1 : 0, stdout: JSON.stringify({ ok: findings.length === 0, findings }), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;
  return { ctx, calls, runningDigest: () => runningDigest };
}

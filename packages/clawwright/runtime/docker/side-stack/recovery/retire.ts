import type { StackLock, StackRetireLegacyPlan, StackRetireLegacyResult } from "../../../runtime.ts";
import { shellQuote } from "../../../../core/io/shell.ts";
import { array, execResult, json, object, checkDeadline, RefusalError, remainingTimeout, text, type StackIO } from "../io.ts";
import { records } from "../inspection.ts";
import { createBackupRoot, verifyWriters, migrationPathSanitizer } from "../migration-plan.ts";
import { migrationFailure } from "../migration.ts";
import { backupStorage, storageHelperScript } from "../storage.ts";
import { tryParseLocalImageId } from "../../image-ref.ts";
import { prepareRetire, verifyRetireSignal, type RetirePrepared } from "./retire-plan.ts";

const restoreArgv = (helperImage: string, backupRoot: string, storage: { type: string; source: string; key: string }): string[] => [
  "docker", "run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--user", "0:0", "--security-opt", "no-new-privileges",
  "--mount", `type=${storage.type},${storage.type === "volume" ? "volume-nocopy," : ""}src=${storage.source},dst=/data`,
  "--mount", `type=bind,src=${backupRoot},dst=/backup`, "--entrypoint", "/bin/sh", helperImage, "-c", storageHelperScript("restore"), "sh", storage.key,
];
const renderArgv = (argv: readonly string[]): string => argv.map(shellQuote).join(" ");
const portBindings = (raw: Record<string, unknown>, sanitize: (value: string) => string): { containerPort: string; hostIp?: string; hostPort: string }[] => {
  const valid = (value: unknown): string | undefined => typeof value === "string" && value.length > 0
    && !value.includes("\r") && !value.includes("\n") && !value.includes("\0") && sanitize(value) === value ? value : undefined;
  const sources = [object(raw["HostConfig"] ?? {})["PortBindings"], object(raw["NetworkSettings"] ?? {})["Ports"]];
  const results = new Map<string, { containerPort: string; hostIp?: string; hostPort: string }>();
  for (const source of sources) {
    if (source === null || typeof source !== "object" || Array.isArray(source)) continue;
    for (const [containerPort, bindings] of Object.entries(source)) {
      if (!/^\d+\/(tcp|udp|sctp)$/.test(containerPort) || !Array.isArray(bindings)) continue;
      for (const binding of bindings) {
        if (binding === null || typeof binding !== "object" || Array.isArray(binding)) continue;
        const item = binding as Record<string, unknown>;
        const hostPort = valid(item["HostPort"]);
        const hostIp = valid(item["HostIp"]);
        if (hostPort === undefined) continue;
        const entry = { containerPort, ...(hostIp === undefined ? {} : { hostIp }), hostPort };
        results.set(JSON.stringify(entry), entry);
      }
    }
  }
  return [...results.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
};

export function retireAPI(io: StackIO): {
  planRetireLegacy: (options: Parameters<typeof prepareRetire>[1]) => Promise<StackRetireLegacyPlan>;
  retireLegacy: (plan: StackRetireLegacyPlan, lock: StackLock) => Promise<StackRetireLegacyResult>;
} {
  const plans = new Map<string, { prepared: RetirePrepared }>();
  return {
    planRetireLegacy: async (options) => {
      try { const prepared = await prepareRetire(io, options); plans.set(prepared.plan.token, { prepared }); return prepared.plan; }
      catch (error) { throw migrationFailure(io, error); }
    },
    retireLegacy: async (plan, lock) => {
      const saved = plans.get(plan.token);
      if (!saved || saved.prepared.plan !== plan) throw new RefusalError("recipe retire-legacy plan is not recognized", "retire-legacy.plan-unknown");
      try { return await lock(async () => {
        const p = await prepareRetire(io, { backupRoot: plan.backupRoot, shutdownTimeoutSeconds: plan.shutdownTimeoutSeconds, helperImage: plan.helperImage }, plan.token);
        if (p.fingerprint !== saved.prepared.fingerprint) throw new RefusalError("recipe retire-legacy plan is stale", "retire-legacy.plan-stale");
        plans.delete(plan.token);
        const t = io.transport;
        if (!t.mkdirPrivate || !t.writePrivateFile) throw new RefusalError("recipe retire-legacy requires private exclusive staging support", "retire-legacy.staging-unsupported");
        await createBackupRoot(io, plan.backupRoot);
        const journalPath = `${plan.backupRoot}/journal.json`;
        const write = t.writePrivateFile.bind(t);
        const events: { phase: string; detail?: string }[] = [];
        const journal = async (phase: string): Promise<void> => {
          events.push({ phase });
          await write(`${plan.backupRoot}/journal-${events.length - 1}.json`, JSON.stringify({ token: plan.token, legacyProject: plan.legacyProject, events: [...events] }));
        };
        const ids = p.containers.map((c) => c.id);
        const stopped = new Set<string>();
        const recovery = { stoppedContainers: [] as string[], restartArgv: [] as string[], restartCommand: "" };
        let removalStarted = false;
        const withRecovery = (message: string, code: string, stoppedIds: readonly string[]): RefusalError => {
          recovery.stoppedContainers = [...stoppedIds];
          recovery.restartArgv = stoppedIds.length ? ["docker", "start", ...stoppedIds] : [];
          recovery.restartCommand = stoppedIds.length ? renderArgv(recovery.restartArgv) : "";
          return Object.assign(new RefusalError(`${message}${stoppedIds.length ? `; recovery command: ${recovery.restartCommand}` : ""}`, code), recovery);
        };
        try {
          await journal("prepared");
          const deadline = Date.now() + plan.shutdownTimeoutSeconds * 1000;
          let result;
          try { result = execResult(await io.run(["stop", "--timeout", "-1", ...ids], undefined, remainingTimeout(deadline, plan.shutdownTimeoutSeconds * 1000))); }
          catch { throw new RefusalError("recipe retire-legacy container did not stop in time", "retire-legacy.stop-timeout"); }
          const stdout = result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
          const acknowledged = stdout === "" ? [] : stdout.split("\n");
          if (result.code !== 0 || result.timedOut || result.stderr !== "" || acknowledged.length !== ids.length
            || new Set(acknowledged).size !== acknowledged.length || acknowledged.some((id) => !ids.includes(id)))
            throw new RefusalError("recipe retire-legacy stop acknowledgement unknown", "retire-legacy.stop-timeout");
          checkDeadline(deadline);
          const cold = await records(io, plan.legacyProject, deadline);
          // Only containers this operation asked to stop may enter the recovery set: an unexpected
          // container in the namespace is never reported as ours nor offered for restart.
          const coldIds = cold.filter((c) => ids.includes(c.evidence.id) && ["exited", "created"].includes(c.evidence.state ?? "")).map((c) => c.evidence.id);
          for (const id of coldIds) stopped.add(id);
          if (cold.length !== p.containers.length || new Set(cold.map((c) => c.evidence.id)).size !== ids.length
            || cold.some((c) => !ids.includes(c.evidence.id) || !["exited", "created"].includes(c.evidence.state ?? "")))
            throw withRecovery("recipe retire-legacy container will not stop; refusing without kill or force", "retire-legacy.stop-unverified", [...stopped]);
          await journal("stopped-verified");
          for (const container of cold) {
            const original = p.raw[p.containers.findIndex((c) => c.id === container.evidence.id)]!;
            if (container.evidence.provenance !== "legacy" || JSON.stringify(container.raw["Config"]) !== JSON.stringify(original["Config"])
              || JSON.stringify(container.raw["Image"]) !== JSON.stringify(original["Image"])
              || JSON.stringify(container.raw["HostConfig"]) !== JSON.stringify(original["HostConfig"])
              || JSON.stringify(container.raw["Mounts"]) !== JSON.stringify(original["Mounts"]))
              throw withRecovery("recipe retire-legacy ownership or storage identity changed after stop", "retire-legacy.post-stop-identity", [...stopped]);
            const image = tryParseLocalImageId(container.evidence.imageId!);
            if (image === undefined) throw withRecovery("recipe retire-legacy requires an immutable local sha256 image ID", "retire-legacy.helper-image-invalid", [...stopped]);
            const found = array(json((await io.run(["image", "inspect", image], undefined, remainingTimeout(deadline))).stdout));
            if (found.length !== 1 || object(found[0])["Id"] !== image) throw withRecovery("recipe retire-legacy image is unavailable locally", "retire-legacy.image-unavailable", [...stopped]);
            if (verifyRetireSignal(object(object(found[0])["Config"]), image) !== verifyRetireSignal(object(container.raw["Config"]), image))
              throw withRecovery("recipe retire-legacy stop signal changed after stop", "retire-legacy.stop-signal-unsupported", [...stopped]);
          }
          try { await verifyWriters(io, p.storage, ids); }
          catch { throw withRecovery("recipe retire-legacy storage gained another writer after stop", "retire-legacy.writer-conflict-post-stop", [...stopped]); }
          await journal("writer-isolation-verified");
          try {
            for (const storage of p.storage) await backupStorage(io, { helperImage: p.helperImage, plan: { backupRoot: plan.backupRoot } }, storage);
          } catch { throw withRecovery("recipe retire-legacy cold backup failed", "retire-legacy.backup-failed", [...stopped]); }
          await journal("backups-verified");
          for (const [index, container] of p.containers.entries()) await write(`${plan.backupRoot}/inspect-${container.id}.json`, JSON.stringify(p.raw[index]));
          await journal("inspect-recorded");
          await write(`${plan.backupRoot}/manifest.json`, JSON.stringify({
            token: plan.token, legacyProject: plan.legacyProject, helperImage: p.helperImage, backupRoot: plan.backupRoot,
            images: p.containers.map((c) => ({ id: c.id, ...(c.service === undefined ? {} : { service: c.service }), imageId: c.imageId })),
            archives: p.storage.map((storage) => ({ key: storage.key, type: storage.type, source: storage.source, archive: `${storage.key}.tar`,
              restoreArgv: restoreArgv(p.helperImage, plan.backupRoot, storage), restore: renderArgv(restoreArgv(p.helperImage, plan.backupRoot, storage)) })),
            restoreScript: storageHelperScript("restore"),
          }));
          await journal("manifest-recorded");
          removalStarted = true;
          await io.run(["rm", ...ids]);
          if ((await records(io, plan.legacyProject)).length) throw new RefusalError("recipe retire-legacy container removal incomplete", "retire-legacy.removal-incomplete");
          await journal("retired");
          await write(journalPath, JSON.stringify({ token: plan.token, legacyProject: plan.legacyProject, events: [...events], complete: true }));
          const publicPath = (value: string): string => p.raw.reduce((path, raw) => migrationPathSanitizer(io, raw)(path), value);
          const publicRestoreArgv = (storage: (typeof p.storage)[number]): string[] => restoreArgv(p.helperImage, plan.backupRoot, storage).map((arg, index, argv) => {
            if (index === argv.indexOf("-c") + 1) return arg;
            if (arg.startsWith("type=") && arg.includes(",src=")) {
              const match = /^(type=[^,]+,(?:volume-nocopy,)?src=)(.*?)(,dst=.+)$/.exec(arg);
              return match ? `${match[1]}${publicPath(match[2]!)}${match[3]}` : publicPath(arg);
            }
            return index === argv.indexOf("--mount") + 1 || (index > argv.indexOf("--mount") && argv[index - 1] === "--mount")
              ? publicPath(arg) : arg;
          });
          const mounts = (container: (typeof cold)[number]) => (container.evidence.mounts ?? []).filter((m) => m.type !== "tmpfs")
            .map((m) => ({ type: m.type, source: m.source, destination: m.destination, ...(m.name === undefined ? {} : { name: m.name }) }));
          return {
            legacyProject: plan.legacyProject, backupRoot: plan.backupRoot, journalPath,
            removedContainers: plan.containers.map((c) => ({ id: c.id, ...(c.service === undefined ? {} : { service: c.service }), ...(c.imageId === undefined ? {} : { imageId: c.imageId }) })),
            retainedImages: plan.retainedImages,
            rollback: {
              inspectRecorded: true as const,
              archives: p.storage.map((storage) => ({ key: storage.key, type: storage.type, source: publicPath(storage.source), archive: `${storage.key}.tar`, helperImage: p.helperImage,
                restoreArgv: publicRestoreArgv(storage), restore: renderArgv(publicRestoreArgv(storage)) })),
              containers: cold.map((container) => ({ id: container.evidence.id, ...(container.evidence.service === undefined ? {} : { service: container.evidence.service }), imageId: container.evidence.imageId!,
                ports: portBindings(container.raw, migrationPathSanitizer(io, container.raw)), mounts: mounts(container),
                envNames: array(object(container.raw["Config"])["Env"] ?? []).map((entry) => text(entry).slice(0, text(entry).indexOf("="))).filter(Boolean).sort() })),
            },
          };
        } catch (error) {
          const code = error instanceof RefusalError ? error.code : "retire-legacy.post-stop-failed";
          if (stopped.size > 0 && !removalStarted && !(error instanceof RefusalError && "stoppedContainers" in error))
            throw migrationFailure(io, withRecovery(error instanceof Error ? error.message : "recipe retire-legacy failed", code, [...stopped]));
          throw migrationFailure(io, error);
        }
      }); } catch (error) { throw migrationFailure(io, error); }
    },
  };
}

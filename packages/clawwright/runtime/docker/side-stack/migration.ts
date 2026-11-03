import { migrationPathSanitizer, type SideStackMigrateOptions, type SideStackMigratePlan, type SideStackMigrationResult } from "./migration-plan.ts";
import { sleep } from "../../runtime.ts";
import type { MigrationBackupEvidence, MigrationBackupVerification } from "../../runtime.ts";
import type { StackLock, StackMigratePlan, StackMigrationEvidence, MigrationObservedState } from "../../runtime.ts";
import { prepareComposeDocument, executePreparedDocument, execResult, object, text, definitionLabel, digestLabel, documentDigest, remainingTimeout, checkDeadline, RefusalError, type StackIO } from "./io.ts";
import { records, type ContainerRecord } from "./inspection.ts";
import { prepareMigration, createBackupRoot, verifyWriters, verifyReadonlyBind, assertMigrationConfig, assertRestartPolicy, assertWritableLayerMetadata, rawMounts, gentleSignal, shutdownSeconds, type MigrationPrepared, type ReadonlyBindProof } from "./migration-plan.ts";
import { backupStorage, checkHelper, restoreBind, transferStorage, verifyTopology, verifyTargetVolume } from "./storage.ts";
import { waitReady } from "./recovery/index.ts";

// Never retain raw exceptions (including AggregateError children or causes).
export function migrationFailure(io: StackIO, error: unknown): Error {
  const wrap = (message: string, source: unknown): Error => source instanceof RefusalError
    ? new RefusalError(message, source.code) : new Error(message);
  if (error instanceof AggregateError) return new AggregateError(Array.from(error.errors, (child) => migrationFailure(io, child)), io.sanitize(error.message));
  const result = wrap(io.sanitize(error instanceof Error ? error.message : "recipe migration operation failed"), error);
  if (result instanceof RefusalError) {
    for (const key of ["stoppedContainers", "restartArgv", "restartCommand"] as const)
      if (key in (error as object)) Object.assign(result, { [key]: key === "restartCommand" ? io.sanitize(String((error as unknown as Record<string, unknown>)[key])) : (error as unknown as Record<string, unknown>)[key] });
  }
  return result;
}
const identity = (raw: Record<string, unknown>): string => JSON.stringify({
  Id: raw["Id"], Image: raw["Image"], Config: raw["Config"], HostConfig: raw["HostConfig"], Mounts: raw["Mounts"],
});
export function observedMigrationState(expected: readonly string[], observed: readonly { id: string; state?: string }[]): MigrationObservedState {
  if (!observed.length) return "absent";
  const ids = observed.map((c) => c.id);
  if (new Set(ids).size !== ids.length || observed.some((c) => !expected.includes(c.id)
    || !["running", "exited", "created"].includes(c.state ?? ""))) return "unknown";
  if (observed.length !== expected.length) return "partial";
  if (observed.every((c) => c.state === "running")) return "running";
  if (observed.every((c) => ["exited", "created"].includes(c.state ?? ""))) return "stopped";
  return "partial";
}

const timestampKey = (stamp: string): string => {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(stamp);
  if (!match || !Number.isFinite(Date.parse(stamp))) throw new Error("recipe migration timestamp unknown");
  return `${match[1]}.${(match[2] ?? "").padEnd(9, "0")}Z`;
};

export function verifyMigrationReceipt(value: unknown): MigrationBackupVerification {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Reflect.ownKeys(value).length !== 1 || !Object.hasOwn(value, "verified")
    || (value as Record<string, unknown>).verified !== true)
    throw new Error("recipe migration post-stop verification refused, unknown or malformed result");
  return Object.freeze({ verified: true });
}

export function migrationAPI(io: StackIO): {
  planMigrate: (options: SideStackMigrateOptions) => Promise<SideStackMigratePlan>;
  migrate: (plan: StackMigratePlan, lock: StackLock) => Promise<SideStackMigrationResult>;
} {
  const plans = new Map<string, { prepared: MigrationPrepared; options: SideStackMigrateOptions }>();
  const captureReadonlyProofs = async (originals: readonly ReadonlyBindProof[]): Promise<ReadonlyBindProof[]> => {
    const captured: ReadonlyBindProof[] = [];
    for (const original of originals) {
      const proof = await verifyReadonlyBind(io, { source: original.source, root: original.root });
      if (proof.identity.split("\n")[0] !== original.identity.split("\n")[0])
        throw new Error("recipe migration readonly bind root identity changed");
      captured.push(proof);
    }
    return captured;
  };
  const verifySource = async (p: MigrationPrepared, permitted: readonly string[] = p.containers.map((c) => c.id),
    proofs: readonly ReadonlyBindProof[] = p.readonlyBindProofs): Promise<void> => {
    const stopped = await records(io, p.plan.sourceProject);
    if (stopped.length !== p.containers.length || stopped.length === 0 || stopped.some((c) => {
      const old = p.raw.find((entry) => entry["Id"] === c.evidence.id);
      const state = object(c.raw["State"]);
      return !old || c.evidence.provenance !== "legacy" || identity(old) !== identity(c.raw)
        || !["exited", "created"].includes(c.evidence.state ?? "")
        || c.evidence.exitCode !== 0 || state["OOMKilled"] !== false || state["Paused"] === true || state["Restarting"] === true;
    })) throw new Error("recipe migration source clean shutdown or identity could not be proved");
    for (const c of stopped) {
      const service = object(object(p.sourceDocument["services"])[c.evidence.service!]);
      assertRestartPolicy(object(c.raw["HostConfig"]), service, service);
      assertMigrationConfig(service, p.imageConfigs[c.evidence.service!]!, [c.raw], p.sourceDocument);
      assertWritableLayerMetadata((await io.run(["diff", c.evidence.id])).stdout, rawMounts(c.raw), p.ephemeralPaths, migrationPathSanitizer(io, c.raw));
    }
    await verifyWriters(io, p.storage, permitted);
    for (const storage of p.storage) await verifyTopology(io, storage);
    for (const proof of proofs) await verifyReadonlyBind(io, proof);
    // Omitting file equality never omits canonical regular-file or original root identity checks.
    await captureReadonlyProofs(p.readonlyBindProofs.filter((original) =>
      !proofs.some((proof) => proof.source === original.source && proof.root === original.root)));
  };
  const gentleShutdown = async (p: MigrationPrepared, namespace: string, expected: readonly ContainerRecord[]): Promise<void> => {
    if (expected.length === 0) return;
    const deadline = Date.now() + shutdownSeconds(p.plan.shutdownTimeoutSeconds) * 1000;
    const boundedIO: StackIO = { ...io, run: (args, input, timeout) => io.run(args, input, remainingTimeout(deadline, timeout)) };
    for (const c of expected) {
      const signal = gentleSignal(p.imageConfigs[c.evidence.service!]!);
      const document = namespace === io.project ? p.document : p.sourceDocument;
      const service = object(object(document["services"])[c.evidence.service!]);
      assertRestartPolicy(object(c.raw["HostConfig"]), service, service);
      assertMigrationConfig(service, p.imageConfigs[c.evidence.service!]!, [c.raw], document);
      if ((object(c.raw["Config"])["StopSignal"] === undefined ? "SIGTERM" : object(c.raw["Config"])["StopSignal"]) !== signal)
        throw new Error("recipe migration writer stop signal changed");
    }
    const allExpectedIDs = expected.map((c) => c.evidence.id);
    const requestedIDs = new Set(allExpectedIDs);
    if (requestedIDs.size !== allExpectedIDs.length || allExpectedIDs.some((id) => !/^[a-f0-9]{64}$/.test(id)))
      throw new Error("recipe migration writer stop identities unproven");
    try {
      const result = execResult(await io.run(["stop", "--timeout", "-1", ...allExpectedIDs], undefined,
        remainingTimeout(deadline, shutdownSeconds(p.plan.shutdownTimeoutSeconds) * 1000)));
      const acknowledgedIDs = (result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout).split("\n");
      if (result.code !== 0 || result.timedOut || result.stderr !== ""
        || acknowledgedIDs.length !== requestedIDs.size || new Set(acknowledgedIDs).size !== acknowledgedIDs.length
        || acknowledgedIDs.some((id) => !/^[a-f0-9]{64}$/.test(id) || !requestedIDs.has(id)))
        throw new Error("recipe migration manual stop acknowledgement unknown; daemon shutdown may still be pending");
      checkDeadline(deadline);
    } catch {
      throw new Error("recipe migration manual stop acknowledgement unknown; daemon shutdown may still be pending");
    }
    while (true) {
      const current = await records(io, namespace, deadline);
      if (current.length !== expected.length || current.some((c) => {
        const before = expected.find((old) => old.evidence.id === c.evidence.id);
        const state = object(c.raw["State"]);
        return !before || identity(before.raw) !== identity(c.raw) || state["OOMKilled"] !== false
          || state["Paused"] === true || state["Restarting"] === true
          || !["running", "exited", "created"].includes(c.evidence.state ?? "")
          || (c.evidence.state !== "running" && c.evidence.exitCode !== 0);
      })) throw new Error("recipe migration gentle shutdown identity/state unproven");
      await verifyWriters(boundedIO, p.storage, [...p.containers.map((c) => c.id),
        ...(namespace === io.project ? expected.map((c) => c.evidence.id) : [])]);
      checkDeadline(deadline);
      if (current.every((c) => c.evidence.state !== "running")) return;
      await sleep(Math.min(250, remainingTimeout(deadline)));
    }
  };
  const identifyTarget = async (p: MigrationPrepared, c: ContainerRecord): Promise<void> => {
    const file = await io.file();
    const services = object(p.document["services"]);
    const expected = documentDigest({ ...p.document, services: Object.fromEntries(Object.entries(services).map(([name, value]) => {
      const service = object(value);
      return [name, { ...service, labels: { ...object(service["labels"] ?? {}), [definitionLabel]: file } }];
    })) });
    const name = c.evidence.service;
    const labels = object(object(c.raw["Config"])["Labels"]);
    const provenance = text(labels["com.docker.compose.project.config_files"]);
    if (!name || !p.plan.services.includes(name) || c.evidence.provenance !== "matched" || provenance === file || labels[digestLabel] !== expected
      || c.evidence.imageId !== p.containers.find((old) => old.service === name)?.imageId)
      throw new Error("recipe migration target transaction image/provenance unproven");
    const service = object(services[name]);
    const sourceService = object(object(p.sourceDocument["services"])[name]);
    const signal = gentleSignal(p.imageConfigs[name]!);
    const config = object(c.raw["Config"]);
    if ((config["StopSignal"] === undefined ? "SIGTERM" : config["StopSignal"]) !== signal
      || (service["stop_signal"] !== undefined && service["stop_signal"] !== signal)
      || (sourceService["stop_signal"] !== undefined && sourceService["stop_signal"] !== signal))
      throw new Error("recipe migration target stop signal unproven");
    assertRestartPolicy(object(c.raw["HostConfig"]), service, service);
    assertMigrationConfig(service, p.imageConfigs[name]!, [c.raw], p.document);
  };
  const verifyTarget = async (p: MigrationPrepared, complete = true): Promise<ContainerRecord[]> => {
    const target = await records(io, io.project);
    if ((complete && target.length !== p.plan.services.length) || target.length === 0) throw new Error("recipe migration target writer inventory missing");
    for (const c of target) {
      await identifyTarget(p, c);
      if (target.filter((other) => other.evidence.service === c.evidence.service).length !== 1)
        throw new Error("recipe migration target replica identity unproven");
    }
    await verifyWriters(io, p.storage, [...p.containers.map((c) => c.id), ...target.map((c) => c.evidence.id)]);
    for (const storage of p.storage) await verifyTargetVolume(io, p, storage);
    return target;
  };
  return {
    planMigrate: async (options) => {
      try {
        const prepared = await prepareMigration(io, options);
        plans.set(prepared.plan.token, { prepared, options: { ...options, ephemeralPaths: prepared.ephemeralPaths, migrationBackup: prepared.plan.migrationBackup } });
        return prepared.plan;
      } catch (error) { throw migrationFailure(io, error); }
    },
    migrate: async (plan, lock) => {
      const saved = plans.get(plan.token);
      if (!saved || saved.prepared.plan !== plan) throw new Error("recipe migration plan is not recognized");
      try { return await lock(async () => {
        const p = await prepareMigration(io, saved.options, plan.token);
        if (p.fingerprint !== saved.prepared.fingerprint) throw new Error("recipe migration plan is stale");
        const t = io.transport;
        if (!t.mkdirPrivate || !t.writePrivateFile) throw new Error("recipe migration requires private exclusive staging support");
        await checkHelper(io, p);
        const targetDocument = await prepareComposeDocument(io, p.document, [plan.backupRoot]);
        plans.delete(plan.token);
        await createBackupRoot(io, plan.backupRoot);
        const journalPath = `${plan.backupRoot}/journal.json`;
        const events: { phase: string; detail?: string; evidence: StackMigrationEvidence }[] = [];
        const evidence: { -readonly [K in keyof StackMigrationEvidence]: StackMigrationEvidence[K] } = {
          applicationVerification: plan.migrationBackup.consistency === "application-cold-safe" ? "author-guaranteed" : "pending",
          cleanShutdownVerified: false, archivesVerified: false, sourceResumeAttempted: false,
          source: "unknown", target: "absent",
        };
        const observe = async (): Promise<void> => {
          for (const side of ["source", "target"] as const) {
            try {
              const inventory = await records(io, side === "source" ? plan.sourceProject : io.project);
              if (side === "source") {
                for (const c of inventory) {
                  const old = p.raw.find((raw) => raw["Id"] === c.evidence.id);
                  if (!old || c.evidence.provenance !== "legacy" || identity(old) !== identity(c.raw))
                    throw new Error("recipe migration observed source identity unproven");
                  const service = object(object(p.sourceDocument["services"])[c.evidence.service!]);
                  assertRestartPolicy(object(c.raw["HostConfig"]), service, service);
                  assertMigrationConfig(service, p.imageConfigs[c.evidence.service!]!, [c.raw], p.sourceDocument);
                }
                evidence.source = observedMigrationState(p.containers.map((c) => c.id), inventory.map((c) => ({ id: c.evidence.id, state: c.evidence.state })));
              } else {
                for (const c of inventory) await identifyTarget(p, c);
                evidence.target = observedMigrationState(plan.services, inventory.map((c) => ({ id: c.evidence.service!, state: c.evidence.state })));
              }
            } catch { evidence[side] = "unknown"; }
          }
        };
        const snapshot = () => ({ token: plan.token, ignoredEphemeralPaths: p.plan.ignoredEphemeralPaths, migrationBackup: plan.migrationBackup, evidence: { ...evidence }, events, storage: p.storage });
        let sequence = 0;
        const journal = async (phase: string, detail?: string): Promise<void> => {
          events.push({ phase, evidence: { ...evidence }, ...(detail ? { detail: io.sanitize(detail) } : {}) });
          await t.writePrivateFile!(`${plan.backupRoot}/journal-${sequence++}.json`, JSON.stringify(snapshot()));
        };
        let stopping = false;
        let targetMayWrite = false;
        let backupsVerified = false;
        let sourceRemovalAttempted = false;
        try {
          await journal("prepared");
          const boundaryResult = plan.migrationBackup.consistency === "application-verified-cold"
            ? execResult(await t.exec("date", ["-u", "+%Y-%m-%dT%H:%M:%S.%NZ"], { allowFailure: true, timeoutMs: 10_000 })) : undefined;
          const stopStartedAt = boundaryResult?.stdout.trim() ?? "";
          if (boundaryResult && (boundaryResult.code !== 0 || boundaryResult.timedOut
            || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{9}Z$/.test(stopStartedAt) || !Number.isFinite(Date.parse(stopStartedAt))))
            throw new Error("recipe migration target stop boundary unknown");
          for (const proof of p.readonlyBindProofs) await verifyReadonlyBind(io, proof);
          stopping = true;
          const running = p.containers.filter((c) => c.state === "running").map((c) => c.id);
          await gentleShutdown(p, plan.sourceProject, p.raw.map((raw, i) => ({ raw, evidence: p.containers[i]! })));
          await verifySource(p);
          evidence.cleanShutdownVerified = true;
          evidence.source = "stopped";
          await journal("source-clean-shutdown-verified");
          if (plan.migrationBackup.consistency === "application-verified-cold") {
            // Conditional evidence must describe this stop, not an earlier exited source.
            await verifySource(p);
            const cold = await records(io, plan.sourceProject);
            if (cold.length !== p.containers.length || cold.length === 0
              || new Set(cold.map((c) => c.evidence.id)).size !== cold.length)
              throw new Error("recipe migration current stop inventory unproven");
            const containers = cold.map((c) => {
              const old = p.raw.find((raw) => raw["Id"] === c.evidence.id);
              const finishedAt = text(object(c.raw["State"])["FinishedAt"]);
              if (!old || identity(old) !== identity(c.raw) || c.evidence.provenance !== "legacy"
                || c.evidence.state !== "exited" || c.evidence.exitCode !== 0
                || !/^[a-f0-9]{64}$/.test(c.evidence.id) || !c.evidence.service
                || !running.includes(c.evidence.id) || timestampKey(finishedAt) < timestampKey(stopStartedAt))
                throw new Error("recipe migration current stop timestamp/identity unproven");
              return Object.freeze({ id: c.evidence.id, service: c.evidence.service,
                exitCode: c.evidence.exitCode, finishedAt });
            });
            const observed: MigrationBackupEvidence = Object.freeze({
              sourceProject: plan.sourceProject, targetProject: plan.targetProject, stopStartedAt,
              containers: Object.freeze(containers) });
            const operation = Promise.resolve().then(() => saved.options.verifyMigrationBackup!(observed));
            let timer: NodeJS.Timeout | undefined;
            let receipt: MigrationBackupVerification;
            try {
              receipt = verifyMigrationReceipt(await Promise.race([operation, new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("recipe migration read-only verifier timed out after 30000ms")), 30_000);
              })]));
            } finally { clearTimeout(timer); }
            await verifySource(p);
            const after = await records(io, plan.sourceProject);
            if (after.length !== containers.length || new Set(after.map((c) => c.evidence.id)).size !== after.length
              || after.some((c) => {
                const old = p.raw.find((raw) => raw["Id"] === c.evidence.id);
                return !old || identity(old) !== identity(c.raw) || c.evidence.provenance !== "legacy"
                  || c.evidence.state !== "exited" || c.evidence.exitCode !== 0
                  || text(object(c.raw["State"])["FinishedAt"]) !== containers.find((entry) => entry.id === c.evidence.id)?.finishedAt;
              }))
              throw new Error("recipe migration stop evidence changed during verification");
            evidence.applicationVerification = "verified";
            await journal("application-stop-verified", JSON.stringify(receipt));
          }
          for (const storage of p.storage) {
            await verifySource(p);
            await backupStorage(io, p, storage);
            await verifySource(p);
          }
          backupsVerified = true;
          evidence.archivesVerified = true;
          await journal("backups-verified");
          for (const storage of p.storage) {
            await verifySource(p);
            await transferStorage(io, p, storage);
          }
          await verifySource(p);
          await journal("transfers-verified");
          evidence.target = "unknown";
          await journal("target-starting");
          await executePreparedDocument(io, targetDocument, ["up", "--detach", "--no-build", "--pull", "never"], () => { targetMayWrite = true; });
          // These are source-path proofs, not proof of the containers' mounted inode identities.
          // Success retains the original file identities; only verified restore may replace them.
          for (const proof of p.readonlyBindProofs) await verifyReadonlyBind(io, proof);
          await waitReady(io, plan.services, p.seconds, true);
          const target = await verifyTarget(p);
          const permitted = [...p.containers.map((c) => c.id), ...target.map((c) => c.evidence.id)];
          await verifySource(p, permitted);
          evidence.target = "running";
          await journal("target-ready-source-removal-starting");
          await verifySource(p, permitted);
          // No --volumes, --force, Compose down, or namespace-wide deletion.
          sourceRemovalAttempted = true;
          await io.run(["rm", ...p.containers.map((c) => c.id)]);
          if ((await records(io, plan.sourceProject)).length) throw new Error("recipe migration old container removal incomplete");
          evidence.source = "absent";
          await journal("committed-source-volumes-backups-retained");
          await t.writePrivateFile!(journalPath, JSON.stringify(snapshot()));
          return { ignoredEphemeralPaths: p.plan.ignoredEphemeralPaths, backupRoot: plan.backupRoot, journalPath, retainedSource: true, migrationBackup: plan.migrationBackup, evidence: Object.freeze({ ...evidence }) };
        } catch (primary) {
          if (evidence.applicationVerification === "pending") evidence.applicationVerification = "unknown";
          const failures: Error[] = [migrationFailure(io, primary)];
          let safeResume = !sourceRemovalAttempted && evidence.cleanShutdownVerified;
          let resumed = false;
          const postRestoreProofs: ReadonlyBindProof[] = [];
          const restoredRoots = new Set<string>();
          if (targetMayWrite && !sourceRemovalAttempted) {
            try {
              // Stop individually proven transaction writers even when up created only
              // a subset or another target entry is foreign. Never adopt unknown entries.
              const observed = await records(io, io.project);
              const target: ContainerRecord[] = [];
              const stopFailures: Error[] = [];
              for (const c of observed) {
                try { await identifyTarget(p, c); target.push(c); }
                catch (error) { stopFailures.push(migrationFailure(io, error)); }
              }
              try { await gentleShutdown(p, io.project, target); }
              catch (error) { stopFailures.push(migrationFailure(io, error)); }
              if (stopFailures.length) throw new AggregateError(stopFailures, "recipe migration target stop unproven; unproven target entries were not stopped");
              const cold = await verifyTarget(p, false);
              if (cold.length !== target.length || cold.some((c) => {
                const before = target.find((old) => old.evidence.id === c.evidence.id);
                return !before || identity(before.raw) !== identity(c.raw) || !["exited", "created"].includes(c.evidence.state ?? "")
                  || c.evidence.exitCode !== 0 || object(c.raw["State"])["OOMKilled"] !== false;
              })) throw new Error("recipe migration same target writers clean shutdown unproven");
              evidence.target = "stopped";
              const permitted = [...p.containers.map((c) => c.id), ...cold.map((c) => c.evidence.id)];
              await verifySource(p, permitted, []);
              if (!backupsVerified) throw new Error("recipe migration rollback backups unproven");
              // Pre-restore captures are structural safety observations, not adopted resume proofs.
              let trackingProofs = await captureReadonlyProofs(p.readonlyBindProofs);
              const verifyColdTarget = async (): Promise<void> => {
                const now = await verifyTarget(p, false);
                if (now.length !== cold.length || now.some((c) => {
                  const before = cold.find((old) => old.evidence.id === c.evidence.id);
                  return !before || identity(before.raw) !== identity(c.raw) || !["exited", "created"].includes(c.evidence.state ?? "")
                    || c.evidence.exitCode !== 0 || object(c.raw["State"])["OOMKilled"] !== false;
                })) throw new Error("recipe migration rollback writers no longer cold");
              };
              for (const storage of p.storage.filter((s) => s.type === "bind")) {
                await verifyColdTarget();
                await verifySource(p, permitted, []);
                // Revalidate every captured file, including other roots, at the restore boundary.
                for (const proof of trackingProofs) await verifyReadonlyBind(io, proof);
                await restoreBind(io, p, storage);
                // Only archive/checksum/tar-compare success authorizes new file identities for this root.
                const restored = await captureReadonlyProofs(p.readonlyBindProofs.filter((proof) => proof.root === storage.source));
                postRestoreProofs.push(...restored);
                restoredRoots.add(storage.source);
                trackingProofs = [...trackingProofs.filter((proof) => proof.root !== storage.source), ...restored];
              }
              if (p.readonlyBindProofs.some((original) => !restoredRoots.has(original.root)
                || !postRestoreProofs.some((proof) => proof.source === original.source && proof.root === original.root)))
                throw new Error("recipe migration readonly bind restoration coverage unproven");
              await verifySource(p, permitted, []);
              for (const proof of trackingProofs) await verifyReadonlyBind(io, proof);
              // Remove only cold, exact transaction writers so resumed source cannot
              // later share its binds with a restart of an abandoned target.
              await verifyColdTarget();
              await io.run(["rm", ...cold.map((c) => c.evidence.id)]);
              if ((await records(io, io.project)).length) throw new Error("recipe migration rollback target removal incomplete");
            } catch (error) { safeResume = false; failures.push(migrationFailure(io, error)); }
          }
          if (stopping && safeResume) {
            try {
              if (targetMayWrite && p.readonlyBindProofs.some((original) => !restoredRoots.has(original.root)
                || !postRestoreProofs.some((proof) => proof.source === original.source && proof.root === original.root)))
                throw new Error("recipe migration readonly bind restoration coverage unproven");
              await verifySource(p, undefined, targetMayWrite ? postRestoreProofs : p.readonlyBindProofs);
              const originallyRunning = p.containers.filter((c) => c.state === "running").map((c) => c.id);
              if (originallyRunning.length) {
                evidence.source = "unknown";
                evidence.sourceResumeAttempted = true;
                await journal("source-resume-intent");
                await io.run(["start", ...originallyRunning]);
              }
              const current = await records(io, plan.sourceProject);
              if (current.length !== p.containers.length || current.some((c) => {
                const old = p.raw.find((raw) => raw["Id"] === c.evidence.id);
                const wasRunning = originallyRunning.includes(c.evidence.id);
                return !old || identity(old) !== identity(c.raw) || c.evidence.provenance !== "legacy"
                  || (wasRunning && c.evidence.state !== "running");
              })) throw new Error("recipe migration source resume not verified");
              resumed = true;
            } catch (error) { safeResume = false; failures.push(migrationFailure(io, error)); }
          }
          await observe();
          try {
            await journal(resumed ? "compensated-source-resume-verified" : "recovery-required", failures.map((e) => e.message).join("; "));
            await t.writePrivateFile!(journalPath, JSON.stringify(snapshot()));
          } catch { failures.push(new Error("recipe private journal finalization failed; phase journals retained")); }
          throw new AggregateError(failures, io.sanitize(`recipe migration failed; recovery artifacts at ${plan.backupRoot}; ${resumed ? "source resume verified" : "manual verified recovery required"}; observed source=${evidence.source}, target=${evidence.target}, sourceResumeAttempted=${evidence.sourceResumeAttempted}; do not blindly resume either stack`));
        }
      }); } catch (error) { throw migrationFailure(io, error); }
    },
  };
}

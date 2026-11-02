// Read-only inventory for `recipe retire-legacy`: the same proven-ownership rules as
// inspect/migrate (requireOwned + records), reduced to what retiring a legacy stack needs —
// one populated legacy namespace, an empty current namespace, and the writable storage that
// a cold backup must cover before the containers are removed. No service-set or document
// comparison: unlike migrate, the legacy stack is allowed to no longer match the definition.
// Every refusal here fires before anything is stopped, and carries a structured code.

import { randomUUID } from "node:crypto";
import type { StackContainerEvidence, StackRetireLegacyOptions, StackRetireLegacyPlan } from "../../../runtime.ts";
import { array, json, object, RefusalError, type StackIO } from "../io.ts";
import { records, requireOwned } from "../inspection.ts";
import { overlaps, rawMounts, safePath, shutdownSeconds, stable, verifyWriters, gentleSignal, type Storage } from "../migration-plan.ts";
import { checkHelper, verifyTopology } from "../storage.ts";
import { tryParseLocalImageId } from "../../image-ref.ts";

export interface RetirePrepared {
  plan: StackRetireLegacyPlan;
  /** Precise writable storage (raw mount identities), for the backup executor only. */
  storage: Storage[];
  containers: readonly StackContainerEvidence[];
  /** Raw pre-stop inspect records, aligned with `containers`; persisted before removal. */
  raw: Record<string, unknown>[];
  /** Per-image Config records, keyed by immutable local image ID. */
  imageConfigs: Record<string, Record<string, unknown>>;
  helperImage: string;
  fingerprint: string;
}

export const RETIRE_OPERATIONS = Object.freeze([
  "docker stop the legacy containers (graceful, bounded, never forced)",
  "re-inspect and verify every legacy container stopped",
  "cold backup of writable binds and named volumes into the private recovery directory",
  "docker rm the legacy containers only (no volumes, no images, no recipe data directory)",
  "write the retire journal and report rollback steps",
] as const);

const CODES = {
  backupRoot: "retire-legacy.backup-root-unsafe",
  populated: "retire-legacy.namespace-populated",
  absent: "retire-legacy.no-legacy",
  multiple: "retire-legacy.multiple-legacy",
  ownership: "retire-legacy.ownership-unproven",
  bind: "retire-legacy.bind-unsafe",
  volume: "retire-legacy.volume-unproven",
  helperInvalid: "retire-legacy.helper-image-invalid",
  helperUnavailable: "retire-legacy.helper-image-unavailable",
  imageUnavailable: "retire-legacy.image-unavailable",
  stopSignal: "retire-legacy.stop-signal-unsupported",
  capability: "retire-legacy.helper-capability",
  writers: "retire-legacy.writer-conflict",
} as const;

const refuse = (code: keyof typeof CODES, message: string): never => { throw new RefusalError(message, CODES[code]); };

export function verifyRetireSignal(config: Record<string, unknown>, imageId: string): "SIGTERM" | "SIGINT" {
  try { return gentleSignal(config); } catch {
    return refuse("stopSignal", `recipe retire-legacy image ${imageId} stop signal is unsupported; only SIGTERM/SIGINT are established`);
  }
}

async function imageConfig(io: StackIO, image: string, unavailable: keyof typeof CODES): Promise<Record<string, unknown>> {
  const parsed = tryParseLocalImageId(image);
  if (parsed === undefined) return refuse("helperInvalid", "recipe retire-legacy requires an immutable local sha256 image ID");
  let found: unknown[];
  try { found = array(json((await io.run(["image", "inspect", parsed])).stdout)); }
  catch { return refuse(unavailable, `recipe retire-legacy image ${parsed} is unavailable locally`); }
  if (found.length !== 1 || object(found[0])["Id"] !== parsed)
    return refuse(unavailable, `recipe retire-legacy image ${parsed} is unavailable locally`);
  return object(object(found[0])["Config"]);
}

export async function prepareRetire(io: StackIO, options: StackRetireLegacyOptions, token: string = randomUUID()): Promise<RetirePrepared> {
  if (!safePath(options.backupRoot)) refuse("backupRoot", "recipe retire-legacy requires a safe absolute backup root");
  const shutdownTimeoutSeconds = shutdownSeconds(options.shutdownTimeoutSeconds);
  const owned = await requireOwned(io, true).catch((error: unknown) =>
    refuse("ownership", error instanceof Error ? error.message : "recipe retire-legacy ownership is unproven"));
  if (owned.containers.some((c) => c.project === io.project)) refuse("populated", "recipe retire-legacy target namespace is populated");
  const populated = [...new Set(owned.containers.map((c) => c.project))];
  if (populated.length === 0) refuse("absent", "recipe retire-legacy found no populated legacy namespace");
  if (populated.length > 1) refuse("multiple", "recipe retire-legacy requires exactly one populated legacy namespace");
  const legacyProject = populated[0]!;
  const inventory = await records(io, legacyProject);
  const storage: Storage[] = [];
  for (const record of inventory) {
    for (const mount of rawMounts(record.raw)) {
      if (!mount.writable || mount.type === "tmpfs") continue;
      if (mount.type === "bind") {
        if (!safePath(mount.source) || overlaps(mount.source, options.backupRoot))
          refuse("bind", "recipe retire-legacy bind root is unsafe or overlaps the backup directory");
        if (storage.some((s) => s.type === "bind" && overlaps(s.source, mount.source)))
          refuse("bind", "recipe retire-legacy shared/overlapping bind roots are unsupported");
        storage.push({ type: "bind", source: mount.source, target: mount.source, key: `data-${storage.length}` });
      } else {
        const name = "name" in mount ? mount.name : undefined;
        if (name === undefined || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name))
          return refuse("volume", "recipe retire-legacy named volume identity is unproven");
        if (storage.some((s) => s.source === name)) continue;
        storage.push({ type: "volume", source: name, target: name, key: `data-${storage.length}` });
      }
    }
  }
  const helperImage = tryParseLocalImageId(options.helperImage ?? inventory[0]!.evidence.imageId!);
  if (helperImage === undefined)
    return refuse("helperInvalid", "recipe retire-legacy requires an immutable local sha256 image ID for the backup helper");
  await imageConfig(io, helperImage, "helperUnavailable");
  // Effective stop signal per container: the image Config and the container override must
  // both be established signals and must agree; a SIGKILL-configured container refuses here,
  // before anything is stopped.
  const imageConfigs: Record<string, Record<string, unknown>> = {};
  for (const imageId of new Set(inventory.map((c) => c.evidence.imageId!)))
    imageConfigs[imageId] = await imageConfig(io, imageId, "imageUnavailable");
  for (const container of inventory) {
    const config = object(container.raw["Config"]);
    const override = config["StopSignal"] === undefined ? "SIGTERM" : config["StopSignal"];
    const fromImage = imageConfigs[container.evidence.imageId!]!["StopSignal"] === undefined
      ? "SIGTERM" : imageConfigs[container.evidence.imageId!]!["StopSignal"];
    if (verifyRetireSignal({ StopSignal: override }, container.evidence.imageId!) !== override
      || verifyRetireSignal({ StopSignal: fromImage }, container.evidence.imageId!) !== fromImage
      || override !== fromImage)
      refuse("stopSignal", "recipe retire-legacy effective stop signal differs from the image stop signal or is unsupported; only SIGTERM/SIGINT are established");
  }
  for (const item of storage) await verifyTopology(io, item, true);
  // The same capability probe migrate runs: missing helper tools refuse before any stop.
  try { await checkHelper(io, { helperImage, storage }); } catch {
    refuse("capability", "recipe retire-legacy helper tool capability unavailable for the selected local image; no automatic image fallback, build or pull");
  }
  // No other container (any project) may write the storage that is about to be backed up.
  try { await verifyWriters(io, storage, inventory.map((c) => c.evidence.id)); } catch {
    refuse("writers", "recipe retire-legacy storage has another potential writer; refusing before anything is stopped");
  }
  const plan: StackRetireLegacyPlan = Object.freeze({
    token, project: io.project, legacyProject,
    containers: Object.freeze(inventory.map((c) => c.evidence)),
    storage: Object.freeze(inventory.flatMap((c) => (c.evidence.mounts ?? [])
      .filter((m) => m.writable && ["bind", "volume"].includes(m.type))
      .map((m) => Object.freeze({ type: m.type as "bind" | "volume", source: m.source, destination: m.destination, writable: m.writable, ...(m.name === undefined ? {} : { name: m.name }) })))),
    retainedImages: Object.freeze([...new Map(inventory.map((c) => [c.evidence.imageId!, { service: c.evidence.service, imageId: c.evidence.imageId! }])).values()]),
    helperImage, backupRoot: options.backupRoot, shutdownTimeoutSeconds,
    operations: RETIRE_OPERATIONS,
    impacts: Object.freeze(["all legacy containers stop and are removed; they cannot be restarted as-is", "images are retained; recorded inspect JSON is the source for any container reconstruction", "cold writable storage is backed up into the private recovery directory; nothing is deleted", "named volumes and bind paths are never removed"]),
  });
  return {
    plan, storage, containers: inventory.map((c) => c.evidence), raw: inventory.map((c) => c.raw), imageConfigs, helperImage,
    fingerprint: JSON.stringify(stable({
      legacyProject, helperImage, shutdownTimeoutSeconds, storage,
      source: inventory.map(({ raw }) => {
        const state = object(raw["State"]);
        return { id: raw["Id"], image: raw["Image"], config: raw["Config"], hostConfig: raw["HostConfig"], mounts: raw["Mounts"],
          state: { status: state["Status"], exitCode: state["ExitCode"], oomKilled: state["OOMKilled"], paused: state["Paused"], restarting: state["Restarting"] } };
      }).sort((a, b) => String(a.id).localeCompare(String(b.id))),
    })),
  };
}

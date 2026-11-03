import { randomUUID } from "node:crypto";
import type { StackLock, StackRecoverOptions, StackRecoverPlan } from "../../../runtime.ts";
import { sleep } from "../../../runtime.ts";
import { composeDocument, preflightStaging, object, array, json, text, checkDeadline, type StackIO } from "../io.ts";
import { requireOwned, records } from "../inspection.ts";

export function pinnedService(value: unknown, image: string): Record<string, unknown> {
  const service = { ...object(value), image, pull_policy: "never" };
  delete (service as Record<string, unknown>)["build"];
  return service;
}
export async function waitReady(io: StackIO, services: readonly string[], seconds: number, allowLegacy = false): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    // Legacy records are retained transaction evidence, not readiness candidates. Only
    // migration's explicit allowLegacy scope can tolerate them; ordinary ops still refuse.
    const snapshot = await requireOwned(io, allowLegacy, deadline);
    checkDeadline(deadline);
    const ready = services.every((service) => {
      const replicas = snapshot.containers.filter((c) => c.project === io.project && c.service === service);
      return replicas.length > 0 && replicas.every((c) => c.state === "running" && (c.health === undefined || c.health === "none" || c.health === "healthy"));
    });
    if (ready) return;
    if (snapshot.containers.some((c) => c.project === io.project && services.includes(c.service ?? "") && ["exited", "dead"].includes(c.state ?? ""))) throw new Error("recipe service exited before readiness");
    if (Date.now() >= deadline) break;
    await sleep(Math.min(250, Math.max(0, deadline - Date.now())));
  }
  throw new Error("recipe readiness deadline exceeded");
}
export function readinessSeconds(value: number | undefined): number {
  const seconds = value ?? 60;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) throw new Error("recipe readiness must be 1..300 seconds");
  return seconds;
}
// Compare private raw observations, never display-redacted mount evidence. Unsupported
// representations fail closed rather than silently changing startup or storage semantics.
export function assertEffectiveConfig(value: unknown, image: Record<string, unknown>, containers: Record<string, unknown>[],
  document: Record<string, unknown>): Record<string, unknown> {
  const service = object(value);
  const fail = (): never => { throw new Error("recipe effective configuration drift or unsupported representation; no mutation permitted"); };
  const vector = (v: unknown): string[] | null => {
    if (v === undefined || v === null) return null;
    const result = array(v);
    if (result.some((item) => typeof item !== "string")) return fail();
    return result as string[];
  };
  const envMap = (v: unknown): Record<string, string> => {
    const map: Record<string, string> = {};
    for (const item of array(v ?? [])) {
      if (typeof item !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*=/.test(item)) return fail();
      const split = item.indexOf("=");
      const key = item.slice(0, split);
      if (Object.hasOwn(map, key)) return fail();
      map[key] = item.slice(split + 1);
    }
    return map;
  };
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  const environment = { ...envMap(image["Env"]) };
  for (const [key, v] of Object.entries(object(service["environment"] ?? {}))) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof v !== "string") return fail();
    environment[key] = v;
  }
  if (service["env_file"] !== undefined) return fail();
  const entrypoint = service["entrypoint"] == null ? vector(image["Entrypoint"]) : vector(service["entrypoint"]);
  const command = service["command"] == null
    ? service["entrypoint"] == null ? vector(image["Cmd"]) : null : vector(service["command"]);
  const workdir = service["working_dir"] ?? image["WorkingDir"] ?? "";
  const user = service["user"] ?? image["User"] ?? "";
  if (typeof workdir !== "string" || typeof user !== "string") return fail();
  const mounts = array(service["volumes"] ?? []).map((v) => {
    const m = object(v);
    const type = m["type"];
    if (type !== "bind" && type !== "volume") return fail();
    if (typeof m["source"] !== "string" || typeof m["target"] !== "string"
      || (m["read_only"] !== undefined && typeof m["read_only"] !== "boolean")) return fail();
    let source = m["source"];
    if (type === "volume") {
      const definition = object(object(document["volumes"] ?? {})[source]);
      if (typeof definition["name"] !== "string") return fail();
      source = definition["name"];
    } else if (!source.startsWith("/")) return fail();
    return { type, source, destination: m["target"], writable: m["read_only"] !== true };
  }).sort((a, b) => a.destination.localeCompare(b.destination));
  if (Object.keys(object(image["Volumes"] ?? {})).some((destination) => !mounts.some((m) => m.destination === destination))
    || service["tmpfs"] !== undefined || service["volumes_from"] !== undefined) return fail();
  for (const raw of containers) {
    const observed = object(raw["Config"]);
    const actualEnv = envMap(observed["Env"]);
    if (!same(Object.entries(environment).sort(), Object.entries(actualEnv).sort())
      || !same(entrypoint, vector(observed["Entrypoint"])) || !same(command, vector(observed["Cmd"]))
      || observed["WorkingDir"] !== workdir || observed["User"] !== user) return fail();
    const actualMounts = array(raw["Mounts"]).map((v) => {
      const m = object(v);
      if (typeof m["Destination"] !== "string" || typeof m["RW"] !== "boolean") return fail();
      return { type: m["Type"], source: m["Type"] === "volume" ? m["Name"] : m["Source"],
        destination: m["Destination"], writable: m["RW"] };
    }).sort((a, b) => a.destination.localeCompare(b.destination));
    if (!same(mounts, actualMounts)) return fail();
  }
  return { ...service, environment, entrypoint, command, working_dir: workdir, user };
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}
export function recoveryAPI(io: StackIO): {
  planRecover: (options: StackRecoverOptions) => Promise<StackRecoverPlan>;
  recover: (plan: StackRecoverPlan, lock: StackLock) => Promise<void>;
} {
  const plans = new Map<string, { plan: StackRecoverPlan; options: StackRecoverOptions; fingerprint: string }>();
  const prepare = async (options: StackRecoverOptions) => {
    const snapshot = await requireOwned(io);
    const replicas = snapshot.containers.filter((c) => c.service === options.service);
    if (replicas.length === 0) throw new Error("recipe recovery requires an existing selected service");
    const config = await io.config();
    await preflightStaging(io, [config]);
    const services = object(config["services"]);
    if (!Object.hasOwn(services, options.service)) throw new Error("recipe recovery service does not exist");
    readinessSeconds(options.timeoutSeconds);
    const imageIds = [...new Set(replicas.map((c) => c.imageId!))].sort();
    if (imageIds.length !== 1) throw new Error("recipe replicas have ambiguous image identities");
    const local = array(json((await io.run(["image", "inspect", imageIds[0]!])).stdout));
    if (local.length !== 1 || object(local[0])["Id"] !== imageIds[0]) throw new Error("recipe recovery exact image unavailable");
    const observed = (await records(io, io.project)).filter((c) => c.evidence.service === options.service);
    if (observed.length !== replicas.length || observed.some((c) => !replicas.some((r) => r.id === c.evidence.id)))
      throw new Error("recipe recovery inventory changed");
    const effective = assertEffectiveConfig(services[options.service], object(object(local[0])["Config"]), observed.map((c) => c.raw), config);
    return { config, services, effective, imageIds, replicas,
      fingerprint: JSON.stringify(stable({ config, effective,
        selected: observed.map(({ raw }) => ({ id: raw["Id"], image: raw["Image"],
          config: raw["Config"], hostConfig: raw["HostConfig"], mounts: raw["Mounts"] })).sort((a, b) => text(a.id).localeCompare(text(b.id))),
        containers: snapshot.containers.map((c) => ({ id: c.id, image: c.imageId, project: c.project,
          service: c.service, provenance: c.provenance, state: c.state })).sort((a, b) => a.id.localeCompare(b.id)),
      })) };
  };
  return {
    planRecover: async (options) => {
      const prepared = await prepare(options);
      const plan: StackRecoverPlan = Object.freeze({ token: randomUUID(), service: options.service,
        imageIds: Object.freeze(prepared.imageIds), build: options.build === true, pull: options.pull === true,
        containers: Object.freeze(prepared.replicas), impacts: Object.freeze(["recreate selected service only", "no dependencies started", ...(options.build ? ["build selected service"] : []), ...(options.pull ? ["pull selected service"] : [])]) });
      plans.set(plan.token, { plan, options: { ...options }, fingerprint: prepared.fingerprint });
      return plan;
    },
    recover: async (plan, lock) => {
      const saved = plans.get(plan.token);
      if (!saved || saved.plan !== plan) throw new Error("recipe recovery plan is not recognized");
      await lock(async () => {
        const prepared = await prepare(saved.options);
        if (prepared.fingerprint !== saved.fingerprint) throw new Error("recipe recovery plan is stale");
        plans.delete(plan.token);
        const selected = prepared.effective;
        // A one-service document prevents explicit build/pull from touching siblings.
        let document = { ...prepared.config, services: { [plan.service]: selected } };
        // Compose still validates depends_on; selective recovery never starts dependencies.
        const stripped = { ...selected };
        delete stripped["depends_on"];
        document = { ...document, services: { [plan.service]: stripped } };
        if (plan.build) await composeDocument(io, document, ["build", plan.service]);
        if (plan.pull) await composeDocument(io, document, ["pull", "--policy", "always", plan.service]);
        if (!plan.build && !plan.pull) document = { ...document,
          services: { [plan.service]: pinnedService(stripped, prepared.imageIds[0]!) } };
        await composeDocument(io, document, ["up", "--detach", "--force-recreate", "--no-build", "--pull", "never", "--no-deps", plan.service]);
        await waitReady(io, [plan.service], readinessSeconds(saved.options.timeoutSeconds));
      });
    },
  };
}

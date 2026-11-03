import type { StackContainerEvidence, StackInspection } from "../../runtime.ts";
import { array, ids, json, object, RecipeReadError, text, definitionLabel, digestLabel, documentDigest, decodeComposeDocument, operationPrefix, stagingLayout, verifyStaging, remainingTimeout, checkDeadline, type StackIO } from "./io.ts";

export interface ContainerRecord {
  evidence: StackContainerEvidence;
  raw: Record<string, unknown>;
}
export async function records(io: StackIO, namespace: string, deadline?: number): Promise<ContainerRecord[]> {
  const listed = ids((await io.run(["ps", "--all", "--quiet", "--no-trunc", "--filter", `label=com.docker.compose.project=${namespace}`], undefined, remainingTimeout(deadline))).stdout);
  if (listed.length > 128) throw new RecipeReadError("malformed", "container inventory exceeds 128; inspection truncated");
  if (listed.length === 0) return [];
  const inspected = array(json((await io.run(["inspect", ...listed], undefined, remainingTimeout(deadline))).stdout));
  if (inspected.length !== listed.length) throw new RecipeReadError("malformed", "inspect count");
  const expected = await io.file();
  const directory = expected.slice(0, expected.lastIndexOf("/"));
  const settings = { ...io.getSettings() };
  let prefix: string | undefined;
  const seen = new Set<string>();
  checkDeadline(deadline);
  const result: ContainerRecord[] = [];
  for (const value of inspected) {
    checkDeadline(deadline);
    const raw = object(value);
    const id = text(raw["Id"]);
    const matches = listed.filter((item) => id.startsWith(item));
    if (!/^[a-f0-9]{64}$/.test(id) || matches.length !== 1 || seen.has(matches[0]!)) throw new RecipeReadError("malformed", "inspect identity");
    seen.add(matches[0]!);
    const config = object(raw["Config"]);
    const labels = object(config["Labels"] ?? {});
    const service = labels["com.docker.compose.service"] === undefined ? undefined : text(labels["com.docker.compose.service"]);
    if (service !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(service)) throw new RecipeReadError("malformed", "service");
    const complete = service !== undefined && ["com.docker.compose.project", "com.docker.compose.project.working_dir", "com.docker.compose.project.config_files"].every((key) => typeof labels[key] === "string");
    const configFiles = labels["com.docker.compose.project.config_files"];
    let durable = false;
    if (complete && namespace === io.project && labels["com.docker.compose.project"] === namespace
      && labels["com.docker.compose.project.working_dir"] === directory && typeof configFiles === "string"
      && configFiles.startsWith(prefix ??= operationPrefix(settings, namespace, expected))
      && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/resolved\.json$/.test(configFiles.slice(prefix.length))
      && labels[definitionLabel] === expected && typeof labels[digestLabel] === "string" && /^[0-9a-f]{64}$/.test(labels[digestLabel] as string)) {
      let stored: Record<string, unknown>;
      try {
        const root = configFiles.slice(0, configFiles.lastIndexOf("/"));
        const mounts = array(raw["Mounts"]).map((value) => {
          const mount = object(value);
          const type = text(mount["Type"]);
          if (!["bind", "volume", "tmpfs"].includes(type) || typeof mount["RW"] !== "boolean")
            throw new RecipeReadError("malformed", "mount access or type");
          return { type, source: text(mount["Source"]) };
        });
        const layout = stagingLayout(settings, namespace, expected, [{ services: { observed: { volumes: mounts } } }]);
        const proof = await verifyStaging(io, layout, root, configFiles, true, deadline);
        stored = decodeComposeDocument(proof);
        await verifyStaging(io, stagingLayout(settings, namespace, expected, [stored]), root, configFiles, false, deadline, false);
      } catch { checkDeadline(deadline); throw new RecipeReadError("malformed", "durable provenance"); }
      const storedService = object(object(stored["services"])[service!]);
      const storedLabels = object(storedService["labels"]);
      durable = storedLabels[definitionLabel] === expected && storedLabels[digestLabel] === labels[digestLabel]
        && documentDigest(stored) === labels[digestLabel];
    }
    const match = labels["com.docker.compose.project"] === namespace
      && labels["com.docker.compose.project.working_dir"] === directory
      && (configFiles === expected || durable);
    const provenance = !complete ? "unknown" : !match ? "foreign" : namespace === io.project ? "matched" : "legacy";
    const state = object(raw["State"]);
    const status = text(state["Status"]);
    if (!["created", "running", "paused", "restarting", "removing", "exited", "dead"].includes(status)) throw new RecipeReadError("malformed", "state");
    if (!Number.isInteger(state["ExitCode"])) throw new RecipeReadError("malformed", "exit code");
    const health = state["Health"] === undefined ? undefined : text(object(state["Health"])["Status"]);
    if (health !== undefined && !["healthy", "unhealthy", "starting", "none"].includes(health)) throw new RecipeReadError("malformed", "health");
    const imageId = text(raw["Image"]);
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new RecipeReadError("malformed", "image identity");
    // Environment is only consumed to redact diagnostics; never returned or journaled.
    const secrets = config["Env"] === undefined ? [] : array(config["Env"]).map(text).map((entry) => entry.slice(entry.indexOf("=") + 1)).filter(Boolean);
    const sanitize = (input: string): string => {
      let safe = input;
      for (const secret of secrets.sort((a, b) => b.length - a.length)) safe = safe.split(secret).join("[redacted]");
      return io.sanitize(safe);
    };
    const owned = provenance === "matched" || provenance === "legacy";
    const mounts = array(raw["Mounts"]).map((mount) => {
      const m = object(mount);
      if (typeof m["RW"] !== "boolean") throw new RecipeReadError("malformed", "mount access");
      const type = text(m["Type"]);
      if (!["bind", "volume", "tmpfs"].includes(type)) throw new RecipeReadError("malformed", "mount type");
      return { type, source: sanitize(text(m["Source"])), destination: sanitize(text(m["Destination"])), writable: m["RW"],
        ...(typeof m["Name"] === "string" ? { name: sanitize(m["Name"]) } : {}) };
    });
    result.push({ raw, evidence: { id, project: namespace, provenance, service, state: status, health,
      exitCode: state["ExitCode"] as number, imageId, mounts,
      ...(owned ? { startError: sanitize(typeof state["Error"] === "string" ? state["Error"] : "") } : {}) } });
  }
  checkDeadline(deadline);
  return result;
}
export async function inspectStack(io: StackIO, options?: { logs?: boolean; tail?: number }, deadline?: number): Promise<StackInspection> {
  const containers: StackContainerEvidence[] = [];
  const unknown: { project: string; cause: "transport" | "malformed"; detail: string }[] = [];
  const namespaces: { project: string; status: "present" | "absent" | "unknown" }[] = [];
  for (const namespace of [io.project, ...io.legacy]) {
    checkDeadline(deadline);
    try {
      const namespaceRecords = await records(io, namespace, deadline);
      namespaces.push({ project: namespace, status: namespaceRecords.length ? "present" : "absent" });
      for (const record of namespaceRecords) {
        let evidence = record.evidence;
        if (options?.logs && (evidence.provenance === "matched" || evidence.provenance === "legacy")) {
          const requested = options.tail ?? 100;
          if (!Number.isFinite(requested)) throw new RecipeReadError("malformed", "log tail");
          const tail = Math.max(1, Math.min(200, Math.floor(requested)));
          try {
            const logs = await io.run(["logs", "--tail", String(tail), evidence.id], undefined, remainingTimeout(deadline));
            const env = array(object(record.raw["Config"])["Env"] ?? []).map(text);
            let content = logs.stdout + logs.stderr;
            for (const entry of env) {
              const secret = entry.slice(entry.indexOf("=") + 1);
              if (secret) content = content.split(secret).join("[redacted]");
            }
            evidence = { ...evidence, logs: io.sanitize(content) };
          } catch (error) { unknown.push({ project: namespace, cause: "transport", detail: io.sanitize(error instanceof Error ? error.message : "logs unavailable") }); }
        }
        containers.push(evidence);
      }
    } catch (error) {
      namespaces.push({ project: namespace, status: "unknown" });
      unknown.push({ project: namespace, cause: error instanceof RecipeReadError ? error.causeKind : "malformed",
        detail: io.sanitize(error instanceof Error ? error.message : "malformed container response") });
    }
  }
  checkDeadline(deadline);
  return { containers, unknown, namespaces };
}
export async function requireOwned(io: StackIO, allowLegacy = false, deadline?: number): Promise<StackInspection> {
  const result = await inspectStack(io, undefined, deadline);
  if (result.unknown.length || result.containers.some((c) => c.provenance === "foreign" || c.provenance === "unknown")) throw new Error("recipe ownership is unproven; no mutation permitted");
  if (!allowLegacy && result.containers.some((c) => c.provenance === "legacy")) throw new Error("recipe namespace cutover required");
  return result;
}

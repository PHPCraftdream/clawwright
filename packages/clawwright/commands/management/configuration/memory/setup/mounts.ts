import { posix } from "node:path";
import { serviceOf, type Context } from "#src/core/context.ts";
import { composeProjectName } from "#src/runtime/deployment.ts";
import { DockerRuntime } from "#src/runtime/docker/runtime-docker.ts";
import { CLI_HELPER_SERVICE } from "#src/commands/interface/cli-helper.ts";
import { MemoryError, object } from "#src/commands/management/configuration/memory/declaration.ts";
import type { SetupMount, SetupMountInventory } from "./operation.ts";

function refusal(): MemoryError {
  return new MemoryError("MOUNT", "Bounded gateway/helper mount inspection failed or was ambiguous; inspect the selected persistent mounts before setup.");
}
function refuse(): never {
  throw refusal();
}
function canonical(value: unknown): string {
  if (typeof value !== "string" || !posix.isAbsolute(value) || posix.normalize(value) !== value || value.includes("\\") || [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return refuse();
  return value;
}
function mounts(value: unknown): SetupMount[] {
  if (!Array.isArray(value) || value.length > 128) return refuse();
  const destinations = new Set<string>();
  return value.map((entry) => {
    const row = object(entry);
    if (!["bind", "volume", "tmpfs"].includes(String(row.Type)) || typeof row.RW !== "boolean") return refuse();
    const destination = canonical(row.Destination);
    if (destinations.has(destination)) return refuse();
    destinations.add(destination);
    // tmpfs has no host source; it still participates in shadow-mount rejection.
    const source = row.Type === "tmpfs" && (row.Source === undefined || row.Source === "") ? "" : canonical(row.Source);
    return { source, destination, type: String(row.Type), writable: row.RW };
  });
}

/** Docker-only adapter: discovers exactly one running container per owned service.
 * Every query uses the caller's transport and the remaining shared read budget. */
export async function readSetupMounts(ctx: Context, timeoutMs: number): Promise<SetupMountInventory> {
  try {
    if (!(ctx.runtime instanceof DockerRuntime) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 240000) return refuse();
    const end = Date.now() + timeoutMs;
    const project = composeProjectName(), gatewayService = serviceOf(ctx);
    if (!project || !gatewayService || gatewayService === CLI_HELPER_SERVICE) return refuse();
    async function query(args: string[], limit: number): Promise<string> {
      const remaining = end - Date.now();
      if (remaining <= 0) return refuse();
      const result = await ctx.transport.exec("docker", args, { input: "", stream: false, allowFailure: true, timeoutMs: remaining });
      if (Date.now() >= end || result.code !== 0 || result.timedOut || result.stdout.length > limit) return refuse();
      return result.stdout;
    }
    async function discover(service: string): Promise<string> {
      const output = await query([
        "ps", "--quiet", "--no-trunc", "--filter", `label=com.docker.compose.project=${project}`,
        "--filter", `label=com.docker.compose.service=${service}`,
      ], 16384);
      const ids = output.trim().split(/\r?\n/);
      if (ids.length !== 1 || !/^[0-9a-f]{64}$/.test(ids[0])) return refuse();
      return ids[0];
    }
    const gatewayId = await discover(gatewayService), helperId = await discover(CLI_HELPER_SERVICE);
    if (gatewayId === helperId) return refuse();
    const raw: unknown = JSON.parse(await query(["inspect", gatewayId, helperId], 4 * 1024 * 1024));
    if (!Array.isArray(raw) || raw.length !== 2) return refuse();
    const rows = new Map<string, Record<string, unknown>>();
    for (const entry of raw) {
      const row = object(entry);
      if (typeof row.Id !== "string" || ![gatewayId, helperId].includes(row.Id) || rows.has(row.Id)) return refuse();
      const labels = object(object(row.Config).Labels);
      const service = row.Id === gatewayId ? gatewayService : CLI_HELPER_SERVICE;
      if (object(row.State).Running !== true || labels["com.docker.compose.project"] !== project || labels["com.docker.compose.service"] !== service) return refuse();
      rows.set(row.Id, row);
    }
    const gateway = rows.get(gatewayId), helper = rows.get(helperId);
    if (!gateway || !helper) return refuse();
    return { gateway: mounts(gateway.Mounts), helper: mounts(helper.Mounts) };
  } catch {
    // Never expose inspect output, transport diagnostics, paths or credentials.
    throw refusal();
  }
}

import type { Settings } from "../../../core/env.ts";
import type { PathBridge } from "../../../core/paths.ts";
import { UserError } from "../../../core/io/log.ts";
import { command, manual } from "../../../core/io/invocation/advice.ts";
import type { ExecResult, Transport } from "../../transport/transport.ts";
import type { RuntimeLogRecord, Stack, StackServiceState } from "../../runtime.ts";
import { mergeLogStreams, formatLogRecords } from "../compose-operations.ts";
import { createIO, readCompose, json, object, array, ids, RecipeReadError, type StackIO } from "./io.ts";
import { inspectStack, requireOwned } from "./inspection.ts";
import { recoveryAPI } from "./recovery/index.ts";
import { retireAPI } from "./recovery/retire.ts";
import { migrationAPI } from "./migration.ts";

function parsePs(stdout: string): Record<string, unknown>[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { return trimmed.split("\n").filter((line) => line.trim()).map((line) => object(json(line))); }
  return Array.isArray(parsed) ? array(parsed).map(object) : [object(parsed)];
}
async function ownershipGuard(io: StackIO, recipeName?: string): Promise<void> {
  try { await requireOwned(io); } catch {
    // Configured identities only; never echo a raw daemon error or infer a recipe name.
    // JSON escaping preserves exact namespaces without allowing terminal control characters.
    throw new UserError(`recipe ownership or namespace cutover is unproven; no ordinary stack mutation permitted; current namespace: ${JSON.stringify(io.project)}; known legacy namespaces: ${JSON.stringify(io.legacy)}`, {
      advice: recipeName
        ? [command(["recipe", "inspect", recipeName]), command(["recipe", "migrate", recipeName])]
        : [manual("Inspect the current and known legacy namespaces and verify ownership before an explicit operator cutover; the recipe name is unknown.")],
    });
  }
}
/** Caller-compatible side-stack lifecycle plus optional read-only plans and locked executors. */
export function buildStack(transport: Transport, paths: PathBridge, getSettings: () => Settings,
  withEnvFile: <T>(action: (path: string) => Promise<T>, settings?: Settings) => Promise<T>,
  project: string, definitionPath: string,
  ownership?: { verifyOwnership: boolean; legacyProjects?: readonly string[]; recipeName?: string }): Stack {
  const io = createIO(transport, paths, getSettings, project, definitionPath, ownership?.legacyProjects ?? []);
  const verify = async (): Promise<void> => { if (ownership?.verifyOwnership) await ownershipGuard(io, ownership.recipeName); };
  const compose = async (args: string[], stream = true): Promise<ExecResult> => {
    await verify();
    return withEnvFile(async (envFile) => {
      const file = await io.file();
      const result = await transport.exec("docker", ["compose", "--env-file", envFile, "--project-name", project,
        "--file", file, "--project-directory", file.slice(0, file.lastIndexOf("/")), ...args],
      { stream, unsetEnv: Object.keys(getSettings().env) });
      if (result.code !== 0 || result.timedOut) throw new Error("recipe Compose read or mutation failed");
      return result;
    });
  };
  const voidly = async (args: string[]): Promise<void> => { await compose(args); };
  const readLogRecords = async (tail: string, extraArgs: string[] = []): Promise<RuntimeLogRecord[]> => {
    const result = await compose(["logs", "--timestamps", "--tail", tail, ...extraArgs], false);
    return mergeLogStreams(result.stdout, result.stderr, Number(tail));
  };
  return {
    inspect: (options) => inspectStack(io, options),
    ...recoveryAPI(io), ...retireAPI(io), ...migrationAPI(io),
    build: () => voidly(["build"]),
    up: (options) => voidly(["up", "--detach", ...(options?.wait ? ["--wait", "--wait-timeout", String(options.timeoutSeconds ?? 60)] : [])]),
    down: (removeVolumes = false) => voidly(["down", ...(removeVolumes ? ["--volumes"] : [])]),
    status: () => voidly(["ps"]),
    followLogs: (extraArgs: string[] = []) => voidly(["logs", "--follow", "--tail", "100", ...extraArgs]),
    readLogRecords,
    readLogs: async (tail, extraArgs = []) => formatLogRecords(await readLogRecords(tail, extraArgs)),
    isRunning: async () => {
      await verify();
      const listed = ids((await io.run(["ps", "--quiet", "--no-trunc", "--filter", `label=com.docker.compose.project=${project}`])).stdout);
      if (listed.some((id) => id.length !== 64)) throw new RecipeReadError("malformed", "full container IDs");
      return listed.length > 0;
    },
    serviceStates: async () => {
      await verify();
      const result = await readCompose(io, ["ps", "--all", "--format", "json"]);
      const states: Record<string, StackServiceState> = Object.create(null);
      for (const entry of parsePs(result.stdout)) {
        if (typeof entry["Service"] !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(entry["Service"]) || typeof entry["State"] !== "string"
          || !["created", "running", "paused", "restarting", "removing", "exited", "dead"].includes(entry["State"])
          || (entry["Health"] !== undefined && (typeof entry["Health"] !== "string" || !["", "none", "healthy", "unhealthy", "starting"].includes(entry["Health"])))) throw new Error("recipe service states are unknown (malformed)");
        const name = entry["Service"];
        const running = entry["State"] === "running";
        const health = typeof entry["Health"] === "string" && entry["Health"] ? entry["Health"] : undefined;
        const old = Object.hasOwn(states, name) ? states[name] : undefined;
        states[name] = old === undefined ? { running, health } : { running: old.running && running,
          health: old.health === undefined || old.health === "healthy" ? health ?? old.health : old.health };
      }
      return states;
    },
  };
}

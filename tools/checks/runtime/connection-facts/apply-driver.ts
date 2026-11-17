// The harness the apply checks drive the REAL apply()/runSteps with: a real createContext(),
// with the transport and docker answers stubbed — the seam a hand-built Context cannot reach.
// Shared by convergence/apply/apply-refresh.check.ts and connection-facts/operator-edit.check.ts.
// The apply-config driver stages a JSON Merge Patch on the target and resolves its mounted
// target path to the container-visible path before invoking config patch.

import { json, matchingJob, CONFIG_FILE, MIRROR, DATA } from "../convergence/inspect/fixture.ts";
import { mcpServerSpec } from "#framework/commands/management/provision-agent/index.ts";
import { formatBatchStub } from "#framework/service/openclaw-cli.ts";
import { fromContainerPath } from "#framework/core/paths.ts";
import { mountPoints } from "#framework/runtime/mounts.ts";
import type { ExecOptions, ExecResult, Transport } from "#framework/runtime/transport/transport.ts";
import { asDirectTest } from "#checks/kit/deployment-fixture.ts";

/** The live config as the fixture's stub presents it, so the plan is quiet except for the
 *  finding each scenario is about. */
export function refreshLiveConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gateway: { mode: "local", auth: { token: { source: "env", id: "OPENCLAW_GATEWAY_TOKEN" } } },
    agents: { defaults: { model: { primary: "zai/glm-5.3-flash" } } },
    models: { providers: { zai: {} } },
    ...overrides,
  };
}

export interface RefreshSpec {
  liveConfig: Record<string, unknown>;
  mirrorChecksums: Record<string, string>;
  prompts: Record<string, string>;
  agents?: string[];
  mcpServers?: string[];
  mcpServerEntries?: Record<string, { command?: unknown; args?: unknown; enabled?: unknown }>;
  cronJobs?: Record<string, unknown>[];
}

export interface RefreshState {
  files: Map<string, string>;
  composeEnvWrites: string[];
  dockerCalls: string[][];
  running: boolean;
  facts?: Record<string, unknown>;
}

/** A transport whose "target" is an in-memory file map, answering for one DockerRuntime: the
 *  compose argv, the container inspects (state.facts overrides the default answer), the one-off
 *  CLI lists and the checksums the inspection asks for. sudo is unwrapped so loadSecrets'
 *  staged mv lands in the map like the real rename would. */
export function refreshCheckTransport(spec: RefreshSpec, state: RefreshState, driver?: { onStagedConfig?: (payload: string) => void }): Transport {
  const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
  const containerFacts = (): Record<string, unknown> => state.facts ?? {
    Image: "sha256:fixture-image",
    State: { Running: state.running },
    Mounts: [{ Destination: "/home/node/.openclaw", Source: "/srv/clawwright/data/config" }],
    NetworkSettings: { Ports: { "18789/tcp": [{ HostPort: "18789" }] } },
    Config: { Labels: { "com.docker.compose.project": "refresh-check", Image: "ghcr.io/openclaw/openclaw:extended-stable" } },
  };
  const mergePatch = (target: unknown, patch: unknown): unknown => {
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
    const result: Record<string, unknown> = target !== null && typeof target === "object" && !Array.isArray(target)
      ? { ...(target as Record<string, unknown>) } : {};
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
      if (value === null) delete result[key];
      else result[key] = mergePatch(result[key], value);
    }
    return result;
  };
  const docker = (args: string[]): ExecResult => {
    state.dockerCalls.push([...args]);
    const format = args[args.indexOf("--format") + 1] ?? "";
    // Two image-inspect formats: the digest line imageReference() reads — the value the
    // fixture's lock pins — and the whole-object inspect runningImageIdentity() parses.
    // Answering both with one payload would corrupt one of them.
    if (args[0] === "image") {
      return ok(format.includes("json")
        ? JSON.stringify({ RepoDigests: ["ghcr.io/openclaw/openclaw@sha256:abc"], Config: { Labels: {} } })
        : "ghcr.io/openclaw/openclaw@sha256:abc");
    }
    if (format.includes("State.Health")) return ok("healthy");
    // Recent, so no RESTART_REQUIRED against the fixture's epoch-1000s config mtime.
    if (format.includes("StartedAt")) return ok("2026-09-22T00:00:00.000000000Z");
    if (format.includes("json")) return ok(JSON.stringify(containerFacts()));
    if (args.includes("ps")) return ok(state.running ? "container-one" : "");
    if (args.includes("run")) {
      const rest = args.slice(args.indexOf("run") + 1);
      const entryAt = rest.indexOf("dist/index.js");
      const shellAt = rest.indexOf("-c");
      const tail = entryAt >= 0 ? rest.slice(entryAt + 1) : shellAt >= 0 ? rest.slice(shellAt) : rest;
      if (tail[0] === "config" && tail[1] === "patch" && tail[2] === "--file") {
        const containerPath = tail[3];
        if (!containerPath) throw new Error("config patch omitted its staged file path");
        let targetPath: string;
        try { targetPath = fromContainerPath(containerPath, mountPoints(DATA)); }
        catch (error) { throw new Error(`staged config path is not covered by a container mount: ${containerPath}`, { cause: error }); }
        const staged = state.files.get(targetPath);
        if (staged === undefined) throw new Error(`staged config file is missing on target: ${targetPath}`);
        if (!tail.includes("--dry-run")) {
          const updated = mergePatch(spec.liveConfig, JSON.parse(staged)) as Record<string, unknown>;
          for (const key of Object.keys(spec.liveConfig)) delete spec.liveConfig[key];
          Object.assign(spec.liveConfig, updated);
        }
        return ok();
      }
      const agentsResult = json((spec.agents ?? ["main", "onboarding"]).map((id) => ({ id })));
      const mcpResult = json(Object.fromEntries((spec.mcpServers ?? ["demo-mcp"]).map((name) => [name, spec.mcpServerEntries ?? mcpServerSpec("demo")])));
      const cronResult = json({ jobs: spec.cronJobs ?? [matchingJob()] });
      const versionResult = ok("OpenClaw 2026.6.34\n");
      // observeLive's own batched read (openclawCliBatch): `--entrypoint sh cli -c <script>`
      // is the shape only that call ever passes.
      if (tail[0] === "-c") return ok(formatBatchStub([
        agentsResult, mcpResult, cronResult, versionResult, json({ plugins: [] }), json({ skills: [] }),
        json({ channelAccounts: {} }), json([]),
      ]));
      // provision-agent's own reconcile.ts still reads these one at a time, unbatched.
      if (tail[0] === "agents" && tail[1] === "list") return agentsResult;
      if (tail[0] === "mcp" && tail[1] === "list") return mcpResult;
      if (tail[0] === "cron" && tail[1] === "list") return cronResult;
      if (tail.includes("--version")) return versionResult;
      return ok("{}");
    }
    if (args.includes("up")) {
      state.running = true;
      return ok("container-one");
    }
    return ok();
  };
  const dispatch = async (rawCommand: string, rawArgs: string[], options?: ExecOptions): Promise<ExecResult> => {
    const { command, args } = asDirectTest(rawCommand, rawArgs);
    if (command === "sudo" && args[0] === "-n") return dispatch(args[1]!, args.slice(2), options);
    if (command === "docker") return docker(args);
    if (command === "mkdir" || command === "chown" || command === "rmdir") return ok();
    if (command === "test" && args[0] === "-r") return ok();
    if (command === "test" && args[0] === "-w") return ok();
    if (command === "test") return { code: 1, stdout: "", stderr: "" };
    if (command === "stat") return ok(`${new Date(1_000_000).toISOString().replace("T", " ").replace("Z", " +0000")}\n`);
    if (command === "sh" && args[1]?.includes("temporary=")) {
      const match = args[1]!.match(/temporary='([^']+)'/);
      if (!match) throw new Error(`fixture cannot parse private write destination: ${args[1]}`);
      const temporary = match[1]!.replace(/\.clawwright-private-[0-9a-f]+$/, "");
      const input = options?.input;
      state.files.set(temporary, typeof input === "string" ? input : input === undefined ? "" : Buffer.from(input).toString("utf8"));
      return ok();
    }
    if (command === "cat") return ok(state.files.get(args.at(-1) ?? "") ?? "");
    if (command === "sh" && args[1]?.includes("sha256sum")) {
      // The tree arrives as the positional parameter (args[3]); the program text is a constant.
      const wanted = args[3] === MIRROR ? spec.mirrorChecksums : spec.prompts;
      return ok(`${Object.entries(wanted).map(([rel, sum]) => `${sum}  ./${rel}`).join("\n")}\n`);
    }
    if (command === "mv") {
      const source = args.at(-2)!;
      const destination = args.at(-1)!;
      const content = state.files.get(source) ?? "";
      state.files.set(destination, content);
      state.files.delete(source);
      return ok();
    }
    if (command === "rm") return ok();
    if (command === "curl") return ok("200");
    return ok();
  };
  return {
    description: "refresh-check",
    async exec(command, args, options = {}) { return dispatch(command, args, options); },
    async readFile(path) {
      if (path === CONFIG_FILE) return JSON.stringify(spec.liveConfig);
      if (path === `${DATA}/clawwright-declared.json` && !state.files.has(path)) {
        const error = new Error(`ENOENT: no such file: ${path}`) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      if (path === `${DATA}/config/.env`) return state.files.get(path) ?? "";
      if (state.files.has(path)) return state.files.get(path)!;
      throw new Error(`unexpected read: ${path}`);
    },
    async writeFile(path, content) {
      const text = typeof content === "string" ? content : "";
      if (path.endsWith("/compose.env")) state.composeEnvWrites.push(text);
      if (path.endsWith("/clawwright-declared-config-patch.json")) driver?.onStagedConfig?.(text);
      state.files.set(path, text);
    },
    async exists(path) {
      if (path === CONFIG_FILE) return true;
      if (path === `${DATA}/clawwright-declared.json` && !state.files.has(path)) return false;
      return state.files.has(path);
    },
    async mkdirp() {},
    async remove(path) { state.files.delete(path); },
    async removeEmptyDir() {},
    async listFiles(dir) { return dir === MIRROR ? Object.keys(spec.mirrorChecksums) : Object.keys(spec.prompts); },
    clientInvocation(entryPath, args) { return { command: entryPath, args }; },
  };
}

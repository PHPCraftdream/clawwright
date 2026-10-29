// `./clawwright provision-agent <recipe>` — covers three layers without a live gateway:
//   - the pure path/argv builders (exact strings, no I/O);
//   - collectRecipeFiles (walks a real temp directory, excludes agent/);
//   - the orchestration logic (ensureAgent/ensureMcpServer/ensureCronJob create-vs-skip
//     decisions, argv, and the scope-upgrade self-heal retry) against a stubbed Context —
//     same idiom as tools/checks/cli-helper.check.ts.

import { randomBytes } from "node:crypto";
import { mkdtemp, readFile as readBytes, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import {
  agentWorkspaceTargetDir,
  recipeMirrorTargetDir,
  agentsAddArgv,
  mcpAddArgv,
  cronAddArgv,
  collectRecipeFiles,
  syncRecipeFiles,
  writeWorkspacePromptFiles,
  ensureAgent,
  ensureMcpServer,
  mcpServerSpec,
  mcpServerMatches,
  mcpUnsetArgv,
  ensureCronJob,
  cronJobMatches,
  cronRmArgv,
} from "#framework/commands/management/provision-agent/index.ts";
import type { Context } from "#framework/core/context.ts";
import { LocalTransport, WslTransport, spawnLocal, type Transport } from "#framework/runtime/transport/transport.ts";
import { parseWslDistroListing } from "#framework/commands/interface/host/contexts.ts";
import { checksumOf } from "#framework/service/checksums.ts";
import { check, checkTrue, finish, requires } from "#checks/kit/harness.ts";

async function rejectionOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const CONFIG = {
  agentId: "demo-agent",
  mcpServerName: "demo-recipe",
  cronJobName: "demo-refresh",
  cronSchedule: "17 3 * * *",
  cronTimeoutSeconds: 900,
};

/** A live cron job exactly as the declaration above would have created it. */
function liveJob() {
  return {
    id: "job-1",
    name: "demo-refresh",
    agentId: "demo-agent",
    schedule: { expr: "17 3 * * *" },
    sessionTarget: "isolated",
    payload: { message: "scheduled message", timeoutSeconds: 900 },
    delivery: { mode: "none" },
  };
}

// --- path builders ------------------------------------------------------------------------

check("agent workspace path lives under the data dir's workspace mount", agentWorkspaceTargetDir("/srv/clawwright", "demo-agent"), "/srv/clawwright/workspace/demo-agent");
check("recipe mirror path lives under the data dir's workspace mount", recipeMirrorTargetDir("/srv/clawwright", "demo-recipe"), "/srv/clawwright/workspace/mcp-demo-recipe");

// --- argv builders -------------------------------------------------------------------------

{
  const argv = agentsAddArgv(CONFIG);
  check("agents add targets the configured agent id", argv.slice(0, 3), ["agents", "add", "demo-agent"]);
  checkTrue("agents add points --workspace at the container-side mirror path", argv.includes("--workspace") && argv.includes("/home/node/.openclaw/workspace/demo-agent"));
  checkTrue("agents add is non-interactive", argv.includes("--non-interactive"));
}

{
  const argv = mcpAddArgv(CONFIG, "demo-recipe");
  check("mcp add targets the configured server name", argv.slice(0, 3), ["mcp", "add", "demo-recipe"]);
  checkTrue("mcp add spawns node against the recipe's container-side server.ts path", argv.includes("--command") && argv.includes("node") && argv.includes("/home/node/.openclaw/workspace/mcp-demo-recipe/server.ts"));
  checkTrue("mcp add uses --experimental-strip-types", argv.includes("--experimental-strip-types"));
  checkTrue("mcp add skips the connect-and-probe step", argv.includes("--no-probe"));
}

{
  const argv = cronAddArgv(CONFIG, "scheduled message");
  checkTrue("cron add names the configured job", argv.includes("--name") && argv.includes("demo-refresh"));
  checkTrue("cron add targets the configured agent", argv.includes("--agent") && argv.includes("demo-agent"));
  checkTrue("cron add runs in an isolated session, not the main one", argv.includes("--session") && argv.includes("isolated"));
  checkTrue("cron add carries the given message verbatim", argv.includes("--message") && argv.includes("scheduled message"));
  checkTrue("cron add carries the configured timeout", argv.includes("--timeout-seconds") && argv.includes("900"));
  // Without this the job defaults to announce -> "last" channel and fail-closes on every
  // run of a deployment that has no messaging channel configured.
  checkTrue("cron add disables chat delivery", argv.includes("--no-deliver"));
}

// --- collectRecipeFiles --------------------------------------------------------------------

{
  const dir = await mkdtemp(join(tmpdir(), "clawwright-provision-agent-check-"));
  try {
    await writeFile(resolve(dir, "server.ts"), "// server");
    await mkdir(resolve(dir, "data", "sub"), { recursive: true });
    await writeFile(resolve(dir, "data", "page.md"), "# page");
    await writeFile(resolve(dir, "data", "sub", "nested.md"), "# nested");
    await mkdir(resolve(dir, "agent"), { recursive: true });
    await writeFile(resolve(dir, "agent", "config.json"), "{}");
    await writeFile(resolve(dir, "agent", "AGENTS.md"), "# prompt");

    const found = (await collectRecipeFiles(dir, "agent")).sort();
    check("collects runtime files at any depth, any extension, excludes agent/ entirely", found, ["data/page.md", "data/sub/nested.md", "server.ts"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Mirroring is byte preserving: recipe assets may be PNG, WASM or another format that is
// not valid UTF-8. Root-level names also must not turn into directories (server.ts and
// server.tsx are both ordinary files).
{
  const root = await mkdtemp(join(tmpdir(), "clawwright-recipe-binary-check-"));
  const targetData = resolve(root, "target-data");
  const recipeDir = resolve(root, "recipe");
  try {
    await mkdir(resolve(recipeDir, "assets"), { recursive: true });
    const binary = Buffer.from([0xff, 0x00, 0x80, 0xc3, 0x28, 0x0a]);
    await writeFile(resolve(recipeDir, "server.ts"), "export default 1;\n");
    await writeFile(resolve(recipeDir, "server.tsx"), "export default 2;\n");
    await writeFile(resolve(recipeDir, "assets", "logo.bin"), binary);

    const ctx = {
      settings: { dataDir: targetData },
      transport: new LocalTransport(),
    } as unknown as Context;
    await syncRecipeFiles(ctx, "binary-recipe", recipeDir);

    const mirror = `${targetData}/workspace/mcp-binary-recipe`;
    check("binary recipe mirror uses the independent expected path", recipeMirrorTargetDir(targetData, "binary-recipe"), mirror);
    const copied = await readBytes(resolve(mirror, "assets", "logo.bin"));
    check("recipe mirror preserves non-UTF-8 bytes and NULs", [...copied], [...binary]);
    check("recipe mirror preserves the source checksum", checksumOf(copied), checksumOf(binary));
    check("root-level colliding filenames remain files", (await ctx.transport.listFiles(mirror)).sort(), ["assets/logo.bin", "server.ts", "server.tsx"]);
    check("root-level filenames do not create a truncated directory", await ctx.transport.exists(resolve(mirror, "server.t")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// A mirror must converge when a recipe changes a path's shape. Stale files are removed
// before their desired child paths are created; stale directories are emptied and removed
// with a non-recursive rmdir so unknown target contents are never swept away.
{
  const root = await mkdtemp(join(tmpdir(), "clawwright-recipe-shape-check-"));
  const targetData = resolve(root, "target-data");
  const recipeDir = resolve(root, "recipe");
  const binary = Buffer.from([0xff, 0x00, 0x80, 0xc3]);
  try {
    await mkdir(recipeDir, { recursive: true });
    await writeFile(resolve(recipeDir, "assets"), binary);
    const ctx = { settings: { dataDir: targetData }, transport: new LocalTransport() } as unknown as Context;
    const mirror = `${targetData}/workspace/mcp-shape-recipe`;
    check("shape recipe mirror uses the independent expected path", recipeMirrorTargetDir(targetData, "shape-recipe"), mirror);

    await syncRecipeFiles(ctx, "shape-recipe", recipeDir);
    await rm(resolve(recipeDir, "assets"));
    await mkdir(resolve(recipeDir, "assets", "nested"), { recursive: true });
    await writeFile(resolve(recipeDir, "assets", "nested", "new.bin"), binary);
    await syncRecipeFiles(ctx, "shape-recipe", recipeDir);
    check("file-to-directory transition removes the blocking file", (await ctx.transport.listFiles(mirror)).sort(), ["assets/nested/new.bin"]);
    check("file-to-directory transition preserves bytes", [...await readBytes(resolve(mirror, "assets", "nested", "new.bin"))], [...binary]);

    await rm(resolve(recipeDir, "assets"), { recursive: true, force: true });
    await writeFile(resolve(recipeDir, "assets"), binary);
    await syncRecipeFiles(ctx, "shape-recipe", recipeDir);
    check("directory-to-file transition removes the old directory", (await ctx.transport.listFiles(mirror)).sort(), ["assets"]);
    check("directory-to-file transition preserves bytes", [...await readBytes(resolve(mirror, "assets"))], [...binary]);

    const repeated = await syncRecipeFiles(ctx, "shape-recipe", recipeDir);
    check("shape convergence is idempotent", repeated, { written: 1, removed: [] });

    await rm(resolve(mirror, "assets"));
    await mkdir(resolve(mirror, "assets"), { recursive: true });
    const emptyDirResult = await syncRecipeFiles(ctx, "shape-recipe", recipeDir);
    check("an empty directory also changes to a desired file", emptyDirResult.removed, []);
    check("empty directory transition writes the desired file", [...await readBytes(resolve(mirror, "assets"))], [...binary]);

    await rm(resolve(mirror, "assets"));
    await mkdir(resolve(mirror, "assets", "empty", "nested"), { recursive: true });
    await writeFile(resolve(mirror, "assets", "old.txt"), "stale");
    const emptyBranchResult = await syncRecipeFiles(ctx, "shape-recipe", recipeDir);
    check("shape replacement removes empty directory branches", emptyBranchResult.removed, ["assets/old.txt"]);
    check("shape replacement survives empty branches", [...await readBytes(resolve(mirror, "assets"))], [...binary]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// A transport can return an incomplete listing. Empty-tree cleanup must then preserve an
// unlisted file and refuse the shape change instead of recursively deleting it.
{
  const root = await mkdtemp(join(tmpdir(), "clawwright-recipe-incomplete-listing-check-"));
  const targetData = resolve(root, "target-data");
  const recipeDir = resolve(root, "recipe");
  try {
    await mkdir(recipeDir, { recursive: true });
    await writeFile(resolve(recipeDir, "assets"), "desired");
    const local = new LocalTransport();
    const incomplete = { ...local, async listFiles(): Promise<string[]> { return []; } } as unknown as typeof local;
    const ctx = { settings: { dataDir: targetData }, transport: incomplete } as unknown as Context;
    const mirror = `${targetData}/workspace/mcp-incomplete-recipe`;
    check("incomplete recipe mirror uses the independent expected path", recipeMirrorTargetDir(targetData, "incomplete-recipe"), mirror);
    await mkdir(resolve(mirror, "assets"), { recursive: true });
    await writeFile(resolve(mirror, "assets", "unknown.txt"), "keep me");
    let failedShapeChange = false;
    try {
      await syncRecipeFiles(ctx, "incomplete-recipe", recipeDir);
    } catch {
      failedShapeChange = true;
    }
    check("incomplete listing refuses an unsafe directory-to-file transition", failedShapeChange, true);
    check("incomplete listing preserves the unknown file", await readBytes(resolve(mirror, "assets", "unknown.txt")), Buffer.from("keep me"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// A failed listing must abort before provisioning can interpret unknown target state as empty.
{
  const root = await mkdtemp(join(tmpdir(), "clawwright-recipe-listing-error-check-"));
  const targetData = resolve(root, "target-data");
  const recipeDir = resolve(root, "recipe");
  try {
    await mkdir(resolve(recipeDir, "agent"), { recursive: true });
    await writeFile(resolve(recipeDir, "agent", "server.ts"), "new server");
    const local = new LocalTransport();
    const transport = {
      ...local,
      async listFiles(): Promise<string[]> { throw new Error("Permission denied"); },
    } as unknown as typeof local;
    const ctx = { settings: { dataDir: targetData }, transport } as unknown as Context;
    const mirror = recipeMirrorTargetDir(targetData, "listing-error-recipe");
    await mkdir(mirror, { recursive: true });
    await writeFile(resolve(mirror, "withdrawn.ts"), "keep until listing works");
    let failedProvisioning = false;
    try {
      await syncRecipeFiles(ctx, "listing-error-recipe", recipeDir);
    } catch {
      failedProvisioning = true;
    }
    check("listing failure aborts recipe provisioning", failedProvisioning, true);
    check("listing failure preserves target files", await readBytes(resolve(mirror, "withdrawn.ts")), Buffer.from("keep until listing works"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// --- the recipe mirror is a mirror: what the recipe dropped is dropped on the target ------
//
// Copying without deleting leaves a withdrawn page on the target, where the recipe's MCP
// server goes on serving it — the agent then answers from instructions that no longer exist
// and nothing anywhere reports a problem. The recipe is a real directory; the target is a
// stub, since the point is which paths get written and removed, not the transport.

{
  const dir = await mkdtemp(join(tmpdir(), "clawwright-recipe-mirror-check-"));
  try {
    await writeFile(resolve(dir, "server.ts"), "// server");
    await mkdir(resolve(dir, "data"), { recursive: true });
    await writeFile(resolve(dir, "data", "page.md"), "# page");
    await mkdir(resolve(dir, "agent"), { recursive: true });
    await writeFile(resolve(dir, "agent", "AGENTS.md"), "# prompt");

    const mirrorDir = "/srv/clawwright/workspace/mcp-demo-recipe";
    const written: string[] = [];
    const removed: string[] = [];
    const ctx = {
      settings: { dataDir: "/srv/clawwright" },
      transport: {
        description: "local",
        // What a previous run left: one file the recipe still declares, and two it no
        // longer does — one of them nested, since a stale path is not always at the top.
        async listFiles(target: string): Promise<string[]> {
          return target === mirrorDir ? ["data/page.md", "data/withdrawn.md", "obsolete.ts"] : [];
        },
        async mkdirp(): Promise<void> {},
        async writeFile(path: string): Promise<void> {
          written.push(path);
        },
        async remove(path: string): Promise<void> {
          removed.push(path);
        },
      },
    } as unknown as Context;

    const result = await syncRecipeFiles(ctx, "demo-recipe", dir);

    check("every declared file is written, agent/ excluded", written.sort(), [
      `${mirrorDir}/data/page.md`,
      `${mirrorDir}/server.ts`,
    ]);
    check("what the recipe no longer declares is removed from the target", removed, [
      `${mirrorDir}/data/withdrawn.md`,
      `${mirrorDir}/obsolete.ts`,
    ]);
    check("a file the recipe still declares is left alone", removed.some((path) => path.endsWith("data/page.md")), false);
    check("the command is told what changed", result, { written: 2, removed: ["data/withdrawn.md", "obsolete.ts"] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

{
  // First run: nothing on the target yet. The listing is empty and nothing is removed —
  // an empty mirror must not read as "everything is stale".
  const dir = await mkdtemp(join(tmpdir(), "clawwright-recipe-mirror-first-check-"));
  try {
    await writeFile(resolve(dir, "server.ts"), "// server");
    const removed: string[] = [];
    const ctx = {
      settings: { dataDir: "/srv/clawwright" },
      transport: {
        description: "local",
        async listFiles(): Promise<string[]> {
          return [];
        },
        async mkdirp(): Promise<void> {},
        async writeFile(): Promise<void> {},
        async remove(path: string): Promise<void> {
          removed.push(path);
        },
      },
    } as unknown as Context;

    const result = await syncRecipeFiles(ctx, "demo-recipe", dir);
    check("a first run removes nothing", removed, []);
    check("and reports only what it wrote", result, { written: 1, removed: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Prompt cleanup must use ledger proof, never the filename extension. MEMORY.md and a
// user-created note can both live at workspace top level; only a prompt this recipe recorded
// previously may be withdrawn when it disappears from the declaration.
{
  const removed: string[] = [];
  const written: string[] = [];
  const ctx = {
    settings: { dataDir: "/srv/clawwright" },
    transport: {
      description: "local",
      async listFiles(): Promise<string[]> {
        return ["MEMORY.md", "custom.md", "AGENTS.md", "memory/old.md"];
      },
      async remove(path: string): Promise<void> { removed.push(path); },
      async mkdirp(): Promise<void> {},
      async writeFile(path: string): Promise<void> { written.push(path); },
    },
  } as unknown as Context;
  await writeWorkspacePromptFiles(ctx, CONFIG, { "AGENTS.md": "new prompt" }, ["AGENTS.md", "custom.md"]);
  check("prompt cleanup removes a formerly-owned prompt", removed, ["/srv/clawwright/workspace/demo-agent/custom.md"]);
  check("prompt cleanup preserves MEMORY.md", removed.some((path) => path.endsWith("MEMORY.md")), false);
  check("prompt cleanup preserves an untracked custom note", (await (async () => {
    removed.length = 0;
    await writeWorkspacePromptFiles(ctx, CONFIG, { "AGENTS.md": "new prompt" }, ["AGENTS.md"]);
    return removed.some((path) => path.endsWith("custom.md"));
  })()), false);
  check("prompt cleanup still writes declared prompts", written, ["/srv/clawwright/workspace/demo-agent/AGENTS.md", "/srv/clawwright/workspace/demo-agent/AGENTS.md"]);
}

// --- orchestration: ensureAgent / ensureMcpServer / ensureCronJob, via a stubbed Context ---

function jsonResult(value: unknown) {
  return { code: 0, stdout: JSON.stringify(value), stderr: "" };
}

function stubContext(listAnswer: unknown) {
  const calls: string[][] = [];
  const ctx = {
    runtime: {
      async runOneOff(_service: string, args: string[]) {
        calls.push(args);
        return jsonResult(listAnswer);
      },
    },
  } as unknown as Context;
  return { ctx, calls };
}

{
  const { ctx, calls } = stubContext([]);
  const created = await ensureAgent(ctx, CONFIG);
  checkTrue("ensureAgent reports creation when the agent is absent", created);
  check("ensureAgent lists then adds — exactly two calls", calls.length, 2);
  check("ensureAgent's add call matches agentsAddArgv()", calls[1], agentsAddArgv(CONFIG));
}
{
  const { ctx, calls } = stubContext([{ id: "demo-agent" }]);
  const created = await ensureAgent(ctx, CONFIG);
  checkTrue("ensureAgent reports no creation when the agent already exists", !created);
  check("ensureAgent only lists, no add call, when already present", calls.length, 1);
}

{
  const { ctx, calls } = stubContext({});
  const state = await ensureMcpServer(ctx, CONFIG, "demo-recipe");
  check("ensureMcpServer reports creation when the server is absent", state, "created");
  check("ensureMcpServer's add call matches mcpAddArgv()", calls[1], mcpAddArgv(CONFIG, "demo-recipe"));
}
{
  const matching = mcpServerSpec("demo-recipe");
  const { ctx, calls } = stubContext({ "demo-recipe": matching });
  const state = await ensureMcpServer(ctx, CONFIG, "demo-recipe");
  check("ensureMcpServer reports the server unchanged when its command already matches", state, "unchanged");
  check("ensureMcpServer only lists, no write call, when already matching", calls.length, 1);
}

// --- mcp reconciliation: a registration whose command drifted is replaced -----------------
//
// Before the fix, presence of the name alone was "already present, no action" — a server
// registered with any command at all, including a broken one, was reported as fine. Mirrors
// ensureCronJob's own drift-and-replace test just above it in spirit.

{
  check("mcpServerMatches accepts an entry equal to the spec", mcpServerMatches(mcpServerSpec("demo-recipe"), "demo-recipe"), true);
  check("a changed command counts as drift", mcpServerMatches({ ...mcpServerSpec("demo-recipe"), command: "missing-program" }, "demo-recipe"), false);
  check("changed args count as drift", mcpServerMatches({ ...mcpServerSpec("demo-recipe"), args: ["--wrong"] }, "demo-recipe"), false);
  check("an absent entry is not a match", mcpServerMatches(undefined, "demo-recipe"), false);
  // A disabled entry excludes itself from tool discovery entirely (OpenClaw's own registry
  // docs) — correct command/args is not enough for it to count as "working".
  check("a disabled entry does not match even with the right command/args", mcpServerMatches({ ...mcpServerSpec("demo-recipe"), enabled: false }, "demo-recipe"), false);
  check("enabled explicitly true still matches", mcpServerMatches({ ...mcpServerSpec("demo-recipe"), enabled: true }, "demo-recipe"), true);
  check("an absent enabled field defaults to matching (conservative default)", mcpServerMatches(mcpServerSpec("demo-recipe"), "demo-recipe"), true);
}

{
  const { ctx, calls } = stubContext({ "demo-recipe": { ...mcpServerSpec("demo-recipe"), enabled: false } });
  const state = await ensureMcpServer(ctx, CONFIG, "demo-recipe");
  check("ensureMcpServer reconciles a disabled-but-otherwise-correct registration", state, "replaced");
  check("it lists, unsets, then re-adds", calls.length, 3);
}

{
  const { ctx, calls } = stubContext({ "demo-recipe": { command: "missing-program", args: [] } });
  const state = await ensureMcpServer(ctx, CONFIG, "demo-recipe");
  check("ensureMcpServer reports replacement when the command has drifted", state, "replaced");
  check("it lists, unsets, then re-adds — exactly three calls", calls.length, 3);
  check("the unset call matches mcpUnsetArgv()", calls[1], mcpUnsetArgv(CONFIG.mcpServerName));
  check("the re-add call matches mcpAddArgv()", calls[2], mcpAddArgv(CONFIG, "demo-recipe"));
}

{
  const { ctx, calls } = stubContext({ jobs: [] });
  const state = await ensureCronJob(ctx, CONFIG, "scheduled message");
  check("ensureCronJob reports creation when the job is absent", state, "created");
  check("ensureCronJob's add call matches cronAddArgv()", calls[1], cronAddArgv(CONFIG, "scheduled message"));
}
{
  const { ctx, calls } = stubContext({ jobs: [liveJob()] });
  const state = await ensureCronJob(ctx, CONFIG, "scheduled message");
  check("ensureCronJob reports the job unchanged when it already matches", state, "unchanged");
  check("ensureCronJob only lists, no write call, when already matching", calls.length, 1);
}

// --- cron reconciliation: a job that drifted from the recipe is replaced ------------------

{
  check("cronJobMatches accepts a job equal to the declaration", cronJobMatches(liveJob(), CONFIG, "scheduled message"), true);
  check("a changed schedule counts as drift", cronJobMatches({ ...liveJob(), schedule: { expr: "0 4 * * *" } }, CONFIG, "scheduled message"), false);
  check("a changed message counts as drift", cronJobMatches(liveJob(), CONFIG, "a different message"), false);
  check("a changed timeout counts as drift", cronJobMatches({ ...liveJob(), payload: { message: "scheduled message", timeoutSeconds: 60 } }, CONFIG, "scheduled message"), false);
  check("a changed agent counts as drift", cronJobMatches({ ...liveJob(), agentId: "someone-else" }, CONFIG, "scheduled message"), false);
  check("a job left on chat delivery counts as drift", cronJobMatches({ ...liveJob(), delivery: { mode: "announce" } }, CONFIG, "scheduled message"), false);
  check("a job left on the main session counts as drift", cronJobMatches({ ...liveJob(), sessionTarget: "main" }, CONFIG, "scheduled message"), false);
  // --all makes a disabled job visible to ensureCronJob at all — it must not
  // also count as "still matching" just because every other declared field agrees, or a
  // disabled job would sit disabled forever with nothing ever noticing.
  check("a disabled job does not match even with every other field agreeing", cronJobMatches({ ...liveJob(), enabled: false }, CONFIG, "scheduled message"), false);
  check("enabled explicitly true still matches", cronJobMatches({ ...liveJob(), enabled: true }, CONFIG, "scheduled message"), true);
  check("an absent enabled field defaults to matching (conservative default)", cronJobMatches(liveJob(), CONFIG, "scheduled message"), true);
}

{
  const { ctx, calls } = stubContext({ jobs: [{ ...liveJob(), enabled: false }] });
  const state = await ensureCronJob(ctx, CONFIG, "scheduled message", { allowUpdate: true });
  check("ensureCronJob reconciles a disabled-but-otherwise-correct job", state, "updated");
  check(
    "reconciling a disabled job means remove then add, same as any other drift",
    calls.map((c) => c.slice(0, 2).join(" ")),
    ["cron list", "cron rm", "cron add"],
  );
}

{
  const { ctx, calls } = stubContext({ jobs: [{ ...liveJob(), schedule: { expr: "0 4 * * *" } }] });
  const state = await ensureCronJob(ctx, CONFIG, "scheduled message", { allowUpdate: true });
  check("a drifted job is replaced rather than left alone", state, "updated");
  check(
    "replacing means remove then add, in that order",
    calls.map((c) => c.slice(0, 2).join(" ")),
    ["cron list", "cron rm", "cron add"],
  );
  check("the remove targets the live job's id", calls[1], cronRmArgv("job-1"));
  check("the add carries the declaration", calls[2], cronAddArgv(CONFIG, "scheduled message"));
}

// The scope-upgrade self-heal these commands rely on lives in openclaw-cli.ts and is
// covered by openclaw-cli.check.ts — not duplicated here.

// --- provisioning never writes through a target symlink ----------------------------------
// --- (see docs/internal/review-2026-09-23-xxa-round-6.md) ---------------------------------
//
// syncRecipeFiles/writeWorkspacePromptFiles validated the SOURCE inventory but handed the
// target path straight to mkdirp/writeFile, both of which follow the final symlink, and
// nothing checked the target's ancestors. A process inside the instance can leave a link in
// its own workspace before the operator runs provisioning; the framework then overwrote
// whatever the link pointed at, with the operator's privileges, outside the data mount.
//
// These scenarios need a real POSIX filesystem with real symlinks: local on Linux, a WSL
// distribution on it — the same idiom as restore-symlink-boundary.check.ts. The recipe
// source is read by Node directly, so on Windows it stays on the Windows side while only
// the target lives in the distribution.

async function realPosixTarget(): Promise<Transport | undefined> {
  if (process.platform === "linux") return new LocalTransport();
  if (process.platform !== "win32") return undefined;
  try {
    const listing = await spawnLocal("wsl.exe", ["--list", "--quiet"], { allowFailure: true, timeoutMs: 30_000 });
    for (const distro of parseWslDistroListing(listing.stdout).slice(0, 2)) {
      const candidate = new WslTransport(distro);
      const shell = await candidate
        .exec("sh", ["-c", "true"], { allowFailure: true, timeoutMs: 30_000 })
        .then((result) => result.code === 0, () => false);
      if (shell) return candidate;
    }
  } catch {
    // wsl.exe missing or unlaunchable — the absent probe is reported by the check after the requires block.
  }
  return undefined;
}

let probeTarget: Transport | undefined;
await requires("local-posix", "provision symlink-boundary checks", async () => {
  probeTarget = await realPosixTarget();
  // requires() already held local-posix: a probe that disagrees is a failure, never a skip.
  if (probeTarget === undefined) check("provision symlink-boundary checks: local-posix holds, so a POSIX transport must answer", "none", "a POSIX transport");
});
// Without the capability requires() reported the skip (or, under --require, the failure).
if (probeTarget !== undefined) {
  const linkTransport = probeTarget;
  // A one-shot target root with an `outside/` directory beside the data dir, plus a recipe
  // directory Node can read directly. Cleanup removes both sides.
  const stage = async (label: string) => {
    const recipeDir = await mkdtemp(join(tmpdir(), `clawwright-prov-${label}-recipe-`));
    const root = process.platform === "win32"
      ? `/tmp/clawwright-prov-${label}-${randomBytes(4).toString("hex")}`
      : await mkdtemp(join(tmpdir(), `clawwright-prov-${label}-root-`));
    const dataDir = `${root}/data`;
    const outside = `${root}/outside`;
    await linkTransport.mkdirp(outside);
    return {
      root,
      recipeDir,
      dataDir,
      outside,
      async cleanup(): Promise<void> {
        await rm(recipeDir, { recursive: true, force: true });
        await linkTransport.remove(root).catch(() => {});
      },
    };
  };

  const linkContext = (dataDir: string) => ({ settings: { dataDir }, transport: linkTransport }) as unknown as Context;

  // Scenario 1: the wanted file's name is already a symlink to a file outside the data
  // dir. Before the fix, writeFile/tee followed it and clobbered the victim.
  {
    const s = await stage("alias");
    try {
      await linkTransport.writeFile(`${s.outside}/victim.txt`, "operator data\n");
      const mirror = recipeMirrorTargetDir(s.dataDir, "alias-recipe");
      await linkTransport.mkdirp(mirror);
      await linkTransport.exec("ln", ["-s", `${s.outside}/victim.txt`, `${mirror}/server.ts`]);
      await writeFile(resolve(s.recipeDir, "server.ts"), "export default 1;\n");

      const message = await rejectionOf(() => syncRecipeFiles(linkContext(s.dataDir), "alias-recipe", s.recipeDir));
      checkTrue("a target file name that is a symlink to outside the data dir is refused", message !== undefined);
      checkTrue("the refusal names the containment boundary", (message ?? "").includes("outside the target root"));
      check("the linked external file was never written through", await linkTransport.readFile(`${s.outside}/victim.txt`), "operator data\n");
      checkTrue(
        "the planted link itself survives the refused write",
        (await linkTransport.exec("test", ["-h", `${mirror}/server.ts`], { allowFailure: true })).code === 0,
      );
    } finally {
      await s.cleanup();
    }
  }

  // Scenario 2: an ancestor of the wanted file — here the whole mirror directory — is a
  // symlink escaping the data dir. Before the fix, mkdirp/writeFile landed in the target.
  {
    const s = await stage("nested");
    try {
      const mirror = recipeMirrorTargetDir(s.dataDir, "nested-recipe");
      await linkTransport.mkdirp(`${s.dataDir}/workspace`);
      await linkTransport.exec("ln", ["-s", s.outside, mirror]);
      await writeFile(resolve(s.recipeDir, "server.ts"), "export default 1;\n");

      const message = await rejectionOf(() => syncRecipeFiles(linkContext(s.dataDir), "nested-recipe", s.recipeDir));
      checkTrue("a target ancestor that is a symlink to outside the data dir is refused", message !== undefined);
      checkTrue("that refusal also names the containment boundary", (message ?? "").includes("outside the target root"));
      check("the external directory received no files", await linkTransport.listFiles(s.outside), []);
      checkTrue(
        "the planted ancestor link itself survives",
        (await linkTransport.exec("test", ["-h", mirror], { allowFailure: true })).code === 0,
      );
    } finally {
      await s.cleanup();
    }
  }

  // Scenario 3: the happy path — no symlinks anywhere — must still work exactly as before.
  {
    const s = await stage("plain");
    try {
      await mkdir(resolve(s.recipeDir, "data"), { recursive: true });
      await writeFile(resolve(s.recipeDir, "server.ts"), "export default 1;\n");
      await writeFile(resolve(s.recipeDir, "data", "page.md"), "# page\n");

      const result = await syncRecipeFiles(linkContext(s.dataDir), "plain-recipe", s.recipeDir);
      check("a link-free mirror still syncs", result, { written: 2, removed: [] });
      const mirror = recipeMirrorTargetDir(s.dataDir, "plain-recipe");
      check("the mirrored server file lands with its content", await linkTransport.readFile(`${mirror}/server.ts`), "export default 1;\n");
      check("the mirrored nested page lands with its content", await linkTransport.readFile(`${mirror}/data/page.md`), "# page\n");
    } finally {
      await s.cleanup();
    }
  }

  // Scenario 4: the same contract for prompt writes — AGENTS.md planted as an external
  // link must be refused, not written through.
  {
    const s = await stage("prompt");
    try {
      await linkTransport.writeFile(`${s.outside}/victim.txt`, "operator data\n");
      const workspace = agentWorkspaceTargetDir(s.dataDir, "demo-agent");
      await linkTransport.mkdirp(workspace);
      await linkTransport.exec("ln", ["-s", `${s.outside}/victim.txt`, `${workspace}/AGENTS.md`]);

      const message = await rejectionOf(() => writeWorkspacePromptFiles(linkContext(s.dataDir), CONFIG, { "AGENTS.md": "# prompt\n" }));
      checkTrue("a prompt file name that is a symlink to outside the data dir is refused", message !== undefined);
      checkTrue("the prompt refusal names the containment boundary", (message ?? "").includes("outside the target root"));
      check("the prompt write never reached the external file", await linkTransport.readFile(`${s.outside}/victim.txt`), "operator data\n");
    } finally {
      await s.cleanup();
    }
  }
}

finish("provision-agent");

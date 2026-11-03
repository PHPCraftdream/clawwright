// The MCP path for `recipe trial`, without standing in for the command: the subprocess
// server below serves the REAL recipe declaration and the REAL runTrial code — only the
// transport is a stub (docker/config/du/probe/copy/down recorded fakes, the same reaction
// model the recipe-trial fixture uses). A tools/call with `dry-run: true` must carry the
// REAL dry-run report in the envelope, and a confirmed real trial must run to ready.
// GATED on a POSIX host: createContext derives the PathBridge kind from the transport
// CLASS (`transport instanceof WslTransport`), so an injected stub always gets the LOCAL
// bridge — on Windows that hands the trial a `C:/...` definition path, which the product
// rightly refuses as malformed. A stub cannot select the WSL bridge, and wrapping a real
// WslTransport would trade the gate for a real-WSL dependency — so the gate stays.
// (OC_TARGET_LOCATION in the .env cannot change this: only the transport class decides.)

import { check, checkTrue, finish, requires } from "#checks/kit/harness.ts";
import { runProcess, type ProcessResult } from "#checks/kit/spawn.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const moduleUrl = (name: string): string => new URL(`../../../../../packages/clawwright/${name}.ts`, import.meta.url).href;

function runScript(script: string, input: string): Promise<ProcessResult> {
  return runProcess(process.execPath, ["--input-type=module", "-e", script], { cwd: tmpdir(), input: `${input}\n` });
}

await requires("posix-host", "recipe trial over MCP", async () => {
  const deploymentRoot = await mkdtemp(join(tmpdir(), "clawwright-mcp-trial-deploy-"));
  const recipesRoot = join(deploymentRoot, "recipes");
  await mkdir(join(recipesRoot, "subject"), { recursive: true });
  await writeFile(join(recipesRoot, "subject", "recipe.json"),
    JSON.stringify({ description: "The MCP-path trial subject" }), "utf8");
  await writeFile(join(recipesRoot, "subject", "compose.yml"), "services:\n  app:\n    image: nginx\n    ports:\n      - \"8080:80\"\n", "utf8");
  await writeFile(join(deploymentRoot, ".env"),
    `OC_DATA_DIR=${join(deploymentRoot, "data")}\nOC_TARGET_LOCATION=wsl\nOC_COMPOSE_PROJECT=clawwright-mcp-trial\n`, "utf8");

  // The stub transport inside the subprocess (kept as a plain string-built object: no JSON
  // round trip needed — the script text embeds the recipes and deployment roots verbatim).
  const script = `
  const { serveMcp } = await import(${JSON.stringify(moduleUrl("integration/mcp/server"))});
  const { useDeployment } = await import(${JSON.stringify(moduleUrl("runtime/deployment"))});
  const { useRecipesDir } = await import(${JSON.stringify(moduleUrl("service/recipe"))});
  const { managementCommands } = await import(${JSON.stringify(moduleUrl("commands/interface/groups/openclawCommands.management"))});
  const deploymentRoot = ${JSON.stringify(deploymentRoot)};
  await useRecipesDir(${JSON.stringify(join(deploymentRoot, "recipes"))});
  await useDeployment(deploymentRoot);
  const ok = { code: 0, stdout: "", stderr: "" };
  const BASE = JSON.stringify({ services: { app: { build: { context: "." }, ports: [{ mode: "ingress", host_ip: "", target: 80, published: "8080", protocol: "tcp" }] } } });
  const privateFiles = new Map();
  const dirs = new Set();
  const docker = async (argv) => {
    if (argv.includes("version")) return { code: 0, stdout: "v2.27.1" + String.fromCharCode(10), stderr: "" };
    if (argv.includes("config") && argv.includes("--format")) {
      const files = argv.flatMap((entry, index) => entry === "--file" ? [argv[index + 1] ?? ""] : []);
      const override = files.length > 1 ? privateFiles.get(files[1]) : undefined;
      if (override !== undefined) {
        try {
          const { mergeCompose } = await import(${JSON.stringify(new URL("../../../runtime/recovery/recipe-trial/fixture.ts", import.meta.url).href)});
          const merged = await mergeCompose(BASE, override);
          for (const service of Object.values(merged.services)) if (service.build !== undefined) {
            const imageLine = /^    image: (.+)$/m.exec(override);
            if (imageLine !== null) service.image = imageLine[1];
          }
          return { code: 0, stdout: JSON.stringify(merged), stderr: "" };
        } catch (error) { return { code: 1, stdout: "", stderr: String(error) }; }
      }
      return { code: 0, stdout: BASE, stderr: "" };
    }
      if (argv.includes("ps") && argv.includes("--format")) return { code: 0, stdout: JSON.stringify([{ Service: "app", State: "running", Health: "healthy" }]) + String.fromCharCode(10), stderr: "" };
    if (argv[0] === "logs") return { code: 0, stdout: "app ready" + String.fromCharCode(10), stderr: "" };
    if (argv[0] === "images") return { code: 0, stdout: "", stderr: "" };
    if (argv[0] === "image" && argv[1] === "inspect") return { code: 1, stdout: "", stderr: "Error response from daemon: No such image: " + (argv[2] ?? "") };
    return ok;
  };
  const transport = {
    description: "mcp-trial-stub",
    cancellation: "confirmed-local",
    async exec(command, args, options) {
      if (command === "sh" && args[0] === "-c" && args[1]?.includes("ln -T") && options?.input !== undefined) {
        const match = /ln -T -- "[$]temporary" '([^']+)'/.exec(args[1]);
        if (match !== null) privateFiles.set(match[1], Buffer.from(options.input).toString("utf8"));
        return ok;
      }
      if (command === "mkdir" && args[0] === "-m") return ok;
      if (command === "sh" && args[0] === "-c") {
        const label = args[2];
        if (label === "recipe-docker") return docker(args.slice(3));
        if (label === "recipe-trial-realpath" || label === "recipe-trial-mount-realpath") return { code: 0, stdout: args.slice(3).join(String.fromCharCode(10)) + String.fromCharCode(10), stderr: "" };
        if (label === "recipe-trial-symlinks") return { code: 0, stdout: "", stderr: "" };
        if (label === "recipe-staging-proof") return { code: 0, stdout: "verified", stderr: "" };
        if (label === "recipe-provenance") {
          const pinned = args[5] ?? "";
          const content = privateFiles.get(pinned);
          return content === undefined ? { code: 1, stdout: "", stderr: "not found" } : { code: 0, stdout: content, stderr: "" };
        }
        if (args[1]?.includes("cp -a")) return ok;
        if (args[1]?.includes("realpath --")) return { code: 0, stdout: args.slice(3).join(String.fromCharCode(10)) + String.fromCharCode(10), stderr: "" };
      }
      if (command === "sh" && args[0] === "-s") return { code: 0, stdout: "exists" + String.fromCharCode(10), stderr: "" };
        if (command === "docker") return docker([...args]);
      return ok;
    },
    async readFile() { return ""; },
    async writeFile() {},
    async remove() {},
    async listFiles() { return []; },
    async mkdirPrivate() {},
    async writePrivateFile() {},
  };
  await serveMcp({ name: "trial-mcp", commands: { recipe: managementCommands.recipe } }, [], [], { transport });
  `;

  const requests = [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "recipe", arguments: { action: "trial", name: "subject", "dry-run": true } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "recipe", arguments: { action: "trial", name: "subject", confirm: true } } },
  ];

  let result: ProcessResult | undefined;
  try {
    result = await runScript(script, requests.map((request) => JSON.stringify(request)).join("\n"));
  } finally {
    await rm(deploymentRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  if (result === undefined || result.code !== 0) {
    process.stderr.write(`trial MCP server exited ${result?.code ?? "?"}:\n${result?.stderr ?? ""}\n`);
  }
  const responses = (result?.stdout ?? "")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { id?: number; result?: { isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: { changed?: boolean; result?: unknown } } });
  const envelopeOf = (id: number): { isError?: boolean; text: string; result: unknown } | undefined => {
    const reply = responses.find((response) => response.id === id)?.result;
    if (reply === undefined) return undefined;
    return { isError: reply.isError, text: String(reply.content?.[0]?.text ?? ""), result: reply.structuredContent?.result };
  };

  const dryRun = envelopeOf(1);
  if (dryRun?.isError === true) process.stderr.write(`dry-run MCP tool error: ${dryRun.text}\n`);
  check("the dry-run call succeeds over MCP", dryRun?.isError, undefined);
  const report = dryRun?.result as Record<string, unknown> | undefined;
  check("the envelope carries the REAL dry-run report's recipe", report?.recipe, "subject");
  checkTrue("the dry-run report carries the real trial project shape",
    typeof report?.project === "string" && /^clawwright-recipe-trial-[0-9a-f]{12}-[0-9a-f]{8}$/.test(report.project));
  check("the dry-run report states the privatePaths bound", report?.boundBytes, 268435456);
  checkTrue("the dry-run report is a dry run", report?.dryRun === true && report?.ok === true);

  const real = envelopeOf(2);
  if (real?.isError === true) process.stderr.write(`real-run MCP tool error: ${real.text}\n`);
  check("the confirmed real trial succeeds over MCP", real?.isError, undefined);
  const realReport = real?.result as { status?: string; serviceVerdicts?: Record<string, string> } | undefined;
  check("the real trial ran to ready", realReport?.status, "ready");
  check("the real trial reports the service verdict", realReport?.serviceVerdicts?.app, "ready");
  checkTrue("the real trial's text stands beside the envelope", (real?.text ?? "").length > 0);

});

finish("mcp-trial-run");

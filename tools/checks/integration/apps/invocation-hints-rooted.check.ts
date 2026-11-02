// rooted invocation hint assertions
import { cp, mkdir, symlink, access } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { createDeploymentFixture } from "#checks/kit/deployment-fixture.ts";
import { frameworkOwner } from "#framework/entry/resolve.ts";
import { spawnDelegated } from "#framework/entry/delegate.ts";
import { resolveCheckoutEntry } from "#framework/entry/resolve.ts";
import { frameFromInvocation } from "#framework/core/io/invocation/frame.ts";
import type { Invocation } from "#framework/core/io/invocation/index.ts";
import { INVOCATION_ENV, parseInvocation } from "#framework/core/io/invocation/index.ts";

import { appsRootFor, monorepoRoot } from "#framework/core/env.ts";
import { checkoutGateFrame } from "#framework/core/io/invocation/frame.ts";
import { command } from "#framework/core/io/invocation/advice.ts";
import { renderFrameAdvice } from "#framework/core/io/invocation/render.ts";
import { check, checkTrue, finish, isolatedAppsRoot } from "#checks/kit/harness.ts";
import { runProcess, CHILD_NODE_DEADLINE_MS } from "#checks/kit/spawn.ts";
import { maskSecrets } from "#framework/core/io/log.ts";

const entryApps = await isolatedAppsRoot("rooted-hints");
const sourceRoot = await isolatedAppsRoot("rooted-hints-source");
await cp(resolve(monorepoRoot, "tools"), resolve(sourceRoot.root, "tools"), { recursive: true });
await mkdir(resolve(sourceRoot.root, "packages"), { recursive: true });
await cp(resolve(monorepoRoot, "packages", "clawwright"), resolve(sourceRoot.root, "packages", "clawwright"), {
  recursive: true,
  filter: (entry) => !["dist", "node_modules"].includes(entry.split(/[\\/]/).at(-1) ?? ""),
});
await access(resolve(sourceRoot.root, "packages", "clawwright", "entry", "bin.ts"));
await cp(resolve(monorepoRoot, "package.json"), resolve(sourceRoot.root, "package.json"));
await symlink(resolve(monorepoRoot, "node_modules"), resolve(sourceRoot.root, "node_modules"), "junction");
const GATE = resolve(sourceRoot.root, "tools", "clawwright.ts");
const SUBDIR = resolve(sourceRoot.root, "docs");
await mkdir(SUBDIR);

/** Runs the real gate from `cwd` — the committed shim path, exactly as gate-dispatch does. */
async function runGate(args: string[], cwd: string, expectedCode = 0): Promise<string> {
  const result = await runProcess(process.execPath, ["--experimental-strip-types", GATE, ...args], { cwd, timeoutMs: CHILD_NODE_DEADLINE_MS });
  check(`gate exit code for ${args[0] ?? "<empty>"}`, result.code, expectedCode);
  if (result.code !== expectedCode) {
    const diagnostic = maskSecrets(result.output).slice(-2000).split(/\r?\n/).slice(-20).join("\n    ");
    process.stderr.write(`    rooted-hints gate exit mismatch:\n    ${diagnostic}\n`);
  }
  return result.output;
}

// entry: the real gate runs against an EMPTY apps root, so a deployment left in the checkout never selects itself

const docsHelp = await runGate(["help"], SUBDIR);
check("help from docs/ spells the entry relative to that folder", docsHelp.split(["Usage:", "../clawwright", "<command>", "[options]"].join(" ")).length > 1, true);
check("help from docs/ carries no root spelling", docsHelp.split(["Usage:", "./clawwright"].join(" ")).length > 1, false);

const docsUnknown = await runGate(["frobnicate"], SUBDIR, 1);
check("an unknown command's hint from docs/ spells the entry relative to that folder", docsUnknown.split(["run", "../clawwright", "help"].join(" ")).length > 1, true);

const rootHelp = await runGate(["help"], sourceRoot.root);
check("help from the checkout root keeps the root spelling", rootHelp.split(["Usage:", "./clawwright", "<command>", "[options]"].join(" ")).length > 1, true);
await entryApps.dispose();
await sourceRoot.dispose();

// unit frame

const ROOT = "/clawwright-checkout";
const HOST = "posix";
const FRAME_SUBDIR = `${ROOT}/docs`;
const frame = checkoutGateFrame(ROOT, { host: HOST, msys: false, cwd: FRAME_SUBDIR });
checkTrue("frame rooted relative hint", renderFrameAdvice(command(["status"]), frame) === ["../clawwright", "status"].join(" "));
checkTrue("the rooted hint derives its entry from the frame root", renderFrameAdvice(command(["status"]), frame).startsWith("../clawwright"));
const atRoot = checkoutGateFrame(ROOT, { host: HOST, msys: false, cwd: ROOT });
checkTrue("root frame spelling", renderFrameAdvice(command(["status"]), atRoot) === ["./clawwright", "status"].join(" "));

// production: delegated spawn helper executes the production spawn contract through an injected runner.
const invocation: Invocation = { program: "clawwright", mode: "installed", app: { name: "demo", selectedBy: "flag" }, audience: "terminal" };
const spawnFrame = frameFromInvocation(invocation, { host: "posix", msys: false, cwd: process.cwd() });
const fixture = await createDeploymentFixture();
try {
  const root = fixture.root;
  const checkoutRoot = monorepoRoot;
  const appsRoot = appsRootFor(checkoutRoot);
  const appRoot = resolve(monorepoRoot, "apps", "demo");
  const owner = frameworkOwner({ self: resolve(root, "global", "entry", "bin.js"), appRoot, launchArgv: ["--app", "demo", "status"], argv: ["status"], handedOver: false, platform: "linux", fs: {
    exists: (path) => path === resolve(checkoutRoot, "tools", "clawwright.ts") || path === resolve(appRoot, "app.ts") || path === resolve(checkoutRoot, "apps", "demo", "app.ts"),
    isDirectory: (path) => path === resolve(checkoutRoot, "apps", "demo") || path === resolve(checkoutRoot, "apps"),
    readdir: (path) => path === resolve(checkoutRoot, "apps") ? ["demo"] : [],
    readFile: (path) => path === resolve(checkoutRoot, "packages", "clawwright", "package.json") ? JSON.stringify({ name: "@phpcraftdream/clawwright" }) : undefined,
    realpath: (path) => path,
  }, localEntry: undefined });
  checkTrue("system launch delegates to owning checkout gate", owner.kind === "spawn" && owner.delegated === false);
  if (owner.kind === "spawn") {
    let captured: { command: string; args: readonly string[]; options: SpawnSyncOptions } | undefined;
    const runner = (command: string, args: readonly string[], options: SpawnSyncOptions) => {
      captured = { command, args, options };
      return { pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null, error: undefined } as ReturnType<typeof spawnSync>;
    };
    spawnDelegated(owner.entry, [...owner.args], owner.delegated, spawnFrame, runner as typeof spawnSync);
    check("delegated spawn passes selected app to final gate", captured?.args.slice(2), owner.args);
    checkTrue("delegated spawn inherits cwd", captured !== undefined && captured.options.cwd === undefined);
    const finalInvocation = captured === undefined ? undefined : parseInvocation(String(captured.options.env?.[INVOCATION_ENV]));
    checkTrue("delegated spawn serializes selected app", finalInvocation?.app?.name === "demo" && finalInvocation.app.selectedBy === "flag");
    const final = resolveCheckoutEntry({ root: checkoutRoot, cwd: process.cwd(), argv: owner.args, ocApp: undefined, handedOver: true, launch: frame.launch, handedProgram: owner.entry, fs: {
      exists: (path) => path === resolve(checkoutRoot, "tools", "clawwright.ts") || path === resolve(appsRoot, "openclaw", "app.ts") || path === resolve(appsRoot, "demo", "app.ts"),
      isDirectory: (path) => path === appsRoot || path === resolve(appsRoot, "demo"),
      readdir: (path) => path === appsRoot ? ["demo"] : [],
      readFile: (path) => path === resolve(checkoutRoot, "packages", "clawwright", "package.json") ? JSON.stringify({ name: "@phpcraftdream/clawwright" }) : undefined,
      realpath: (path) => path,
    }, gateCommands: [], deploymentCommands: ["status"], variadicCommands: [] });
    checkTrue("delegated spawn passes the selected app to the final gate", final.kind === "run" && final.appName === "demo");
    check("delegated spawn preserves the final argv", final.kind === "run" ? final.argv : undefined, ["status"]);
  }
} finally {
  await fixture.dispose();
}

finish("rooted invocation hints");

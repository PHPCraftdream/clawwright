// Durable output from the TARGET's own frame (stage 7 S1.5; design section 9, risk (1)):
// every durable writer below is driven under operator frames that differ in cwd, launch
// and host — checkout root, checkout subdirectory, system launch, Windows npm-bin
// wrapper — and the bytes it stores are compared with LITERAL expected text recorded
// from HEAD (captured once from a detached HEAD worktree): Buffer.compare on the exact
// stored strings, no whitespace normalization, no expectation computed from the product,
// and sha256 over the whole shim and launcher files as the production file writers emit
// them. The ratchet at the end holds the durable-writer modules to the target-frame
// rule: reads of the ambient operator frame there are counted, shrink-only, and every
// remaining site is listed with its reason.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { monorepoRoot } from "#framework/core/env.ts";
import { installFrame, invocation, setInvocation } from "#framework/core/io/invocation/index.ts";
import { checkoutGateFrame, targetFrame, type Frame } from "#framework/core/io/invocation/frame.ts";
import { command } from "#framework/core/io/invocation/advice.ts";
import { renderAdvice } from "#framework/core/io/invocation/render.ts";
import { MANUAL_INSTALL_HEADER, cronLine, posixTargetInvocation, printSchedulingInstructions, schtasksCreateCommand, scheduledInvocation, scheduledTargetFrame } from "#framework/commands/operate/schedule.ts";
import { frameworkSourceRoot } from "#framework/commands/management/deploy/arguments.ts";
import { deploymentName, useDeployment } from "#framework/runtime/deployment.ts";
import { WslTransport } from "#framework/runtime/transport/wsl.ts";
import { SHIM, declarationFor as initDeclaration, writeShim } from "#framework/integration/deployment/init.ts";
import { declarationFor as scaffoldDeclaration } from "#framework/integration/deployment/scaffold.ts";
import { MCP_LAUNCHER_FILENAME, setupProjectMcp } from "#framework/integration/mcp/project.ts";
import { bootstrapRemoteLine, remoteLine } from "#framework/commands/management/deploy/sync.ts";
import { makeCompletionGateCommand, renderCompletion } from "#framework/integration/completion/index.ts";
import { completionData } from "#framework/integration/completion/table.ts";
import { surfaceRegistry } from "#framework/entry/registry.ts";
import type { Context } from "#framework/core/context.ts";
import type { GateCommand } from "#framework/integration/gate.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { withOutputSink } from "#framework/core/io/output.ts";

const gateCommands: GateCommand[] = [];
gateCommands.push(makeCompletionGateCommand(gateCommands, true));
const data = completionData(surfaceRegistry(), true);

// --- HEAD literals (captured once from a detached HEAD worktree, no normalization) -------

const HEAD_SHIM_SHA256 = "532092b9807cad5f9ff6557dcbd1b60761c5f8406abc89eab8f1b811cfe03730";
const HEAD_LAUNCHER_MONOREPO_SHA256 = "c6432c1a51f1fce08169fbeb213e7a164e686526e87d950662b4a3674cb395c8";
const HEAD_LAUNCHER_INSTALLED_SHA256 = "6b97e1202a3510ed22bde9bf98f363f4698fb432b56056a57e2d2ae0eff494cf";
const HEAD_INIT_STORED = [
  "// This deployment.",
  "//",
  "// Says which service this deployment manages and which framework commands it exposes.",
  "// Its configuration lives next to this file: .env, config/, secrets/, recipes/.",
  "//",
  "// Run it with: ./clawwright status",
  "",
  "import { defineApp } from \"@phpcraftdream/clawwright/app\";",
  "import { mountPoints } from \"@phpcraftdream/clawwright/mounts\";",
  "import { openclawCommands } from \"@phpcraftdream/clawwright/commands\";",
  "",
  "export default defineApp({",
  "  name: \"demo\",",
  "  description: \"self-hosted OpenClaw instance\",",
  "",
  "  service: { name: \"gateway\", logTail: \"100\" },",
  "  mounts: mountPoints,",
  "",
  "  // Every framework command. Add your own entries here if this deployment needs something",
  "  // the framework does not provide.",
  "  commands: openclawCommands,",
  "});",
  "",
].join("\n");
const HEAD_SCAFFOLD_STORED = [
  "// The demo deployment.",
  "//",
  "// Says which service this deployment manages and which framework commands it exposes.",
  "// Its configuration lives next to this file: .env, config/, secrets/, recipes/.",
  "//",
  "// Run it with:  ./clawwright --app demo status",
  "",
  "import { defineApp } from \"../../packages/clawwright/core/app.ts\";",
  "import { mountPoints } from \"../../packages/clawwright/runtime/mounts.ts\";",
  "import { openclawCommands } from \"../../packages/clawwright/commands/interface/index.ts\";",
  "",
  "export default defineApp({",
  "  name: \"demo\",",
  "  description: \"deployment of a self-hosted OpenClaw instance\",",
  "",
  "  service: { name: \"gateway\", logTail: \"100\" },",
  "  mounts: mountPoints,",
  "",
  "  // Every framework command, under this deployment. Add your own entries here if this",
  "  // deployment needs something the framework does not provide.",
  "  commands: openclawCommands,",
  "});",
  "",
].join("\n");

const sha256 = (text: string): string => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
const bytesEqual = (actual: string, expected: string): boolean => Buffer.compare(Buffer.from(actual, "utf8"), Buffer.from(expected, "utf8")) === 0;

/** Byte-identity against a HEAD literal; on divergence the first differing bytes are shown. */
function expectBytes(name: string, actual: string, expected: string): void {
  if (!bytesEqual(actual, expected)) {
    let at = 0;
    while (at < actual.length && at < expected.length && actual[at] === expected[at]) at += 1;
    process.stderr.write(`    bytes diverge at ${at}: got ${JSON.stringify(actual.slice(Math.max(0, at - 24), at + 48))} want ${JSON.stringify(expected.slice(Math.max(0, at - 24), at + 48))}\n`);
  }
  checkTrue(`${name} (byte-identical to HEAD)`, bytesEqual(actual, expected));
}

// --- the operator frames the writers are driven under ---------------------------------------

const CHECKOUT = "/repo";
const DEP = "/dep";

/** Runs `body` with `frame` installed as the run's frame, then restores. */
async function under(frame: Frame, body: () => Promise<void>): Promise<void> {
  const previous = invocation();
  installFrame(frame);
  try { await body(); } finally { setInvocation(previous); }
}

const atRoot = checkoutGateFrame(CHECKOUT, { host: "posix", msys: false, cwd: CHECKOUT });
const fromSub = checkoutGateFrame(CHECKOUT, { host: "posix", msys: false, cwd: `${CHECKOUT}/apps/team` });
const systemWide: Frame = {
  launch: { kind: "system" },
  host: { kind: "operator", platform: "posix" },
  shells: ["posix"],
  cwd: { kind: "unknown" },
  places: {},
  app: { state: "none" },
  audience: "terminal",
};
// The Windows operator: npm's bin wrapper as typed, standing in a subdirectory of the
// deployment — the R18-06 shape.
const win32BinFromSub: Frame = {
  launch: { kind: "npm-bin", root: DEP },
  host: { kind: "operator", platform: "win32" },
  shells: ["cmd", "pwsh"],
  cwd: { kind: "dir", path: `${DEP}/apps/team` },
  places: {},
  app: { state: "none" },
  audience: "terminal",
};
const OPERATOR_FRAMES = [
  ["checkout root", atRoot],
  ["checkout subdirectory", fromSub],
  ["system launch", systemWide],
  ["win32 npm-bin wrapper from a subdirectory", win32BinFromSub],
] as const;

// --- the production fixture the writers resolve their deployment against --------------------

const FIXTURE = "clawwright-df-fixture";
// a unique parent keeps parallel runs apart; the deployment dir keeps its literal name
const fixtureParent = await mkdtemp(join(tmpdir(), "clawwright-df-"));
const fixtureRoot = join(fixtureParent, FIXTURE);
await mkdir(fixtureRoot, { recursive: true });
useDeployment(fixtureRoot);
const name = deploymentName();
checkTrue("the fixture deployment has a fixed, literal name", name === FIXTURE);

const sshCtx = { transport: { description: "ssh:user@host" }, settings: { remotePath: "/srv/openclaw" } } as unknown as Context;
const localCtx = { transport: { description: "local" }, settings: {} } as unknown as Context;

// --- cron: the production invocation builder + the production line builder ------------------

const SSH_CRON = "*/5 * * * * cd '/srv/openclaw' && ./clawwright '--app' 'clawwright-df-fixture' 'watch' 'check' >/dev/null 2>&1 # clawwright-watch:scheduler-id";
for (const [label, frame] of OPERATOR_FRAMES) {
  await under(frame, async () => {
    const inv = await posixTargetInvocation(sshCtx, ["watch", "check"]);
    expectBytes(`${label}: the watch crontab entry, through the production builders`, cronLine(5, inv, "watch", "scheduler-id"), SSH_CRON);
  });
}
{
  // The local branches carry machine roots, so exact literals are impossible there; the
  // frame-independence property is still exact bytes: every frame produces one identical text.
  const seen = new Map<string, number>();
  for (const [, frame] of OPERATOR_FRAMES) {
    await under(frame, async () => {
      const inv = await posixTargetInvocation(localCtx, ["backup"]);
      const text = JSON.stringify([inv.cwd === monorepoRoot, inv.command, ...inv.args]);
      seen.set(text, (seen.get(text) ?? 0) + 1);
    });
  }
  check("the monorepo crontab invocation is byte-identical under every operator frame", [...seen.values()], [OPERATOR_FRAMES.length]);
}

// --- deploy's installed-mode refusal: durable text for the server -----------------------------

{
  const fake = await mkdtemp(join(tmpdir(), "clawwright-df-nocheckout-"));
  const previous = process.env[ "CLAWWRIGHT_CHECKS_SOURCE_ROOT" ];
  process.env[ "CLAWWRIGHT_CHECKS_SOURCE_ROOT" ] = fake;
  try {
    await under(fromSub, async () => {
      let error: unknown;
      try { await frameworkSourceRoot(fake); } catch (caught) { error = caught; }
      const advice = error !== undefined && typeof error === "object" && error !== null && Array.isArray((error as { advice?: unknown }).advice) ? ((error as { advice: unknown[] }).advice)[0] as Parameters<typeof renderAdvice>[0] : undefined;
      check("the installed-mode refusal spells the server's own bootstrap line",
        advice === undefined ? String(advice) : renderAdvice(advice, fromSub), "./clawwright bootstrap");
    });
  } finally {
    if (previous === undefined) delete process.env[ "CLAWWRIGHT_CHECKS_SOURCE_ROOT" ];
    else process.env[ "CLAWWRIGHT_CHECKS_SOURCE_ROOT" ] = previous;
    await rm(fake, { recursive: true, force: true });
  }
}

// --- schtasks: the production argv builder over the production WSL client invocation --------

const wsl = new WslTransport("Ubuntu-24.04");
const SCHTASKS_ENTRY = "/srv/openclaw/clawwright";
const wslCtx = {
  transport: { description: "wsl:Ubuntu-24.04", clientInvocation: wsl.clientInvocation.bind(wsl) },
  paths: { async toTarget(): Promise<string> { return SCHTASKS_ENTRY; } },
  settings: {},
} as unknown as Context;
const schtasksInvocation = wsl.clientInvocation(SCHTASKS_ENTRY, ["--app", FIXTURE, "backup"]);
check("the schtasks /create command, through the production builders, is the literal target line",
  schtasksCreateCommand("clawwright-scheduler-id-backup", 1440, schtasksInvocation),
  {
    command: "schtasks",
    args: ["/create", "/tn", "clawwright-scheduler-id-backup", "/sc", "DAILY", "/tr",
      `wsl.exe -d Ubuntu-24.04 --exec bash -lc "set -e; cd -- '/srv/openclaw'; exec './clawwright' '--app' 'clawwright-df-fixture' 'backup'"`, "/f"],
  });
{
  // The whole print path of the Windows fallback, driven per operator frame: the header
  // and the wsl.exe line are HEAD literals (with log's own indent), the task name carries
  // the machine's scheduler identity hash, so the whole capture is held byte-identical
  // across frames.
  const captures: string[] = [];
  for (const [, frame] of OPERATOR_FRAMES) {
    const printed: string[] = [];
    await under(frame, async () => {
      await withOutputSink((chunk) => printed.push(chunk), async () => {
        await printSchedulingInstructions(wslCtx, "backup", name, 1440, ["backup"], false);
      });
    });
    captures.push(printed.join(""));
  }
  checkTrue("the schtasks fallback print is byte-identical under every operator frame", new Set(captures).size === 1);
  expectBytes("the schtasks fallback manual header", captures[0]!.split("\n")[0]!, `    ${MANUAL_INSTALL_HEADER}`);
  expectBytes("the schtasks fallback wsl.exe line", captures[0]!.split("\n")[1]!, "      wsl.exe -d Ubuntu-24.04 --exec bash -lc \"set -e; cd -- '/srv/openclaw'; exec './clawwright' '--app' 'clawwright-df-fixture' 'backup'\"");
}
// --- init and scaffold: the production stored-text writers ----------------------------------

for (const [label, frame] of OPERATOR_FRAMES) {
  await under(frame, async () => {
    expectBytes(`${label}: init's stored app.ts text`, initDeclaration("demo"), HEAD_INIT_STORED);
    expectBytes(`${label}: scaffold's stored app.ts text`, scaffoldDeclaration("demo"), HEAD_SCAFFOLD_STORED);
    expectBytes(`${label}: the stored run-it line through the target frame`, renderAdvice(command(["status"], { app: "demo" }), targetFrame({ kind: "checkout-shim", root: "" }, "posix")), "./clawwright --app demo status");
  });
}

// --- deploy: the remote lines from the remote checkout's own frame (S1.5b) -------------------
//
// R19-10: the server line is spelled for the SERVER (./clawwright at the remote root),
// whatever launcher ran this deploy; R18-05: the cd prefix quotes the remote path by the
// POSIX rule. Exact bytes, a remote path with a space and a $, under every operator frame.

const REMOTE_ROOT = "/srv/open claw/$site";
const REMOTE_BOOTSTRAP = `cd '/srv/open claw/$site' && ./clawwright --app clawwright-df-fixture bootstrap`;
const REMOTE_SECRETS = `cd '/srv/open claw/$site' && ./clawwright --app clawwright-df-fixture secrets --apply`;
for (const [label, frame] of OPERATOR_FRAMES) {
  await under(frame, async () => {
    expectBytes(`${label}: deploy's remote bootstrap line`, bootstrapRemoteLine(REMOTE_ROOT, name), REMOTE_BOOTSTRAP);
    expectBytes(`${label}: deploy's install-them-there line`, remoteLine(REMOTE_ROOT, ["secrets", "--apply"], name), REMOTE_SECRETS);
  });
}

// --- the shim and launcher FILE writers, whole file contents and their sha256 ---------------

{
  const dir = await mkdtemp(join(tmpdir(), "clawwright-df-writer-"));
  try {
    await writeShim(dir);
    const shimFile = await readFile(join(dir, "clawwright"), "utf8");
    checkTrue("the shim file writer emits exactly the SHIM template", bytesEqual(shimFile, SHIM));
    check("the committed shim file's sha256 equals HEAD's", sha256(shimFile), HEAD_SHIM_SHA256);
    for (const mode of ["monorepo", "installed"] as const) {
      const root = join(dir, mode);
      await mkdir(root, { recursive: true });
      await setupProjectMcp(root, mode);
      const launcher = await readFile(resolve(root, MCP_LAUNCHER_FILENAME), "utf8");
      check(`the committed ${mode} launcher file's sha256 equals HEAD's`, sha256(launcher),
        mode === "monorepo" ? HEAD_LAUNCHER_MONOREPO_SHA256 : HEAD_LAUNCHER_INSTALLED_SHA256);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- completion Install headers, byte-exact per operator frame ------------------------------

const bashInstall = (): string => renderCompletion("bash", data).split("\n")[1]!;
const pwshInstall = (): string => renderCompletion("pwsh", data).split("\n")[1]!;
const zshLines = (): readonly string[] => renderCompletion("zsh", data).split("\n");

for (const [label, frame] of [["checkout root", atRoot], ["checkout subdirectory", fromSub]] as const) {
  await under(frame, async () => {
    expectBytes(`${label}: the bash Install header`, bashInstall(), "# Install: eval \"$(./clawwright completion bash)\"");
    expectBytes(`${label}: the zsh Install header`, zshLines()[3]!, "# grammar. Install: ./clawwright completion zsh > \"${fpath[1]}/_clawwright\" (new shell), or");
    expectBytes(`${label}: the zsh source line`, zshLines()[4]!, "# source <(./clawwright completion zsh) in the current one.");
    expectBytes(`${label}: the pwsh Install header keeps the S1.4 sentence form`, pwshInstall(), "# Install: run ./clawwright completion pwsh in Git Bash, save the output to a file, and dot-source it from PowerShell");
  });
}

await under(systemWide, async () => {
  expectBytes("installed: the bash Install header", bashInstall(), "# Install: eval \"$(clawwright completion bash)\"");
  expectBytes("installed: the pwsh Install header is the pipeline form", pwshInstall(), "# Install: clawwright completion pwsh | Out-String | Invoke-Expression");
});

await under(win32BinFromSub, async () => {
  // R18-06: the stored bash line spells npm's wrapper the way BASH reads it — forward
  // slashes, relative to the deployment root, never the operator's subdirectory or the
  // Windows wrapper this run was typed under.
  expectBytes("the bash Install header never spells the operator's Windows wrapper (R18-06): forward slashes from the target root, never the operator's cwd", bashInstall(), "# Install: eval \"$(node_modules/.bin/clawwright completion bash)\"");
  expectBytes("the zsh Install header under the Windows wrapper spells the POSIX program", zshLines()[3]!, "# grammar. Install: node_modules/.bin/clawwright completion zsh > \"${fpath[1]}/_clawwright\" (new shell), or");
  // The pwsh header names the wrapper the way POWERSHELL resolves it: the target shell's
  // own spelling (the .cmd wrapper), never a bash-only spelling.
  expectBytes("the pwsh Install header under the Windows wrapper spells the wrapper for pwsh", pwshInstall(), "# Install: node_modules\\.bin\\clawwright completion pwsh | Out-String | Invoke-Expression");
});

// --- the scheduled target frame constructors ------------------------------------------------

check("scheduledTargetFrame spells the deployment shim pasted at its root",
  scheduledInvocation(scheduledTargetFrame("/srv/openclaw"), ["--app", "demo", "backup"]),
  { cwd: "/srv/openclaw", command: "./clawwright", args: ["--app", "demo", "backup"] });
check("a checkout-rooted job runs the checkout shim at the checkout root",
  scheduledInvocation(scheduledTargetFrame(CHECKOUT, true), ["--app", "demo", "watch", "check"]),
  { cwd: CHECKOUT, command: "./clawwright", args: ["--app", "demo", "watch", "check"] });

// --- the ratchet: durable writers read no operator frame -------------------------------------
//
// Reads of the ambient operator frame inside the durable-writer modules, shrink-only:
// growth fails, lower the constant in the same commit as the change that reduced it.
// Counted forms: commandLine(, installLine(, installLineParts(, renderAdviceParts(,
// currentFrame(, invocation(, and a renderAdvice( call that passes no explicit frame.
// The recorded sites, each with its reason:
//   watch/install.ts, backup/install.ts — commandLine("deploy"): the printed `deploy`
//     mirror hint, spoken to the operator at their own terminal, never stored;
//   init.ts x2, scaffold.ts — commandLine(...): the printed `next:` steps, same nature;
//   scaffold.ts gitInitAdvice — renderAdvice(command(...)): the printed git-init
//     sentence, same nature;
//   completion/{index,bash,pwsh}.ts — installLineParts(...) x3: the stored-header API,
//     which renders through the TARGET frame internally (render.ts:361), so the stored
//     text never reads the operator frame.
// Every STORED text these modules emit is spelled by the target frame (targetFrame /
// scheduledTargetFrame / the fixed shim launch in init.ts).

const DURABLE_MODULES = [
  "packages/clawwright/commands/operate/schedule.ts",
  "packages/clawwright/commands/operate/watch/install.ts",
  "packages/clawwright/commands/lifecycle/backup/install.ts",
  "packages/clawwright/integration/completion/index.ts",
  "packages/clawwright/integration/completion/bash.ts",
  "packages/clawwright/integration/completion/pwsh.ts",
  "packages/clawwright/integration/deployment/init.ts",
  "packages/clawwright/integration/deployment/scaffold.ts",
  // S1.5b: deploy's server-side lines spell from the remote checkout's own frame
  // (targetFrame in deploy/{sync,arguments}.ts); the operator-side ssh tunnel line and the
  // printed `deploy` mirror hint are spoken at the operator's own terminal, not stored.
  "packages/clawwright/commands/management/deploy/sync.ts",
  "packages/clawwright/commands/management/deploy/arguments.ts",
] as const;

function ambientReads(source: string): number {
  let counted = 0;
  for (const line of source.split("\n")) {
    const stripped = line.replace(/(^|\s)\/\/.*$/, "$1");
    counted += (stripped.match(/\b(?:commandLine|installLine|installLineParts|renderAdviceParts)\(/g) ?? []).length;
    counted += (stripped.match(/\b(?:currentFrame|invocation)\(/g) ?? []).length;
    const callsRenderAdvice = /renderAdvice\(/.test(stripped);
    const passesExplicitFrame = /(shimInvocation|SHIM_TARGET|storedTarget|targetFrame)\(/.test(stripped);
    if (callsRenderAdvice && !passesExplicitFrame) counted += 1;
  }
  return counted;
}

let measured = 0;
for (const file of DURABLE_MODULES) measured += ambientReads(await readFile(resolve(monorepoRoot, file), "utf8"));
const RECORDED_DURABLE_AMBIENT = 9;
checkTrue(`durable writers' ambient-frame reads equal the recorded baseline (${measured} measured, ${RECORDED_DURABLE_AMBIENT} recorded, shrink-only — lower the constant in the same commit when a site leaves)`,
  measured === RECORDED_DURABLE_AMBIENT);

await rm(fixtureParent, { recursive: true, force: true });
finish("durable-frame");

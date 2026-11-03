// `clawwright init` — must not overwrite state a directory already holds.
//
// Only app.ts's existence used to be checked before writing anything: an .env or a
// config/desired-state.json already there (leftover from something else, or a previous init
// that failed partway through) was silently discarded.

import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { runProcess } from "#checks/kit/spawn.ts";

import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { initApp, ALREADY_EXISTS, ALREADY_INITIALISED, NOT_EXIST, NEEDS_ESM, NOT_VALID_JSON, noSaveInstall } from "#framework/integration/deployment/init.ts";
import { deploymentEnv as templateEnv, gitignoreLines as templateLines, nextStepsLines, isUnderSrv, updateGitignore, ROOT_OWNED } from "#framework/integration/deployment/deployment-template.ts";
import { commandLine, renderFrameAdvice } from "#framework/core/io/invocation/render.ts";
import { frameFacts, type Invocation } from "#framework/core/io/invocation/index.ts";
import { frameFromInvocation, launchFromHandover } from "#framework/core/io/invocation/frame.ts";
import { command } from "#framework/core/io/invocation/advice.ts";
import { resolveInstalledEntry, type FsProbe } from "#framework/entry/resolve.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { projectPort } from "#framework/core/env.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { check, checkTrue, finish, isolatedAppsRoot } from "#checks/kit/harness.ts";

/** The checkout-refusal row as the entry renders it: bin.ts's frame for the installed copy
 *  running inside a checkout — the same construction as its handed branch, frameFromInvocation
 *  over the hand-over with launchFromHandover classifying it by the fixture's FILE FACTS (the
 *  gate the checkout root holds), not by the spelling. The launch is the committed shim at
 *  the checkout root, so the shells are the shim's POSIX-only set, and the paste directory
 *  is the checkout root the sentence directs to. */
function renderAdviceAtOwnRoot(): string {
  const root = "/fake-checkout";
  const on: Invocation = { program: "./clawwright", mode: "checkout", audience: "terminal" };
  const files: Record<string, string> = {
    [`${root}/tools/clawwright.ts`]: "// gate",
    [`${root}/packages/clawwright/package.json`]: JSON.stringify({ name: "@phpcraftdream/clawwright" }),
  };
  const dirs = [`${root}/packages`, `${root}/packages/clawwright`];
  const normalize = (path: string): string => path.replaceAll("\\", "/").replace(/^[A-Za-z]:/, "");
  const frame = {
    ...frameFromInvocation(on, { ...frameFacts(), cwd: root, places: { checkoutRoot: root } }),
    launch: launchFromHandover(on, {
      cwd: root,
      fs: {
        exists: (path) => normalize(path) in files || dirs.includes(normalize(path)),
        readFile: (path) => files[normalize(path)],
      },
      checkoutRoot: root,
    }),
  };
  return renderFrameAdvice(command(["new-app", "<name>"], { at: "checkout-root" }), frame);
}

async function run(root: string): Promise<string | undefined> {
  let message: string | undefined;
  await withOutputSink(
    () => {},
    async () => {
      try {
        await initApp(root);
      } catch (error) {
        message = (error as Error).message;
      }
    },
  );
  return message;
}

/** A host can force colour on children (FORCE_COLOR), and console.log of a non-string is
 *  inspect-formatted, so a number arrives ANSI-wrapped; compare the value, not the wrapping. */
const plain = (output: string): string => stripVTControlCharacters(output).trim();

async function runNode(_root: string, file: string): Promise<{ code: number | null; output: string }> {
  const apps = await isolatedAppsRoot("init-node");
  try { return await runProcess(process.execPath, [file], { cwd: apps.root, timeoutMs: 60_000 }); }
  finally { await apps.dispose(); }
}

// mkdtemp's own random suffix mixes upper and lower case, which safeName (checked before
// anything else in initApp) rejects — a deterministic, compliant subdirectory name is used
// under the temp base instead, so the fixture is testing THIS check, not that one.

// --- an existing .env must refuse init, not be silently overwritten -----------------------

{
  const base = await mkdtemp(join(tmpdir(), "clawwright-init-check-"));
  const root = join(base, "deployment-env");
  await mkdir(root, { recursive: true });
  try {
    const envFile = resolve(root, ".env");
    const original = "MY_OWN_SETTING=do-not-touch-me\n";
    await writeFile(envFile, original, "utf8");

    const message = await run(root);
    check("init refuses when .env already exists", message?.includes(".env") && message.includes(ALREADY_EXISTS), true);
    check("the existing .env is left untouched", await readFile(envFile, "utf8"), original);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

// --- an existing config/desired-state.json must refuse init too ---------------------------

{
  const base = await mkdtemp(join(tmpdir(), "clawwright-init-check-"));
  const root = join(base, "deployment-desired");
  await mkdir(root, { recursive: true });
  try {
    await mkdir(resolve(root, "config"), { recursive: true });
    const desiredStateFile = resolve(root, "config", "desired-state.json");
    const original = '[{"path":"custom.setting","value":true}]\n';
    await writeFile(desiredStateFile, original, "utf8");

    const message = await run(root);
    check("init refuses when config/desired-state.json already exists", message?.includes("desired-state.json") && message.includes(ALREADY_EXISTS), true);
    check("the existing desired-state.json is left untouched", await readFile(desiredStateFile, "utf8"), original);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

// --- a genuinely fresh directory still initialises normally --------------------------------

{
  const base = await mkdtemp(join(tmpdir(), "clawwright-init-check-"));
  const root = join(base, "deployment-fresh");
  await mkdir(root, { recursive: true });
  try {
    const message = await run(root);
    check("a fresh directory initialises without refusing", message, undefined);
    check("app.ts was written", await readFile(resolve(root, "app.ts"), "utf8").then(() => true, () => false), true);
    const declared = await readFile(resolve(root, "app.ts"), "utf8");
    check("app.ts names the deployment after its directory", declared.includes('name: "deployment-fresh",'), true);
    check("and no longer hardcodes the name openclaw", declared.includes('name: "openclaw"'), false);
    check("desired-state.json was written",await readFile(resolve(root, "config", "desired-state.json"), "utf8").then(() => true, () => false), true);
    check(".env was written", await readFile(resolve(root, ".env"), "utf8").then(() => true, () => false), true);

    // The published image (2026.6.x) rejects the whole config write on an unknown key
    // ("Unrecognized key: \"telemetry\""), so a template key the image does not know breaks
    // every fresh bootstrap. The template holds only keys that image accepts.
    const desiredState = JSON.parse(await readFile(resolve(root, "config", "desired-state.json"), "utf8")) as { path: string; value: unknown }[];
    check(
      "a fresh deployment declares no telemetry key the published image rejects",
      desiredState.some((entry) => entry.path.startsWith("telemetry")),
      false,
    );

    // The shim invokes node with script_path as an ARGUMENT ("node dist/entry/bin.js"),
    // which bypasses bin.js's own shebang entirely — Node reads a shebang line only when the
    // OS resolves the file as an executable, not when it is handed a path to run. Without
    // the flag repeated here, a consumer that disables type stripping fails with "Unknown
    // file extension \".ts\"" when bin.js dynamically imports this deployment's app.ts.
    const shim = await readFile(resolve(root, "clawwright"), "utf8");
    check("the shim passes --experimental-strip-types when invoking node directly", shim.includes("--experimental-strip-types"), true);

    // Mirrors cli-help.check.ts's own assertion on scaffold.ts's new-app output: an
    // installed-mode deployment must keep the same machine-local state out of its history —
    // this used to be scaffold.ts-only (S10 added state/ and sets/ to that copy alone), so
    // an installed deployment's watch.json and built set archives got committed.
    const gitignoreLines = (await readFile(resolve(root, ".gitignore"), "utf8"))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    check("the deployment .gitignore excludes machine-local watch state", gitignoreLines.includes("state/"), true);
    check("and excludes built set artifacts", gitignoreLines.includes("sets/"), true);
    check("and still excludes the installed, unvendored package", gitignoreLines.includes("node_modules/"), true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

// --- init --local on an initialised directory prints the npm line and writes nothing -------

{
  const base = await mkdtemp(join(tmpdir(), "clawwright-init-check-"));
  const root = join(base, "deployment-local");
  await mkdir(root, { recursive: true });
  try {
    check("the first init succeeds", await run(root), undefined);
    const files = ["app.ts", ".env", ".gitignore", "package.json", "clawwright"];
    const before = await Promise.all(files.map((name) => readFile(resolve(root, name), "utf8")));

    let output = "";
    let message: string | undefined;
    await withOutputSink(
      (chunk) => { output += chunk; },
      async () => {
        try {
          await initApp(root, { local: true });
        } catch (error) {
          message = (error as Error).message;
        }
      },
    );
    check("init --local on an initialised directory does not refuse", message, undefined);
    check("it prints the no-save npm install line", output.includes(noSaveInstall("")), true);
    check("and writes nothing", await Promise.all(files.map((name) => readFile(resolve(root, name), "utf8"))), before);
    check("plain init on the same directory still refuses", (await run(root))?.includes(ALREADY_INITIALISED), true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

// --- .gitignore updates are per-line, idempotent, and never clobber what is already there --

{
  const lines = templateLines(true);

  const base = await mkdtemp(join(tmpdir(), "clawwright-init-check-"));
  try {
    // Running it twice is a no-op.
    const twice = join(base, "twice");
    await mkdir(twice, { recursive: true });
    await updateGitignore(twice, lines);
    const once = await readFile(resolve(twice, ".gitignore"), "utf8");
    await updateGitignore(twice, lines);
    check("running the gitignore update twice makes no further change", await readFile(resolve(twice, ".gitignore"), "utf8"), once);

    // An old block from before state/ and sets/ existed still gets the missing lines
    // appended, rather than being recognised as "already handled" and left alone forever —
    // the exact idempotency bug init.ts's own includes() heuristic had.
    const legacy = join(base, "legacy");
    await mkdir(legacy, { recursive: true });
    const oldBlock = "\n# @phpcraftdream/clawwright: installed, not vendored — the whole point of installing it as a\n# dependency instead of copying it in is that it never has to be committed.\nnode_modules/\n\n# OpenClaw deployment state — host paths, the gateway token, secrets and snapshots.\n.env\nsecrets/\n";
    await writeFile(resolve(legacy, ".gitignore"), oldBlock, "utf8");
    await updateGitignore(legacy, lines);
    const upgraded = (await readFile(resolve(legacy, ".gitignore"), "utf8")).split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
    check("an old block gains the state/ line it predates", upgraded.includes("state/"), true);
    check("an old block gains the sets/ line it predates", upgraded.includes("sets/"), true);
    check("an old block keeps its own .env line, not duplicated", upgraded.filter((line) => line === ".env").length, 1);
    check("an old block keeps its own secrets/ line, not duplicated", upgraded.filter((line) => line === "secrets/").length, 1);

    // The operator's own lines are neither removed nor reordered.
    const custom = join(base, "custom");
    await mkdir(custom, { recursive: true });
    await writeFile(resolve(custom, ".gitignore"), "*.local\ndist/\n", "utf8");
    await updateGitignore(custom, lines);
    const customLines = (await readFile(resolve(custom, ".gitignore"), "utf8")).split(/\r?\n/).map((line) => line.trim());
    check("a user's own ignore line survives the update", customLines.includes("*.local"), true);
    check("a user's own ignore line keeps its position", customLines.indexOf("*.local") < customLines.indexOf("state/"), true);

    // CRLF in, CRLF out — no mixed line endings from the append.
    const crlf = join(base, "crlf");
    await mkdir(crlf, { recursive: true });
    await writeFile(resolve(crlf, ".gitignore"), ".env\r\nsecrets/\r\n", "utf8");
    await updateGitignore(crlf, lines);
    const crlfContent = await readFile(resolve(crlf, ".gitignore"), "utf8");
    check("a CRLF .gitignore keeps CRLF endings after the update", crlfContent.includes("\r\n"), true);
    check("a CRLF .gitignore gains no bare LF", /(?<!\r)\n/.test(crlfContent), false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

// --- nextStepsLines: the shared "next:" block, pure ------------------------------------------

{
  const underSrv = nextStepsLines(".env", "/srv/openclaw/data", "./clawwright bootstrap");
  check("names the data directory the .env chose", underSrv.some((line) => line.includes("/srv/openclaw/data")), true);
  check("an /srv default gets the root-owned hint", underSrv.some((line) => line.includes(ROOT_OWNED)), true);
  check("...pointing at bootstrap --check", underSrv.some((line) => line.includes(commandLine(["bootstrap", "--check"]))), true);
  check("and bootstrap itself is still the final step", underSrv.at(-1), "  3. ./clawwright bootstrap");

  const elsewhere = nextStepsLines(".env", "/home/coder/openclaw-data", "./clawwright bootstrap");
  check("a data directory NOT under /srv gets no root-owned hint", elsewhere.some((line) => line.includes(ROOT_OWNED)), false);
  check("but still points at bootstrap --check as the next step", elsewhere.some((line) => line.includes(commandLine(["bootstrap", "--check"]))), true);

  check("isUnderSrv: the bare root counts", isUnderSrv("/srv"), true);
  check("isUnderSrv: a child path counts", isUnderSrv("/srv/openclaw/data"), true);
  check("isUnderSrv: a lookalike prefix does not", isUnderSrv("/srving/data"), false);
}

// --- and reaches init's own real output, naming the actual generated data directory ----------

{
  const base = await mkdtemp(join(tmpdir(), "clawwright-init-check-"));
  const root = join(base, "deployment-next-steps");
  await mkdir(root, { recursive: true });
  try {
    let output = "";
    await withOutputSink(
      (chunk) => { output += chunk; },
      () => initApp(root),
    );
    const env = await readFile(resolve(root, ".env"), "utf8");
    const dataDir = /^OC_DATA_DIR=(.*)$/m.exec(env)?.[1];
    check("a data directory was actually generated", typeof dataDir === "string" && dataDir !== "", true);
    check("init's own output names it", dataDir !== undefined && output.includes(dataDir), true);
    check("and points at bootstrap --check before bootstrap itself", output.includes(commandLine(["bootstrap", "--check"])), true);
    const checkStepIndex = output.indexOf("2. ./clawwright bootstrap --check");
    const bootstrapStepIndex = output.indexOf("3. ./clawwright bootstrap");
    check("bootstrap --check (step 2) is printed before plain bootstrap (step 3)", checkStepIndex !== -1 && bootstrapStepIndex !== -1 && checkStepIndex < bootstrapStepIndex, true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

// --- init avoids a port a sibling deployment beside it already claims (same idea as ---------
// --- scaffold.ts's new-app, checked in mcp-project.check.ts, applied to installed mode) -----

{
  const base = await mkdtemp(join(tmpdir(), "clawwright-init-check-"));
  try {
    const claimed = join(base, "sibling-claimed");
    await mkdir(claimed, { recursive: true });
    const candidate = projectPort(new Set(), 42);
    await writeFile(resolve(claimed, ".env"), `OPENCLAW_GATEWAY_PORT=${candidate}\n`, "utf8");

    const assignedEnv = await templateEnv("sibling-new", base, 42);
    const assigned = Number(/^OPENCLAW_GATEWAY_PORT=(\d+)$/m.exec(assignedEnv)?.[1]);
    check("init avoids a port a sibling deployment already recorded", assigned !== candidate, true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

// --- the deployment must be loadable as ESM afterwards -------------------------------------
//
// app.ts imports @phpcraftdream/clawwright, and Node decides how to read a .ts file from the
// nearest package.json's "type". Init must provide ESM for the generated declaration without
// changing how source files already in the directory are interpreted.

async function freshRoot(name: string): Promise<{ base: string; root: string }> {
  const base = await mkdtemp(join(tmpdir(), "clawwright-init-check-"));
  const root = join(base, name);
  await mkdir(root, { recursive: true });
  return { base, root };
}

/** An absent or unreadable package.json is an empty object here rather than a throw: these
 *  cases are about what is IN the file, and a missing one must read as a failed assertion in
 *  this file, not as a crash that takes the rest of the cases with it. */
async function packageJsonOf(root: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function gatewayPortOf(root: string): Promise<number> {
  const env = await readFile(resolve(root, ".env"), "utf8");
  return Number(/^OPENCLAW_GATEWAY_PORT=(\d+)$/m.exec(env)?.[1]);
}

{
  const base = await mkdtemp(join(tmpdir(), "clawwright-init-check-"));
  const first = join(base, "project-alpha");
  const second = join(base, "project-beta");
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  try {
    await run(first);
    await run(second);
    const firstPort = await gatewayPortOf(first);
    const secondPort = await gatewayPortOf(second);
    check("generated ports stay in the candidate range", firstPort >= 20000 && firstPort <= 32767 && secondPort >= 20000 && secondPort <= 32767, true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

{
  const { base, root } = await freshRoot("deployment-no-package");
  try {
    check("a directory without a package.json initialises", await run(root), undefined);
    const parsed = await packageJsonOf(root);
    check("and gets one that says it is a module", parsed.type, "module");
    check("marked private, because nothing here belongs on a registry", parsed.private, true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

{
  const { base, root } = await freshRoot("deployment-no-package-commonjs-code");
  try {
    const legacy = resolve(root, "legacy.js");
    await writeFile(legacy, "module.exports = { hello: 1 }; console.log(module.exports.hello);\n", "utf8");

    const before = await runNode(root, legacy);
    check("CommonJS code without package.json runs before init", before.code, 0);
    check("CommonJS code without package.json exports before init", plain(before.output), "1");

    const message = await run(root);
    const missingPackage = `package.json ${NOT_EXIST}`;
    check("init refuses existing code without package.json", message?.includes(missingPackage) && message.includes("legacy.js"), true);
    check("the refusal does not create package.json", await readFile(resolve(root, "package.json"), "utf8").then(() => true, () => false), false);
    check("the refusal does not create app.ts", await readFile(resolve(root, "app.ts"), "utf8").then(() => true, () => false), false);

    const after = await runNode(root, legacy);
    check("CommonJS code without package.json runs after refused init", after.code, 0);
    check("CommonJS code without package.json exports after refused init", plain(after.output), "1");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

{
  const { base, root } = await freshRoot("deployment-typeless");
  try {
    // What `npm install @phpcraftdream/clawwright` leaves behind in a repository that had a
    // package.json before the framework was added.
    await writeFile(
      resolve(root, "package.json"),
      `${JSON.stringify({ name: "consumer", version: "1.2.3", dependencies: { "@phpcraftdream/clawwright": "^0.1.0" } }, undefined, 2)}\n`,
      "utf8",
    );

    check("a package.json without a type initialises", await run(root), undefined);
    const parsed = await packageJsonOf(root);
    check("the type is filled in", parsed.type, "module");
    check("and nothing else in the file is lost", JSON.stringify([parsed.name, parsed.version, parsed.dependencies]), JSON.stringify(["consumer", "1.2.3", { "@phpcraftdream/clawwright": "^0.1.0" }]));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

{
  const { base, root } = await freshRoot("deployment-npm-init");
  try {
    // Exactly what `npm init -y` writes — including the "main" that names a file it did not
    // create. Nothing in the directory is read under that "type", so nobody chose it.
    await writeFile(
      resolve(root, "package.json"),
      `${JSON.stringify({ name: "consumer", version: "1.0.0", main: "index.js", type: "commonjs" }, undefined, 2)}\n`,
      "utf8",
    );

    check("a default `npm init -y` package initialises", await run(root), undefined);
    check("and its commonjs is replaced, because no file here depends on it", (await packageJsonOf(root)).type, "module");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

{
  const { base, root } = await freshRoot("deployment-commonjs-code");
  try {
    // Here the field IS load-bearing: flipping it would change how this file is read.
    const original = `${JSON.stringify({ name: "consumer", version: "1.0.0", main: "index.js", type: "commonjs" }, undefined, 2)}\n`;
    await writeFile(resolve(root, "package.json"), original, "utf8");
    await writeFile(resolve(root, "index.js"), "module.exports = { hello: 1 };\n", "utf8");

    const message = await run(root);
    check("a commonjs package with commonjs code in it is refused", message?.includes('"type": "commonjs"'), true);
    check("the refusal names the files that would change meaning", message?.includes("index.js"), true);
    check("and explains the ESM requirement", message?.includes(NEEDS_ESM), true);
    check("the operator's package.json is left exactly as it was", await readFile(resolve(root, "package.json"), "utf8"), original);
    // Refused whole: a directory the deployment cannot run in must not be left half-written.
    check("and nothing was written into the directory", await readFile(resolve(root, "app.ts"), "utf8").then(() => true, () => false), false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

{
  const { base, root } = await freshRoot("deployment-typeless-commonjs-code");
  try {
    const original = `${JSON.stringify({ name: "consumer", version: "1.0.0", main: "legacy.js" }, undefined, 2)}\n`;
    const legacy = resolve(root, "legacy.js");
    await writeFile(resolve(root, "package.json"), original, "utf8");
    await writeFile(legacy, "module.exports = { hello: 1 }; console.log(module.exports.hello);\n", "utf8");

    const before = await runNode(root, legacy);
    check("typeless CommonJS code runs before init", before.code, 0);
    check("typeless CommonJS code exports before init", plain(before.output), "1");

    const message = await run(root);
    check("init refuses typeless CommonJS code", message?.includes("does not declare a \"type\"") && message.includes("legacy.js"), true);
    check("the typeless package.json is left untouched", await readFile(resolve(root, "package.json"), "utf8"), original);
    check("the refusal does not create app.ts", await readFile(resolve(root, "app.ts"), "utf8").then(() => true, () => false), false);

    const after = await runNode(root, legacy);
    check("typeless CommonJS code runs after refused init", after.code, 0);
    check("typeless CommonJS code exports after refused init", plain(after.output), "1");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

{
  const { base, root } = await freshRoot("deployment-hidden-commonjs");
  try {
    const original = '{"name":"consumer"}\n';
    await writeFile(resolve(root, "package.json"), original);
    await mkdir(resolve(root, ".scripts"));
    const legacy = resolve(root, ".scripts", "setup.js");
    await writeFile(legacy, 'module.exports = "working"; console.log(module.exports);\n');
    check("hidden CommonJS script runs before init", (await runNode(root, legacy)).code, 0);
    const message = await run(root);
    check("init protects hidden CommonJS scripts", message?.includes("setup.js"), true);
    check("hidden scripts keep their package type", await readFile(resolve(root, "package.json"), "utf8"), original);
    check("hidden CommonJS script runs after refused init", (await runNode(root, legacy)).code, 0);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

{
  const { base, root } = await freshRoot("deployment-broken-package");
  try {
    await writeFile(resolve(root, "package.json"), "{ not json", "utf8");
    const message = await run(root);
    check("a package.json that does not parse is refused rather than guessed at", message?.includes(NOT_VALID_JSON), true);
    check("nothing is written in that case either", await readFile(resolve(root, "app.ts"), "utf8").then(() => true, () => false), false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

{
  const { base, root } = await freshRoot("deployment-already-module");
  try {
    const original = `${JSON.stringify({ name: "consumer", type: "module" }, undefined, 2)}\n`;
    await writeFile(resolve(root, "package.json"), original, "utf8");
    check("a package that already says module initialises", await run(root), undefined);
    check("and its package.json is not rewritten", await readFile(resolve(root, "package.json"), "utf8"), original);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

// --- a refused init names the checkout root's gate, wherever the run stood ------------------
//
// R6-5: the entry applies its invocation default before the placement decision, walked
// from the cwd, so a local-package (npx, node_modules/.bin) init that refuses is advised
// its own copy's spelling, never the bare global command. The refusal's sentence directs
// to the checkout root, so the advice row spells the gate from there for the copy this
// run is (rf6-fix30 re-roots it in the renderer), and the bash shim row follows only
// when it adds a spelling row 1 lacks.
// Spawned end to end: the running framework is the checkout's own copy, and the cwd sits in
// a SECOND checkout-shaped tree, so neither the running copy's spelling nor a cwd-relative
// path can sneak in (review R16-1).
{
  const base = await mkdtemp(join(tmpdir(), "clawwright-init-check-"));
  const fake = join(base, "checkout");
  const newDep = join(fake, "apps", "newdep");
  await mkdir(newDep, { recursive: true });
  await mkdir(resolve(fake, "tools"), { recursive: true });
  await mkdir(resolve(fake, "packages", "clawwright"), { recursive: true });
  await writeFile(resolve(fake, "packages", "clawwright", "package.json"), JSON.stringify({ name: "@phpcraftdream/clawwright" }), "utf8");
  await writeFile(resolve(fake, "tools", "clawwright.ts"), "// gate", "utf8");
  try {
    const refused = await new Promise<string>((resolvePromise) => {
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", resolve(monorepoRoot, "packages", "clawwright", "entry", "bin.ts"), "init"],
        { cwd: newDep, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      child.once("close", () => resolvePromise(output));
      child.once("error", () => resolvePromise(output));
    });
    // The sentence directs to the checkout root, so the row spells the gate from there —
    // the shim at its root — whatever the cwd, compared whole so neither the bare global
    // command nor a cwd-relative path can sneak in.
    const lines = plain(refused).split(String.fromCharCode(10)).map((line) => line.trim()).filter((line) => line.startsWith("→"));
    // The same rendering the refusal row gets: bin.ts's default frame classifies the
    // installed copy as the checkout's own shim (defaultLaunch's checkout-copy case), so
    // the re-rooted row spells the checkout's shim in the shim's POSIX-only shells. The
    // frame is built with the same host facts and a paste directory at the checkout root,
    // where the row pastes.
    const fromRoot = renderAdviceAtOwnRoot();
    // The checkout's own copy already spells the shim at the root, so the bash row is
    // dropped and the takeover note is the second line.
    check("init inside a checkout refuses with the checkout advice", lines.length, 2);
    check("...the refusal names the checkout root's gate, not the running copy's", lines[0]?.split("→ ")[1], fromRoot);
    check("the refusal names the checkout it walked up to", plain(refused).includes(fake), true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

// --- the same refusal, unit-level, from a nested subfolder ----------------------------------
//
// The refusal's rows must not depend on the cwd they refused from: bin.ts sets its
// invocation default from where the run stands (root.ts's checkout branch), and a
// clawwright-kind row is re-spelled with it — from a nested subfolder the first row used to
// read ../../../clawwright, which pasted at the checkout root resolves outside it (R17).
// Fake fs as in the golden entry matrix; no process.
{
  const fakeRoot = "/fake-checkout";
  const nested = `${fakeRoot}/deep/nested/sub`;
  const files: Record<string, string> = {
    [`${fakeRoot}/tools/clawwright.ts`]: "// gate",
    [`${fakeRoot}/packages/clawwright/package.json`]: JSON.stringify({ name: "@phpcraftdream/clawwright" }),
  };
  const dirs = [`${fakeRoot}/packages`, `${fakeRoot}/packages/clawwright`, nested];
  const normalize = (path: string): string => path.replaceAll("\\", "/").replace(/^[A-Za-z]:/, "");
  const fs: FsProbe = {
    exists: (path) => normalize(path) in files || dirs.includes(normalize(path)),
    isDirectory: (path) => dirs.includes(normalize(path)),
    readdir: () => [],
    readFile: (path) => files[normalize(path)],
    realpath: (path) => path,
  };
  // The frame bin.ts sets for this refusal, decided from the same roots (rf6-fix33: the
  // frame is the resolver's input now).
  const up = relative(resolve(nested), fakeRoot).split(sep).join("/");
  const decision = resolveInstalledEntry({ cwd: nested, rawArgv: ["init"], platform: "linux", fs, frame: frameFromInvocation({ program: `${up}/clawwright`, mode: "checkout", audience: "terminal" }, { host: "posix", msys: false }) });
  if (decision.kind !== "refuse") {
    check("init from a nested checkout folder is refused", decision.kind, "refuse");
  } else {
    // The frame bin.ts sets for this refusal, classified the way production classifies it:
    // launchFromHandover over the same fake fs (the program points at the checkout's gate,
    // the committed shim at the root the sentence names), not launchOf's spelling-only
    // rows — a shim launch carries the shim's POSIX-only shells, so the re-rooted row
    // spells without the bash note, like the spawned run above.
    const up = relative(resolve(nested), decision.checkout!).split(sep).join("/");
    const refusing: Invocation = { program: `${up}/clawwright`, mode: "checkout", audience: "terminal" };
    const frame = {
      ...frameFromInvocation(refusing, { host: "posix", msys: false }),
      launch: launchFromHandover(refusing, { cwd: nested, fs: { exists: fs.exists, readFile: fs.readFile }, checkoutRoot: decision.checkout }),
    };
    const [row] = decision.refusals[0]!.advice;
    const atRoot = renderAdviceAtOwnRoot();
    check("the row spells the gate from the checkout root the sentence names", renderFrameAdvice(row, frame, undefined, refusing.program), atRoot);
    checkTrue("the bash row is dropped when the re-rooted row 1 already is the shim", decision.refusals[0]!.advice.length === 1);
    checkTrue("no row spells a path out of the checkout root", !renderFrameAdvice(row, frame, undefined, refusing.program).includes(".."));
  }
}

finish("init");

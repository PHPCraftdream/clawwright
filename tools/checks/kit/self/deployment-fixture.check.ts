// Self-test for the shared deployment fixture and the sweep stage tally: a valid deployment
// the sweeps can select, a recording transport that never answers, and tally accounting that
// treats a SetupError as a failure rather than a refusal stage. The failing-tally scenarios
// run in child scripts — a harness failure in this process would corrupt this file's own exit
// code, and each child reports its tally as its final stdout line.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { check, checkTrue, finish } from "../harness.ts";
import { runProcess } from "../spawn.ts";
import {
  FIXTURE_TEMP_PREFIX,
  FIXTURE_TRANSPORT_DESCRIPTION,
  SetupError,
  TRANSPORT_SENTINEL,
  createDeploymentFixture,
  validateFixtureDeployment,
} from "../deployment-fixture.ts";
import { clearDeployment, selectedDeployment, useDeployment } from "#framework/runtime/deployment.ts";
import { monorepoRoot, parseEnv } from "#framework/core/env.ts";

// The OS temp dir is shared with the rest of the suite — sibling check files create their own
// clawwright-deployment-fixture-* fixtures concurrently, so entries beyond this test's own
// fixture roots cannot be attributed here; the exact no-new-entries proof lives in the
// injected root's PRIVATE parent listing, which stays a strict deep-equal.
async function prefixedTempEntries(): Promise<string[]> {
  const entries = await readdir(tmpdir());
  return entries.filter((name) => name.slice(0, FIXTURE_TEMP_PREFIX.length) === FIXTURE_TEMP_PREFIX);
}

// The runner's own telemetry file (.check-timings.json) appears at the repository root during
// a run and is not a checkout change. git's --ignored=matching pass emits an outermost ignored
// directory as one bare marker line — observed: :(exclude) pathspecs do not prune it, and
// everything inside it collapses into that one line — so a marker line carries no file
// evidence; only markers and the telemetry file are filtered, every file-level line compares,
// and the repo-root readdir comparison keeps checkout apps/ visible so an escaped fixture is
// still detected.
const CONCURRENT_ROOT_ENTRIES = new Set([".check-timings.json"]);
function visibleRootEntries(entries: readonly string[]): string[] {
  return entries.filter((name) => !CONCURRENT_ROOT_ENTRIES.has(name));
}
function visibleGitStatus(text: string): string {
  return text.split("\n").filter((line) => {
    const path = line.slice(3);
    return !CONCURRENT_ROOT_ENTRIES.has(path) && !path.endsWith("/");
  }).join("\n");
}

const fixtureUrl = pathToFileURL(resolve(import.meta.dirname, "..", "deployment-fixture.ts")).href;

// --- checkout cleanliness: git must see nothing before and after the whole fixture cycle ------

const repoRoot = monorepoRoot;
const cwdValueBefore = process.cwd();
const cwdListBefore = visibleRootEntries(await readdir(cwdValueBefore));
// Git's ignored pass collapses an existing ignored apps/ into one marker line, so the
// checkout's apps/ contents are compared directly, as the runner's own guard does.
const checkoutApps = join(monorepoRoot, "apps");
const checkoutAppsEntries = async (): Promise<string[]> =>
  (await readdir(checkoutApps, { recursive: true }).catch(() => [] as string[])).map(String).sort();
const appsBefore = await checkoutAppsEntries();
// The pathspec excludes prune the tracked pass cheaply; the ignored pass keeps its bare directory markers, which visibleGitStatus filters.
const gitArgs = ["status", "--porcelain", "--ignored=matching", "--", ":(exclude)apps", ":(exclude)node_modules", ":(exclude)worktrees", ":(exclude)packages/clawwright/dist"];
const gitBefore = await runProcess("git", gitArgs, { cwd: repoRoot });
// git may be absent in a bare environment: that skips the comparison, never fails the suite.
const gitAvailable = gitBefore.code === 0 && gitBefore.error === undefined;
if (gitAvailable) checkTrue("git status runs in the checkout before any fixture exists", true);

// --- createDeploymentFixture: the written deployment is valid and self-contained -------------

const fixture = await createDeploymentFixture();
const tempDuring = await prefixedTempEntries();
check("the default fixture's root appears in the OS temp listing", tempDuring.includes(basename(fixture.root)), true);
check("the fixture root is a directory under the OS temp dir", fixture.root.startsWith(tmpdir()), true);
checkTrue("the fixture's .env parses and carries all four keys", (() => {
  const env = parseEnv(readFileSync(join(fixture.root, ".env"), "utf8"));
  return (
    env.OC_TARGET_LOCATION === "local" &&
    env.OC_DATA_DIR === join(fixture.root, "data") &&
    env.OPENCLAW_GATEWAY_PORT === "18799" &&
    env.OPENCLAW_GATEWAY_TOKEN === "not-a-real-token-check-only-value"
  );
})());
checkTrue("every fixture file lives inside the root by construction", (() => {
  const inside = [
    "app.ts",
    join("config", "desired-state.json"),
    join("recipes", "local", "recipe.json"),
    join("recipes", "local", "acceptance.json"),
    join("recipes", "local", "agent", "config.json"),
  ];
  return inside.every((file) => existsSync(join(fixture.root, file)));
})());
checkTrue("validateFixtureDeployment accepts the fixture it just built", (() => {
  try {
    validateFixtureDeployment(fixture.root);
    return true;
  } catch {
    return false;
  }
})());

// The declaration imports the checkout's modules by absolute file URL (a temp root has no
// "#framework" mapping), so this dynamic import resolves to the very same module instances
// this check already loaded through the #framework package imports.
{
  const declaration = await import(pathToFileURL(join(fixture.root, "app.ts")).href);
  checkTrue("the fixture's app declaration loads and defines commands", declaration.default.name === "fixture" && declaration.default.service?.name === "gateway" && Object.keys(declaration.default.commands ?? {}).length > 0);
}

// The .env under the selected fixture root must build a real Settings/context independently.
{
  const { createContext } = await import("#framework/core/context.ts");
  const ctx = await createContext({ transport: fixture.transport() });
  check("the fixture's .env builds a local Settings with the fixture data dir", [ctx.settings.location, ctx.settings.dataDir], ["local", join(fixture.root, "data")]);
  check("contacts() is empty after the context build consumed no transport calls", fixture.contacts(), []);
}
check("contacts() is empty before any transport use", fixture.contacts(), []);

// --- recording transport: logs, throws the sentinel, clears per case --------------------------

{
  const transport = fixture.transport();
  // Data answers without contact: a product read of `description` must see a string.
  check("the recording transport's description is the fixture's", transport.description, FIXTURE_TRANSPORT_DESCRIPTION);
  check("the description is a string", typeof transport.description, "string");
  check("reading the description records no contact", fixture.contacts(), []);
  check("the transport is no thenable", (transport as any).then, undefined);
  check("probing then records no contact", fixture.contacts(), []);
  let thrown = "";
  try {
    await transport.exec("ls", ["-la"]);
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
  }
  check("the recording transport throws the sentinel, never answers", thrown, TRANSPORT_SENTINEL);
  check("the contact log records the method and its args in order", (fixture.contacts()[0] ?? "").split(" "), ["exec", "ls", "-la"]);
  // contacts() must hand out a snapshot: an outcome captured earlier keeps its evidence even
  // after the next transport() clears the live log for the following case.
  const first = fixture.contacts();
  fixture.transport();
  check("a second transport() clears the log for the next case", fixture.contacts(), []);
  check("an outcome captured earlier keeps its contact snapshot", (first[0] ?? "").split(" "), ["exec", "ls", "-la"]);
}

// --- isolation: dispose removes the root and restores the selection ---------------------------

await writeFile(join(fixture.root, "sentinel.txt"), "fixture", "utf8");
await fixture.dispose();
check("after dispose() the root is gone", await stat(fixture.root).then(() => false, () => true), true);
const tempAfter = await prefixedTempEntries();
check("the default fixture's root is gone from the OS temp listing after dispose", tempAfter.includes(basename(fixture.root)), false);

// The tally-failure scenarios run as child scripts, so a FAIL here cannot poison this suite.

interface Ran {
  readonly code: number | null;
  readonly stdout: string;
}

async function runScript(dir: string, source: string): Promise<Ran> {
  const file = join(dir, `${Math.random().toString(36).slice(2)}.ts`);
  await writeFile(
    file,
    `import { checkTrue, finish } from "${pathToFileURL(resolve(import.meta.dirname, "..", "harness.ts")).href}";\n` +
      `import { SetupError, stageTally } from "${fixtureUrl}";\n${source}` +
      // the structured report is appended to every child, so parsing needs no marker in the source
      `;\nprocess.stdout.write(JSON.stringify({ cases: tally.cases, counts: tally.counts(), shortfalls: tally.shortfalls() }) + String.fromCharCode(10));`,
  );
  const { code, stdout } = await runProcess(process.execPath, ["--experimental-strip-types", file]);
  return { code, stdout };
}

interface ChildResult {
  readonly cases: number;
  readonly counts: ReadonlyArray<{ readonly stage: string; readonly count: number }>;
  readonly shortfalls: ReadonlyArray<{ readonly label: string; readonly stage?: string; readonly reason?: string }>;
}

function resultOf(lineSource: string): ChildResult | undefined {
  // Parses the child's final stdout line — the tally report the appended writer emits.
  const line = lineSource.trimEnd().split("\n").at(-1) ?? "";
  try {
    return JSON.parse(line) as ChildResult;
  } catch {
    return undefined;
  }
};

const childDir = await mkdtemp(join(tmpdir(), "clawwright-fixture-check-"));
try {
  const control = await runScript(
    childDir,
    [
      `const tally = stageTally();`,
      `tally.control("demo control", "prepare");`,
      `tally.print("tally-demo");`,
      `finish("tally-demo");`,
    ].join("\n"),
  );
  const parsed = resultOf(control.stdout);
  checkTrue("the child scenario reports its tally as its final stdout line", parsed !== undefined);
  if (parsed !== undefined) {
    check("a control short of run counts one prepare stage", parsed.counts, [{ stage: "prepare", count: 1 }]);
    check("a control short of run counts one case", parsed.cases, 1);
    // JSON.stringify drops the undefined reason, so the shortfall is exactly label + stage.
    check("a control short of run is a shortfall with no reason", parsed.shortfalls, [{ label: "demo control", stage: "prepare" }]);
  }
  check("a failing control sets a non-zero exit code", control.code === 0, false);

  const setupError = await runScript(
    childDir,
    [
      `const tally = stageTally();`,
      `tally.case("demo case", "context", new SetupError("x"));`,
      `tally.print("tally-demo");`,
      `finish("tally-demo");`,
    ].join("\n"),
  );
  const setupParsed = resultOf(setupError.stdout);
  checkTrue("the SetupError scenario reports its tally as its final stdout line", setupParsed !== undefined);
  if (setupParsed !== undefined) {
    // A setup error is never a refusal stage and never a shortfall.
    check("a SetupError case counts no stages", setupParsed.counts, []);
    check("a SetupError case counts no cases", setupParsed.cases, 0);
    check("a SetupError case is never a shortfall", setupParsed.shortfalls, []);
  }
  check("a SetupError case sets a non-zero exit code", setupError.code === 0, false);

  const passThrough = await runScript(
    childDir,
    [
      `const tally = stageTally();`,
      `tally.case("demo case", "parse");`,
      `tally.case("demo case", "run");`,
      `tally.control("demo control", "run");`,
      `tally.control("demo excepted control", "prepare", { expect: "prepare", reason: "documented exception for the self-test" });`,
      `checkTrue("the tally counts every case and control", tally.cases === 4);`,
      `tally.print("tally-demo");`,
      `finish("tally-demo");`,
    ].join("\n"),
  );
  const passParsed = resultOf(passThrough.stdout);
  checkTrue("the pass-through scenario reports its tally as its final stdout line", passParsed !== undefined);
  if (passParsed !== undefined) {
    check("a passing tally counts its stages in pipeline order", passParsed.counts, [
      { stage: "parse", count: 1 },
      { stage: "prepare", count: 1 },
      { stage: "run", count: 2 },
    ]);
    check("a passing tally counts every case and control", passParsed.cases, 4);
    check("a documented expect !== run records the reason", passParsed.shortfalls, [
      { label: "demo excepted control", stage: "prepare", reason: "documented exception for the self-test" },
    ]);
  }
  check("a passing tally keeps the exit code clean", passThrough.code, 0);

  const excused = await runScript(
    childDir,
    [
      `const tally = stageTally();`,
      `tally.excused("demo excused control", "owns stdio");`,
      `tally.print("tally-demo");`,
      `finish("tally-demo");`,
    ].join("\n"),
  );
  const excusedParsed = resultOf(excused.stdout);
  checkTrue("the excused scenario reports its tally as its final stdout line", excusedParsed !== undefined);
  if (excusedParsed !== undefined) {
    // An excuse is explicit and counted as a shortfall entry, not a failure: no stage, no case.
    check("an excused control counts no stages", excusedParsed.counts, []);
    check("an excused control counts no cases", excusedParsed.cases, 0);
    check("an excused control is a shortfall entry with only label and reason", excusedParsed.shortfalls, [
      { label: "demo excused control", reason: "owns stdio" },
    ]);
  }
  check("an excused control keeps the exit code clean", excused.code, 0);

  // --- injectable root: handed over, contained, and removed on dispose too ---------------------

  // The parent itself is this test's scratch and must not outlive the assertion.
  const parent = await mkdtemp(join(tmpdir(), "clawwright-fixture-parent-"));
  try {
    const before = await readdir(parent);
    const injected = await createDeploymentFixture({ root: join(parent, "dep") });
    check("an injected root is used verbatim", injected.root === join(parent, "dep"), true);
    await injected.dispose();
    const after = await readdir(parent);
    check("a disposed fixture leaves no sibling beside the injected root", after, before);
    check("an injected root is removed on dispose too", await stat(injected.root).then(() => false, () => true), true);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }

  // --- SetupError: validate names the first missing thing -------------------------------------

  const broken = await mkdtemp(join(tmpdir(), "clawwright-broken-fixture-"));
  await mkdir(join(broken, "recipes", "local", "agent"), { recursive: true });
  let missingEnv = "";
  try {
    validateFixtureDeployment(broken);
  } catch (error) {
    if (error instanceof SetupError) missingEnv = error.message;
  }
  checkTrue("a missing .env throws SetupError naming it", missingEnv.includes(".env"));

  await writeFile(join(broken, ".env"), ["OC_TARGET_LOCATION=local", "OC_DATA_DIR=", "OPENCLAW_GATEWAY_PORT=18799", "OPENCLAW_GATEWAY_TOKEN=x", ""].join("\n"), "utf8");
  let emptyValue = "";
  try {
    validateFixtureDeployment(broken);
  } catch (error) {
    if (error instanceof SetupError) emptyValue = error.message;
  }
  checkTrue("an empty OC_DATA_DIR value throws SetupError naming the key", emptyValue.includes("OC_DATA_DIR"));
  await rm(broken, { recursive: true, force: true });
} finally {
  await rm(childDir, { recursive: true, force: true });
}

// --- lifecycle: selection restore, clear, and partial-failure cleanup -------------------------

// A previous selection is in-memory state, so a plain temp path stands in for a deployment.
useDeployment(join(tmpdir(), "selection-sentinel-a"));
const withPrevious = await createDeploymentFixture();
check("a fixture with a previous deployment selects its own root", selectedDeployment(), withPrevious.root);
await withPrevious.dispose();
check("disposing restores the previous selection", selectedDeployment(), join(tmpdir(), "selection-sentinel-a"));

clearDeployment();
const withoutPrevious = await createDeploymentFixture();
await withoutPrevious.dispose();
check("disposing with no previous selection clears the selection", selectedDeployment(), undefined);

// A failing setup must remove the fixture-created root and leave the selection untouched.
clearDeployment();
useDeployment(join(tmpdir(), "selection-sentinel-b"));
let failedRoot = "";
let thrown = "";
try {
  await createDeploymentFixture({
    validate: (root) => {
      failedRoot = root;
      throw new SetupError(`injected failure under ${root}`);
    },
  });
} catch (error) {
  thrown = error instanceof Error ? error.message : String(error);
}
checkTrue("a failing setup rejects", thrown !== "");
check("the rejection is the injected SetupError", thrown.split(" ").slice(0, 2), ["injected", "failure"]);
check("a failed setup removes the fixture-created root", (await prefixedTempEntries()).includes(basename(failedRoot)), false);
check("a failed setup leaves the previous selection untouched", selectedDeployment(), join(tmpdir(), "selection-sentinel-b"));

// A failing setup on a caller-injected root must never remove that root: pre-place a file
// where the fixture's recursive mkdir expects a directory, so the setup fails with ENOTDIR.
clearDeployment();
useDeployment(join(tmpdir(), "selection-sentinel-b"));
const parent2 = await mkdtemp(join(tmpdir(), "clawwright-fixture-parent-"));
try {
  await writeFile(join(parent2, "dep"), "not a directory");
  let injectedThrown = "";
  try {
    await createDeploymentFixture({ root: join(parent2, "dep") });
  } catch (error) {
    injectedThrown = error instanceof Error ? error.message : String(error);
  }
  checkTrue("a failing setup on an injected root rejects", injectedThrown !== "");
  check("a failed setup never removes a caller-injected root", existsSync(join(parent2, "dep")), true);
  check("a failed setup on an injected root leaves the previous selection untouched", selectedDeployment(), join(tmpdir(), "selection-sentinel-b"));
} finally {
  await rm(parent2, { recursive: true, force: true });
}

// --- checkout cleanliness, second half: the whole cycle left the checkout untouched ------------

if (gitAvailable) {
  const gitAfter = await runProcess("git", gitArgs, { cwd: repoRoot });
  checkTrue("the after-cycle git status exits cleanly", gitAfter.code === 0);
  check("the fixture cycle leaves the checkout clean", visibleGitStatus(gitAfter.stdout), visibleGitStatus(gitBefore.stdout));
} else {
  // git was unavailable: the comparison is skipped rather than failing the suite.
  checkTrue("the fixture cycle leaves the checkout clean (git unavailable, skipped)", true);
}

check("the fixture cycle leaves the checkout's apps/ contents untouched", await checkoutAppsEntries(), appsBefore);

// readdir of the repo root is stable: nothing in the suite writes the repository root.
const cwdValueAfter = process.cwd();
check("the check's working directory never changed", [cwdValueAfter, visibleRootEntries(await readdir(cwdValueAfter))], [cwdValueBefore, cwdListBefore]);

finish("deployment fixture");

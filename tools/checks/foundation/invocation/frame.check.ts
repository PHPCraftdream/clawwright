// The frame unit check (stage 7, S1.2a; design §3): frame.ts's constructors and transitions
// against literal expectations — the toCheckoutRoot table by launch kind × paste directory ×
// platform, the spell table (§2.2), idempotence, the pasteShells invariant, and the
// hand-over round-trip over the producer registry (golden/frames.ts) with the O7 fixture
// generations. Every expected value is an independent literal; producer records come from
// the registry, whose frames are built by the real constructors.

import { resolve, sep } from "node:path";
import { command } from "#framework/core/io/invocation/advice.ts";
import {
  INVOCATION_ENV,
  INVOKED_AS_ENV,
  parseInvocation,
  parseLegacyInvokedAs,
} from "#framework/core/io/invocation/index.ts";
import {
  checkoutGateFrame,
  defaultLaunch,
  forShell,
  handoverOf,
  launchFromHandover,
  launchOf,
  pasteShells,
  rel,
  spell,
  toCheckoutRoot,
  WINDOWS_BIN_PROGRAM,
  type HandoverFacts,
  type Frame,
  type HostPlatform,
  type Launch,
} from "#framework/core/io/invocation/frame.ts";
import { renderAdvice, renderFrameAdvice, SHIM_PROGRAM } from "#framework/core/io/invocation/render.ts";
import { mcpLauncherContent } from "#framework/integration/mcp/project.ts";
import { FRAME_PRODUCERS, producer } from "#checks/golden/frames.ts";
import { tokenizeLine } from "#checks/surfaces/advice/shells.ts";
import { check, checkTrue, finish, requires } from "#checks/kit/harness.ts";

const ROOT = "/clawwright-checkout";
const DOCS = `${ROOT}/docs`;
const DEMO = `${ROOT}/apps/demo`;
const APP_LOCAL = "/home/u/app-local";
const SPACE = "\u0020";

/** A rendered line as tokens: the renderer joins with single spaces and puts a double
 *  space before a note, so the split keeps the note as its own empty-separator cell. */
const words = (line: string): readonly string[] => line.split(SPACE);

// --- the file-facts adapter's fake fs -------------------------------------------------------------

/** A second checkout gate, beside the fake layout's own ROOT, for the adapter's rows. */
const GATE = "/co";

/** The fake fs the adapter classifies over: a checkout gate at GATE (tools/clawwright.ts
 *  beside a packages/clawwright/package.json naming the framework) and app.ts beside the local
 *  deployment — nothing else exists. Paths are compared normalized, so the facts are the
 *  same on either platform's resolve(). The narrowed probe shape (exists/readFile) keeps
 *  frame.ts free of any import of the resolver. */
const GATE_FILES = [`${GATE}/tools/clawwright.ts`, `${GATE}/packages/clawwright/package.json`, `${ROOT}/tools/clawwright.ts`, `${ROOT}/packages/clawwright/package.json`];
const APP_FILES = [`${APP_LOCAL}/app.ts`];
const key = (path: string): string => resolve(path).split(sep).join("/");
const existsIn = (paths: readonly string[]): ((path: string) => boolean) => (path) => paths.some((entry) => key(entry) === key(path));
const FS = {
  exists: (path: string): boolean => existsIn(GATE_FILES)(path) || existsIn(APP_FILES)(path),
  readFile: (path: string): string | undefined =>
    key(path).endsWith("package.json") && existsIn(GATE_FILES)(path) ? '{"name":"@phpcraftdream/clawwright"}' : undefined,
};
const facts = (cwd: string, checkoutRoot: string | undefined = ROOT): HandoverFacts =>
  checkoutRoot === undefined ? { cwd, fs: FS } : { cwd, fs: FS, checkoutRoot };
/** The fake layout's absolute paths as the host's resolve spells them — the adapter's roots
 *  are what resolve() made of the facts, so the expectations spell them the same way (on a
 *  POSIX host this is exactly "/co" and "/home/u/app-local"). */
const norm = (path: string): string => resolve(path);

/** A frame of a given launch at a given paste directory, its shells from the real
 *  pasteShells constructor. Local assembly — frame.ts has no Frame-from-Launch constructor
 *  (reported): the only decision in it, the shell set, is still the constructor's. */
function frameWith(launch: Launch, host: HostPlatform, cwd: string, places: { checkoutRoot?: string } = { checkoutRoot: ROOT }): Frame {
  const hostValue = { kind: "operator" as const, platform: host };
  return {
    launch,
    host: hostValue,
    shells: pasteShells(launch, hostValue, false),
    cwd: { kind: "dir", path: cwd },
    places,
    app: { state: "none" },
    audience: "terminal",
  };
}

// The five launch kinds, each from a real constructor, with real roots on the fake layout.
const SYSTEM = defaultLaunch({ source: "global" });
const SHIM = defaultLaunch({ source: "checkout-copy", root: ROOT });
const DEPLOYMENT = defaultLaunch({ source: "local-package", appRoot: APP_LOCAL, host: "posix" });
const BIN = defaultLaunch({ source: "local-package", appRoot: APP_LOCAL, host: "win32" });
const WINDOWS_BIN_SPELLING = ["node_modules", ".bin", "clawwright"].join("\\");
// Narrowed roots for the literal expectations below (defaultLaunch's union).
if (DEPLOYMENT.kind !== "deployment-shim" || BIN.kind !== "npm-bin") throw new Error("defaultLaunch misclassified the local-package cases");
const VERBATIM = launchOf({ program: "cw", mode: "installed", audience: "terminal" });
check("launchOf reads the committed shim's own spelling as the bash shim", launchOf({ program: SHIM_PROGRAM, mode: "checkout", audience: "terminal" }).kind, "checkout-shim");
check("launchOf keeps a Windows bin spelling out of the verbatim launch", launchOf({ program: WINDOWS_BIN_PROGRAM, mode: "local-package", audience: "terminal" }).kind, "npm-bin");
const LAUNCHES: readonly { readonly label: string; readonly launch: Launch }[] = [
  { label: "system", launch: SYSTEM },
  { label: "checkout-shim", launch: SHIM },
  { label: "deployment-shim", launch: DEPLOYMENT },
  { label: "npm-bin", launch: BIN },
  { label: "verbatim", launch: VERBATIM },
];
const CWDS: readonly string[] = [ROOT, DOCS, DEMO];
const HOSTS: readonly HostPlatform[] = ["posix", "win32"];

// --- toCheckoutRoot: the re-rooting table ----------------------------------------------------------

for (const { label, launch } of LAUNCHES) {
  for (const cwd of CWDS) {
    for (const host of HOSTS) {
      const place = frameWith(launch, host, cwd);
      const rooted = toCheckoutRoot(place);
      const expected = launch.kind === "system"
        ? { launch: { kind: "system" } as Launch, cwd: { kind: "dir", path: ROOT } }
        : { launch: { kind: "checkout-shim", root: ROOT } as Launch, cwd: { kind: "dir", path: ROOT } };
      checkTrue(`toCheckoutRoot re-roots ${label} from ${cwd} (${host}) to the checkout shim (D1)`, JSON.stringify({ launch: rooted.launch, cwd: rooted.cwd }) === JSON.stringify(expected));
      checkTrue(`toCheckoutRoot keeps the shells of ${label} from ${cwd} (${host})`, rooted.shells === place.shells);
    }
  }
}

for (const { label, launch } of LAUNCHES) {
  const cwdFrame: Frame = { ...frameWith(launch, "posix", DEMO), app: { state: "selected", name: "demo", by: "cwd" } };
  check(`toCheckoutRoot turns the cwd fact into a flag: ${label}`, toCheckoutRoot(cwdFrame).app, { state: "selected", name: "demo", by: "flag" });
}

const placeless = frameWith(SHIM, "posix", DOCS, {});
checkTrue("toCheckoutRoot without a checkout-root place is the identity", toCheckoutRoot(placeless) === placeless);

await requires("windows-host", "the checkout-root row of npm's Windows wrapper", () => {
  check(
    "npm-bin win32 at the checkout root spells the shim with the bash note (D1, O1)",
    words(renderAdvice(command(["new-app", "<name>"], { at: "checkout-root" }), { program: WINDOWS_BIN_PROGRAM, mode: "local-package", audience: "terminal" })),
    ["./clawwright", "new-app", "<name>", "", "(in", "bash)"],
  );
});
await requires("posix-host", "the checkout-root rows of the POSIX frames", () => {
  check(
    "npm-bin posix at the checkout root spells the shim",
    words(renderAdvice(command(["new-app", "<name>"], { at: "checkout-root" }), { program: "node_modules/.bin/clawwright", mode: "local-package", audience: "terminal" })),
    ["./clawwright", "new-app", "<name>"],
  );
  check(
    "system at the checkout root keeps the bare command",
    words(renderAdvice(command(["new-app", "<name>"], { at: "checkout-root" }), { program: "clawwright", mode: "installed", audience: "terminal" })),
    ["clawwright", "new-app", "<name>"],
  );
});

// --- idempotence and forShell over every producer ---------------------------------------------------

for (const p of FRAME_PRODUCERS) {
  const once = toCheckoutRoot(p.frame);
  checkTrue(`toCheckoutRoot is idempotent: ${p.label}`, JSON.stringify(toCheckoutRoot(once)) === JSON.stringify(once));
  for (const shell of ["posix", "cmd", "pwsh"] as const) {
    const shelled = forShell(p.frame, shell);
    checkTrue(`forShell keeps the app fact: ${p.label} (${shell})`, shelled.app === p.frame.app);
    checkTrue(`forShell keeps the places: ${p.label} (${shell})`, shelled.places === p.frame.places);
    checkTrue(`forShell narrows the shells to one: ${p.label} (${shell})`, shelled.shells.length === 1 && shelled.shells[0] === shell);
  }
}

// --- the {install completion pwsh} rows -------------------------------------------------------------

await requires("windows-host", "the install rows under the Windows shells", () => {
  check(
    "the checkout-shim install row under a Windows frame spells the shim with the bash note (D6/O1: the pwsh shell has no shim spelling)",
    words(renderAdvice(command(["completion", "pwsh"], { shell: "pwsh" }), { program: SHIM_PROGRAM, mode: "checkout", audience: "terminal" })),
    ["./clawwright", "completion", "pwsh", "", "(in", "bash)"],
  );
  check(
    "the npm-bin install row keeps the wrapper's backslashes under the pwsh shell it names (S1.4)",
    words(renderAdvice(command(["completion", "pwsh"], { shell: "pwsh" }), { program: WINDOWS_BIN_PROGRAM, mode: "local-package", audience: "terminal" })),
    ["node_modules\\.bin\\clawwright", "completion", "pwsh"],
  );
});
await requires("posix-host", "the install row under the POSIX frame", () => {
  check(
    "the npm-bin install row keeps the posix spelling with the bash note (D6/O1: pwsh has no posix wrapper)",
    words(renderAdvice(command(["completion", "pwsh"], { shell: "pwsh" }), { program: "node_modules/.bin/clawwright", mode: "local-package", audience: "terminal" })),
    ["node_modules/.bin/clawwright", "completion", "pwsh", "", "(in", "bash)"],
  );
});

// --- the spell table (design §2.2) -------------------------------------------------------------------

for (const [shell, host] of [["posix", "posix"], ["cmd", "win32"], ["pwsh", "posix"], ["pwsh", "win32"]] as const) {
  check(`spell system ${shell} on ${host}`, spell(SYSTEM, shell, host, undefined), "clawwright");
}
check("spell checkout-shim posix (root itself)", spell(SHIM, "posix", "posix", ROOT), "./clawwright");
check("spell checkout-shim posix (from apps/demo)", spell(SHIM, "posix", "posix", DEMO), "../../clawwright");
check("spell checkout-shim posix (from docs)", spell(SHIM, "posix", "posix", DOCS), "../clawwright");
check("spell checkout-shim posix (no paste directory)", spell(SHIM, "posix", "posix", undefined), "./clawwright");
check("spell checkout-shim cmd is not spelled", spell(SHIM, "cmd", "win32", undefined), undefined);
check("spell checkout-shim pwsh on win32 is not spelled", spell(SHIM, "pwsh", "win32", undefined), undefined);
// S1.4 note: design §2.2 spells shims for pwsh on a POSIX host "as posix"; the product
// spells them for POSIX shells only (a shim is a bash script) and leaves pwsh to the
// renderer's fallback. The CURRENT table is pinned; the renderer owns the difference.
check("spell checkout-shim pwsh on posix is not spelled (product; design table says as posix)", spell(SHIM, "pwsh", "posix", undefined), undefined);
check("defaultLaunch classifies a posix local package as the deployment shim", { kind: DEPLOYMENT.kind, root: DEPLOYMENT.root }, { kind: "deployment-shim", root: APP_LOCAL });
check("spell deployment-shim posix (root itself)", spell(DEPLOYMENT, "posix", "posix", APP_LOCAL), "./clawwright");
check("spell deployment-shim cmd is not spelled", spell(DEPLOYMENT, "cmd", "win32", undefined), undefined);
check("spell deployment-shim pwsh on win32 is not spelled", spell(DEPLOYMENT, "pwsh", "win32", undefined), undefined);
check("defaultLaunch classifies a win32 local package as npm's wrapper", { kind: BIN.kind, root: BIN.root }, { kind: "npm-bin", root: APP_LOCAL });

check("spell npm-bin posix (no paste directory)", spell(BIN, "posix", "win32", undefined), "node_modules/.bin/clawwright");
check("spell npm-bin posix (root itself)", spell(BIN, "posix", "win32", APP_LOCAL), "node_modules/.bin/clawwright");
check("spell npm-bin cmd (no paste directory)", spell(BIN, "cmd", "win32", undefined), WINDOWS_BIN_SPELLING);
check("spell npm-bin cmd (root itself)", spell(BIN, "cmd", "win32", APP_LOCAL), WINDOWS_BIN_SPELLING);
check("spell npm-bin pwsh on posix is not spelled", spell(BIN, "pwsh", "posix", undefined), undefined);
check("spell npm-bin pwsh on win32 spells like cmd", spell(BIN, "pwsh", "win32", APP_LOCAL), WINDOWS_BIN_SPELLING);
check("launchOf reads a bare word as the verbatim launch", { kind: VERBATIM.kind }, { kind: "verbatim" });
for (const [shell, host] of [["posix", "posix"], ["cmd", "win32"], ["pwsh", "win32"]] as const) {
  check(`spell verbatim ${shell} on ${host} prints the program as typed`, spell(VERBATIM, shell, host, undefined), "cw");
}

// --- rel: the relative-spelling table (S1.2b, O4) ----------------------------------------------------

check("rel at the root", rel(ROOT, ROOT, "posix"), ".");
check("rel one level up", rel(DOCS, ROOT, "posix"), "..");
check("rel two levels up", rel(DEMO, ROOT, "posix"), "../..");
check("rel a sibling of the root subtree is absolute", rel(`${DOCS}/guide`, `${ROOT}/tools`, "posix"), `${ROOT}/tools`);
check("rel a sibling inside the root climbs", rel(`${DEMO}/recipes`, `${ROOT}/apps`, "posix"), "../..");
check("rel outside the root is absolute (design §2.2)", rel("/elsewhere/x", ROOT, "posix"), ROOT);
check("rel a sibling of the root is absolute", rel(`${ROOT}/../tools`, ROOT, "posix"), ROOT);
check("rel spells through a space", rel("/home/a b/c", "/home/a b", "posix"), "..");
check("rel normalizes trailing slashes", rel(`${DOCS}/`, `${ROOT}/`, "posix"), "..");
check("rel on win32 spells forward slashes", rel("C:/co/docs", "C:/co", "win32"), "..");
check("rel on win32 crosses drives as an absolute path", rel("D:/x", "C:/co", "win32"), "C:/co");
check("rel outside the root on win32 is absolute", rel("C:/elsewhere/x", "C:/co", "win32"), "C:/co");
check("rel keeps a backslash as one posix component", rel("/co/a\\b", "/co", "posix"), "..");
check("rel keeps posix semantics for a posix host on a win32 process", rel("/clawwright-checkout/docs", "/clawwright-checkout", "posix"), "..");
check("the checkout shim spells from docs", spell(SHIM, "posix", "posix", DOCS), "../clawwright");
check("the checkout shim spells from apps/demo", spell(SHIM, "posix", "posix", DEMO), "../../clawwright");
check("spell npm-bin cmd (from a subdirectory)", spell(BIN, "cmd", "win32", `${APP_LOCAL}/sub`), ["..", "node_modules", ".bin", "clawwright"].join("\\"));
const pwshSub = spell(BIN, "pwsh", "win32", `${APP_LOCAL}/sub`);
check("spell npm-bin pwsh (from a subdirectory)", pwshSub, ["..", "node_modules", ".bin", "clawwright"].join("\\"));
checkTrue("the pwsh subdirectory bin spelling tokenizes as one word", JSON.stringify(tokenizeLine(pwshSub ?? "", "pwsh")) === JSON.stringify([["..", "node_modules", ".bin", "clawwright"].join("\\")]));
checkTrue("the posix shim climb tokenizes as one pwsh word", JSON.stringify(tokenizeLine("../clawwright", "pwsh")) === JSON.stringify(["../clawwright"]));
check("a hint printed at the root keeps the root spelling", words(renderFrameAdvice(command(["status"]), frameWith(SHIM, "posix", ROOT))), ["./clawwright", "status"]);
check("a hint printed from docs spells ../clawwright (O4)", words(renderFrameAdvice(command(["status"]), frameWith(SHIM, "posix", DOCS))), ["../clawwright", "status"]);
check("a hint printed from apps/demo spells ../../clawwright (O4)", words(renderFrameAdvice(command(["status"]), frameWith(SHIM, "posix", DEMO))), ["../../clawwright", "status"]);

// --- pasteShells: the table and the constructor invariant ---------------------------------------------

check("pasteShells: system on win32 offers cmd and pwsh", pasteShells(SYSTEM, { kind: "operator", platform: "win32" }, false), ["cmd", "pwsh"]);
check("pasteShells: system in Git Bash offers posix", pasteShells(SYSTEM, { kind: "operator", platform: "win32" }, true), ["posix"]);
check("pasteShells: shims are posix-only on either platform", pasteShells(SHIM, { kind: "operator", platform: "win32" }, false), ["posix"]);
check("pasteShells: a target is posix-only", pasteShells(BIN, { kind: "target", via: "ssh" }, true), ["posix"]);
for (const p of FRAME_PRODUCERS) {
  const host: HostPlatform = p.frame.host.kind === "operator" ? p.frame.host.platform : "posix";
  let every = true;
  for (const shell of p.frame.shells) every &&= spell(p.frame.launch, shell, host, undefined) !== undefined;
  checkTrue(`pasteShells invariant — every shell of ${p.label} spells the launch`, every);
}

// --- hand-over round-trip over every producer ---------------------------------------------------------

for (const p of FRAME_PRODUCERS) {
  const cwd = p.frame.cwd.kind === "dir" ? p.frame.cwd.path : ROOT;
  const launch = launchFromHandover(handoverOf(p.frame), facts(cwd, p.frame.places.checkoutRoot));
  // The no-facts frames keep their kind; a frame whose launch is launchOf's verbatim
  // fallback for a shim spelling (the launcher's "../../clawwright") is refined by the
  // file-facts classification — that refinement is the check's point, never a third kind.
  checkTrue(`handoverOf then launchFromHandover keeps the launch kind: ${p.label}`, launch.kind === p.frame.launch.kind || p.frame.launch.kind === "verbatim");
}

// --- the file-facts adapter (design §4.1): classification by what exists ---------------------------

// The checkout gate: the hand-over spells the shim from a paste directory the gate is not
// in; the adapter walks to the checkout root's own gate and carries ITS root.
const gateHandover = handoverOf(checkoutGateFrame(GATE, { host: "posix", msys: false, cwd: `${GATE}/apps/demo` }));
check("the adapter classifies a checkout hand-over by the gate on disk", launchFromHandover(gateHandover, facts(`${GATE}/apps/demo`, GATE)), { kind: "checkout-shim", root: norm(GATE) });
// A deployment shim hand-over: app.ts beside the program's directory decides the kind and
// the root — no more reading back as a bash shim with a lost root.
const deploymentFrame = frameWith(DEPLOYMENT, "posix", APP_LOCAL, {});
check("a deployment-shim hand-over round-trips to its own root", launchFromHandover(handoverOf(deploymentFrame), facts(APP_LOCAL, undefined)), { kind: "deployment-shim", root: norm(APP_LOCAL) });

// --- the real generated texts as hand-overs -------------------------------------------------------------

const shimEnv = producer("checkout gate, handed over by the init shim").env ?? {};
check("the committed shim's generated JSON is the hand-over", parseInvocation(shimEnv[INVOCATION_ENV] ?? ""), { program: "./clawwright", mode: "checkout", audience: "terminal" });
check("the committed shim also writes the legacy line", shimEnv[INVOKED_AS_ENV] ?? "", "./clawwright");

const launcher = producer("checkout gate, handed over by the monorepo MCP launcher").env ?? {};
check("the monorepo launcher's JSON is the hand-over", parseInvocation(launcher[INVOCATION_ENV] ?? ""), { program: "../../clawwright", mode: "checkout", app: { name: "demo", selectedBy: "flag" }, audience: "mcp" });
check("the monorepo launcher's legacy line names the shim and the app", (launcher[INVOKED_AS_ENV] ?? "").split(SPACE), ["../../clawwright", "--app", "demo"]);
check("the installed launcher writes no invocation variable", mcpLauncherContent("installed").includes("CLAWWRIGHT_INVOCATION"), false);

// --- the O7 fixture generations -------------------------------------------------------------------------

const g0 = producer("fixture G0: shim before 710cf66 wrote no variables");
checkTrue("G0 writes neither variable", g0.env?.[INVOCATION_ENV] === undefined && g0.env?.[INVOKED_AS_ENV] === undefined);
check("G0 reads as the entry default", g0.invocation, { program: "clawwright", mode: "installed", audience: "terminal" });
check("G0 classifies as the system command", { kind: launchFromHandover(g0.invocation, facts(DEMO)).kind }, { kind: "system" });

const g1 = producer("fixture G1 (710cf66): the legacy variable alone");
check("G1 parses as the legacy hand-over", parseLegacyInvokedAs(g1.env?.[INVOKED_AS_ENV] ?? ""), { program: "./clawwright", mode: "checkout", audience: "terminal" });
check("G1 classifies as a bash shim hand-over", launchFromHandover(g1.invocation, facts(DEMO)), { kind: "checkout-shim", root: norm(ROOT) });

const g2 = producer("fixture G2 (a7d027e): v1 installed + legacy (strict parse rejects)");
check("G2's v1 value is rejected by the strict parse", parseInvocation(g2.env?.[INVOCATION_ENV] ?? ""), undefined);
check("G2 falls back to the legacy line", parseLegacyInvokedAs(g2.env?.[INVOKED_AS_ENV] ?? ""), { program: "./clawwright", mode: "checkout", audience: "terminal" });
check("G2 reads through the legacy variable", g2.invocation, { program: "./clawwright", mode: "checkout", audience: "terminal" });
check("G2 classifies as a bash shim hand-over", launchFromHandover(g2.invocation, facts(DEMO)), { kind: "checkout-shim", root: norm(ROOT) });

const g3 = producer("fixture G3 (a841c16): v1 checkout + legacy");
check("G3's v1 value parses strictly", parseInvocation(g3.env?.[INVOCATION_ENV] ?? ""), { program: "./clawwright", mode: "checkout", audience: "terminal" });
check("G3 classifies as the v1 value says", launchFromHandover(g3.invocation, facts(DEMO)), { kind: "checkout-shim", root: norm(ROOT) });

const l1 = producer("fixture L1 (f620c8a): the legacy launcher variable");
check("L1 parses with the app by flag", parseLegacyInvokedAs(l1.env?.[INVOKED_AS_ENV] ?? ""), { program: "../../clawwright", mode: "checkout", app: { name: "demo", selectedBy: "flag" }, audience: "terminal" });
check("L1 classifies as the checkout shim", launchFromHandover(l1.invocation, facts(DEMO)), { kind: "checkout-shim", root: norm(ROOT) });
check("L1 selects demo by flag", l1.frame.app, { state: "selected", name: "demo", by: "flag" });

const l2 = producer("fixture L2 (a7d027e): v1 checkout launcher + legacy");
check("L2's v1 value parses strictly", parseInvocation(l2.env?.[INVOCATION_ENV] ?? ""), { program: "../../clawwright", mode: "checkout", app: { name: "demo", selectedBy: "flag" }, audience: "mcp" });
check("L2 classifies as the checkout shim", launchFromHandover(l2.invocation, facts(DEMO)), { kind: "checkout-shim", root: norm(ROOT) });
check("L2 keeps the mcp audience", l2.invocation.audience, "mcp");
check("L2 selects demo by flag", l2.frame.app, { state: "selected", name: "demo", by: "flag" });

// --- the manual verbatim values -------------------------------------------------------------------------

const bare = producer("manual verbatim (bare word)");
check("a bare word under installed mode is the verbatim launch", { kind: bare.frame.launch.kind }, { kind: "verbatim" });
check("the verbatim hand-over carries the program as typed", bare.invocation.program, "cw");
const spaced = producer("manual verbatim (spaced program)");
// The file-facts adapter's rows: no gate, no app.ts, no bin layout — verbatim, and the
// spelling prints exactly as typed.
const spacedFacts = facts(ROOT);
check("a spaced absolute program classifies verbatim", { kind: launchFromHandover(spaced.invocation, spacedFacts).kind }, { kind: "verbatim" });
check("the verbatim classification spells the program as typed", spell(launchFromHandover(spaced.invocation, spacedFacts), "posix", "posix", undefined), spaced.invocation.program);
// The renderer quotes the verbatim launch by the frame's shells: POSIX-only under a POSIX
// host (the single-quote rule), cmd/pwsh rows under a Windows host — the Windows row is
// the matrix's, not this pin's.
await requires("posix-host", "the spaced hand-set program's POSIX quoting", () => {
  check(
    "a spaced program renders quoted, pastable",
    words(renderAdvice(command(["logs"]), { program: "/opt/claw forge/clawwright", mode: "checkout", audience: "terminal" })),
    ["'/opt/claw", "forge/clawwright'", "logs"],
  );
});

finish("frame");

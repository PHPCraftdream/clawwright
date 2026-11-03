// The execution frame: how and where this run's string will be executed — the launch (a
// kind, not a program string), the host, the shells the string may be pasted into, the
// paste directory, the known places and the deployment fact. One value, built once at the
// entry through the constructors below and installed there (index.ts); every producer and
// every transition goes through them, so no module outside this one spells a program or
// decides by its spelling. Pure data and functions: no I/O, no process globals.

import { basename, dirname, posix, resolve, win32 } from "node:path";
import type { Shell } from "./advice.ts";
import { INVOCATION_VERSION, type AppSelection, type Invocation, type InvocationAudience, type InvocationMode } from "./index.ts";

export type HostPlatform = "posix" | "win32";

/** How Clawwright is launched. Roots are absolute paths on the frame's host; a launch read
 *  back from a handed-over Invocation (launchOf) carries only the spelling, so its root is
 *  "" — enough to spell and to re-root, never to navigate. Producers that transition a
 *  frame build it with a real root. */
export type Launch =
  | { readonly kind: "system" }                                  // `clawwright` from PATH
  | { readonly kind: "checkout-shim"; readonly root: string }    // <checkout>/clawwright, bash
  | { readonly kind: "deployment-shim"; readonly root: string }  // <deployment>/clawwright from init, bash
  | { readonly kind: "npm-bin"; readonly root: string }          // <deployment>/node_modules/.bin/clawwright(.cmd|.ps1)
  | { readonly kind: "verbatim"; readonly program: string; readonly mode: InvocationMode }; // a hand-set CLAWWRIGHT_INVOCATION

export type Host =
  | { readonly kind: "operator"; readonly platform: HostPlatform }      // this process's machine
  | { readonly kind: "target"; readonly via: "ssh" | "local" | "wsl" }; // a deployment target, always POSIX

export type Cwd =
  | { readonly kind: "dir"; readonly path: string }   // where the string will be pasted
  | { readonly kind: "unknown" };                     // ssh session, cron: the string owes a cd

export interface Places {
  readonly checkoutRoot?: string;
  readonly deploymentRoot?: string;
}

export type AppFact =
  | { readonly state: "none" }                                                   // decided: no deployment
  | { readonly state: "selected"; readonly name: string; readonly by: AppSelection };

export interface Frame {
  readonly launch: Launch;
  readonly host: Host;
  /** Where the string may be pasted; the first is the primary one. Built by pasteShells,
   *  whose invariant is that the frame's own launch spells in every shell listed. */
  readonly shells: readonly [Shell, ...Shell[]];
  readonly cwd: Cwd;
  readonly places: Places;
  readonly app: AppFact;
  readonly audience: InvocationAudience;           // v1 round-trip only; no renderer reads it yet
}

/** The local-package program on Windows: npm's bin wrapper, which cmd resolves through
 *  PATHEXT and PowerShell through its own lookup. The committed shim (SHIM_PROGRAM) is
 *  bash-only and runs in neither; forward slashes fail in cmd. */
export const SHIM_PROGRAM = "./clawwright";

export const WINDOWS_BIN_PROGRAM = "node_modules\\.bin\\clawwright";

export const IN_BASH_NOTE = "in bash";

// --- constructors --------------------------------------------------------------------------------

/** Classifies a handed-over Invocation by its program and mode alone — the no-facts
 *  fallback for the renderArgument boundary shim (render.ts), which knows only the
 *  spelling. Classification by the file a program points to is launchFromHandover.
 *  A leading `./` (or `.\`) is the committed shim's own spelling (SHIM_PROGRAM, and the
 *  shim generations all wrote it) — the shim naming itself, not a generic slash decision —
 *  so it still reads as a bash shim. Every OTHER path-bearing program is verbatim: without
 *  file facts a path is a path, and a hand-set spaced absolute program must spell as typed. */
export function launchOf(on: Invocation): Launch {
  const program = on.program;
  if (program === "clawwright") return { kind: "system" };
  if (program.includes("node_modules/.bin/") || program.includes("node_modules\\.bin\\")) return { kind: "npm-bin", root: "" };
  if (program.startsWith("./") || program.startsWith(".\\")) return { kind: "checkout-shim", root: "" };
  return { kind: "verbatim", program, mode: on.mode };
}

export function classifyCopy(packageDir: string, appRoot: string): { source: "global" } | { source: "checkout"; path: string } | { source: "local-package" } {
  const relative = posix.normalize(packageDir.replaceAll("\\", "/").replace(`${appRoot.replaceAll("\\", "/")}/`, ""));
  if (relative === packageDir.replaceAll("\\", "/")) return { source: "global" };
  return relative.startsWith("node_modules/") ? { source: "local-package" } : { source: "checkout", path: packageDir };
}

/** The entry default's three cases (entry/root.ts): the system-wide copy, a checkout's own
 *  copy (the checkout the decision walked to), an app's own local package — npm's bin
 *  wrapper on Windows, where the bash-only shim does not run. */
export function defaultLaunch(source: { source: "global" } | { source: "checkout-copy"; root: string } | { source: "local-package"; appRoot: string; host: HostPlatform }): Launch {
  if (source.source === "global") return { kind: "system" };
  if (source.source === "checkout-copy") return { kind: "checkout-shim", root: source.root };
  return source.host === "win32" ? { kind: "npm-bin", root: source.appRoot } : { kind: "deployment-shim", root: source.appRoot };
}

/** The checkout gate's own frame (tools/clawwright.ts when no hand-over named it): the
 *  committed shim at the checkout root, pasted wherever the operator stands. */
export function checkoutGateFrame(checkoutRoot: string, facts: { host: HostPlatform; msys: boolean; cwd: string; audience?: InvocationAudience }): Frame {
  const launch: Launch = { kind: "checkout-shim", root: checkoutRoot };
  const host: Host = { kind: "operator", platform: facts.host };
  return {
    launch,
    host,
    shells: pasteShells(launch, host, facts.msys),
    cwd: { kind: "dir", path: facts.cwd },
    places: { checkoutRoot },
    app: { state: "none" },
    audience: facts.audience ?? "terminal",
  };
}

/** A frame for an Invocation the entry read back (a hand-over, or root.ts's default): the
 *  spelling is kept as handed, the shells come from the launch kind and the host facts. */
export function frameFromInvocation(on: Invocation, facts: { host: HostPlatform; msys: boolean; cwd?: string; places?: Places }): Frame {
  const launch = launchOf(on);
  const host: Host = { kind: "operator", platform: facts.host };
  return {
    launch,
    host,
    shells: pasteShells(launch, host, facts.msys),
    cwd: facts.cwd === undefined ? { kind: "unknown" } : { kind: "dir", path: facts.cwd },
    places: facts.places ?? {},
    app: on.app === undefined ? { state: "none" } : { state: "selected", name: on.app.name, by: on.app.selectedBy },
    audience: on.audience,
  };
}

/** Where the string may be pasted: a shim (or a target, always POSIX) pastes in POSIX
 *  shells only; on POSIX, and in Git Bash on Windows, so does everything else; a Windows
 *  host otherwise offers cmd and PowerShell. Invariant: the launch spells in every shell
 *  returned — the system command, npm's wrapper and a verbatim program run in both, the
 *  shims are bash scripts. */
export function pasteShells(launch: Launch, host: Host, msys: boolean): readonly [Shell, ...Shell[]] {
  if (host.kind === "target") return ["posix"];
  if (launch.kind === "checkout-shim" || launch.kind === "deployment-shim") return ["posix"];
  if (host.platform === "posix" || msys) return ["posix"];
  return ["cmd", "pwsh"];
}

// --- spelling ------------------------------------------------------------------------------------

/** `from` relative to `root`, "." when they are the same place; forward slashes throughout.
 *  Path semantics follow the frame's HOST platform (posix/win32), never this process's.
 *  A paste directory outside the root spells the entry absolutely (design §2.2): the test
 *  is whether the root reaches the paste directory without a `..`, so a sibling of the
 *  root is outside while a child at any depth is inside. */
export function rel(from: string, root: string, platform: HostPlatform): string {
  if (platform === "posix") {
    const target = posix.resolve(root);
    const back = posix.relative(target, posix.resolve(from));
    const inside = back === "" || (back !== ".." && !back.startsWith("../"));
    if (!inside) return target;
    const raw = posix.relative(posix.resolve(from), target);
    return raw === "" ? "." : raw;
  }
  // A drive-less absolute root ("/co") is compared resolved, but spelled back without a
  // drive — the process drive is this fixture/process's, not the frame's fact.
  const target = win32.resolve(root);
  const targetForm = /^[A-Za-z]:/.test(root) ? target.split(win32.sep).join("/") : root.replaceAll("\\", "/");
  const back = win32.relative(target, win32.resolve(from));
  const inside = back === "" || (back !== ".." && !back.startsWith("..\\"));
  if (!inside) return targetForm;
  const raw = win32.relative(win32.resolve(from), target).split(win32.sep).join("/");
  return raw === "" ? "." : raw;
}

function shimSpelling(root: string, from: string | undefined, platform: HostPlatform): string {
  if (from === undefined || root === "") return SHIM_PROGRAM;
  const path = rel(from, root, platform);
  return path === "." ? SHIM_PROGRAM : `${path}/clawwright`;
}

function binSpelling(root: string, from: string | undefined, shell: Shell, host: HostPlatform): string | undefined {
  if (shell === "pwsh" && host === "posix") return undefined; // a POSIX host has no .ps1 wrapper
  if (from === undefined || root === "") {
    return shell === "posix" ? "node_modules/.bin/clawwright" : WINDOWS_BIN_PROGRAM;
  }
  const path = rel(from, root, host);
  if (shell === "posix") return path === "." ? "node_modules/.bin/clawwright" : `${path}/node_modules/.bin/clawwright`;
  return path === "." ? WINDOWS_BIN_PROGRAM : `${path.split("/").join("\\")}\\node_modules\\.bin\\clawwright`;
}

/** The program as typed in `shell`, or undefined when the launch has no spelling there —
 *  the renderer's fallback rule owns that case. `from` is the directory the spelling is
 *  relative to; undefined spells the launch root itself. */
export function spell(launch: Launch, shell: Shell, host: HostPlatform, from: string | undefined): string | undefined {
  switch (launch.kind) {
    case "system": return "clawwright";
    case "verbatim": return launch.program;
    case "checkout-shim":
    case "deployment-shim":
      return shell === "posix" ? shimSpelling(launch.root, from, host) : undefined;
    case "npm-bin":
      return binSpelling(launch.root, from, shell, host);
  }
}

// --- transitions ---------------------------------------------------------------------------------

/** The checkout-root transition's by-kind decision (rf6-fix33, D1): only the bare
 *  system-wide command runs at a checkout root unchanged; every other kind is that
 *  checkout's own entry there — the committed shim. A local package inside a checkout is
 *  the same entry: npm's wrapper lives in a deployment's own node_modules, never at the
 *  root, so re-rooting it spelled a line the named place cannot run. Decided by the KIND
 *  of launch, never by "contains /". */
export function rootedLaunch(launch: Launch): Launch {
  if (launch.kind === "system") return launch;
  return { kind: "checkout-shim", root: launch.kind === "verbatim" ? "" : launch.root };
}

/** The bash shim's own frame: the committed shim spelling, POSIX-only, no places — the
 *  second row of a place-naming refusal, built from the frame that builds row 1 (the
 *  renderer adds no shim row of its own yet; that is S1.4). */
export function shimFrame(from: Frame, app?: string): Frame {
  const launch: Launch = { kind: "checkout-shim", root: "" };
  return {
    launch,
    host: from.host,
    shells: ["posix"],
    cwd: { kind: "unknown" },
    places: {},
    app: app === undefined ? { state: "none" } : { state: "selected", name: app, by: "flag" },
    audience: from.audience,
  };
}

/** The frame of the TARGET that executes stored text (design S1.5): cron entries, schtasks
 *  command lines, completion Install headers, the committed shims. The launch is pasted at
 *  its own ROOT — the root spelling, never the directory the operator happened to stand in —
 *  for the one shell the stored text names (the frame's primary when it names none). A bare
 *  Launch (a writer that knows only the launch it emits) becomes the target's own frame:
 *  POSIX, no places. */
export function targetFrame(target: Frame | Launch, shell?: Shell): Frame {
  const f: Frame = "launch" in target ? target : {
    launch: target,
    host: { kind: "operator", platform: "posix" },
    shells: ["posix"],
    cwd: { kind: "unknown" },
    places: {},
    app: { state: "none" },
    audience: "terminal",
  };
  // A launch with a root pastes there; a launch read back from a hand-over (root "") has
  // only portable spellings, so the frame's own paste directory stays — the spelling
  // ignores it either way, and the shell-named branch needs a from to re-spell through.
  const root = (f.launch.kind === "checkout-shim" || f.launch.kind === "deployment-shim" || f.launch.kind === "npm-bin") && f.launch.root !== ""
    ? f.launch.root
    : f.cwd.kind === "dir" ? f.cwd.path : undefined;
  return {
    ...f,
    shells: [shell ?? f.shells[0]],
    cwd: root === undefined ? { kind: "unknown" } : { kind: "dir", path: root },
  };
}

/** Frame → frame: the frame the place-naming sentences direct to. Without a known checkout
 *  root the frame is returned as is; a cwd-resolving deployment fact becomes a flag (from
 *  the root, the cwd no longer picks the deployment). Shells are kept — a launch with no
 *  spelling there falls back in the renderer. */
export function toCheckoutRoot(f: Frame): Frame {
  const root = f.places.checkoutRoot;
  if (root === undefined) return f;
  return {
    ...f,
    launch: f.launch.kind === "system" ? f.launch : { kind: "checkout-shim", root },
    cwd: f.cwd.kind === "dir" ? { kind: "dir", path: root } : f.cwd,
    app: f.app.state === "selected" && f.app.by === "cwd" ? { ...f.app, by: "flag" } : f.app,
  };
}

/** Frame → frame: the string spelled for one shell alone. npm's wrapper keeps its POSIX
 *  spelling under posix (npm writes an sh wrapper); anything without a spelling there is
 *  the renderer's fallback. */
export function forShell(f: Frame, shell: Shell): Frame {
  return { ...f, shells: [shell] };
}

/** True when the launch looks for its deployment from the cwd — the paste-conflict rule
 *  (rf6-fix33) and the entry's cwd re-selection both read it. A longer path spelling (the
 *  MCP launcher) is the checkout gate and reads neither. */
export function resolvesByCwd(launch: Launch, program: string): boolean {
  if (launch.kind === "checkout-shim") return program === SHIM_PROGRAM;
  return launch.kind === "system" || launch.kind === "deployment-shim" || launch.kind === "npm-bin";
}

// --- the v1 projection ---------------------------------------------------------------------------

// Writers use this constructor so mode projection always flows through modeOf.
export function checkoutLaunch(): Launch { return { kind: "checkout-shim", root: "" }; }

export function launchFromModeBoundary(program: string): Launch {
  return program === "clawwright" ? { kind: "system" } : checkoutLaunch();
}
export function modeOf(launch: Launch): InvocationMode {
  switch (launch.kind) {
    case "system": return "installed";
    case "checkout-shim":
    case "deployment-shim": return "checkout";
    case "npm-bin": return "local-package";
    case "verbatim": return launch.mode;
  }
}

/** The Invocation a frame hands to child processes: the launch's own spelling (the root
 *  spelling — a hand-over keeps the program it arrived with only through launchOf, whose
 *  frames are never re-spelled). */
export function handoverOf(frame: Frame): Invocation {
  const host = frame.host.kind === "operator" ? frame.host.platform : "posix";
  const program = spell(frame.launch, frame.shells[0], host, undefined)
    ?? (frame.launch.kind === "verbatim" ? frame.launch.program : SHIM_PROGRAM);
  const app = frame.app.state === "selected" ? { name: frame.app.name, selectedBy: frame.app.by } : undefined;
  return {
    program,
    mode: modeOf(frame.launch),
    ...(app === undefined ? {} : { app }),
    audience: frame.audience,
  };
}

/** The file facts the hand-over adapter classifies by: where the process stands and a
 *  minimal probe (the narrow slice of entry/resolve.ts's FsProbe the classification needs;
 *  passed in rather than imported, so this module stays cycle-free). */
export interface HandoverFacts {
  readonly cwd: string;
  readonly fs: {
    readonly exists: (path: string) => boolean;
    readonly readFile: (path: string) => string | undefined;
  };
  readonly checkoutRoot?: string;
}

const FRAMEWORK_PACKAGE = "@phpcraftdream/clawwright";

/** The checkout-gate test, the same shape as the resolver's checkoutGateIn: a directory is
 *  a checkout when tools/framework/package.json names the framework and tools/clawwright.ts
 *  stands beside it. */
function gateIn(dir: string, fs: HandoverFacts["fs"]): boolean {
  const manifest = fs.readFile(resolve(dir, "packages", "clawwright", "package.json"));
  if (manifest === undefined) return false;
  try {
    return (JSON.parse(manifest) as { name?: unknown }).name === FRAMEWORK_PACKAGE && fs.exists(resolve(dir, "tools", "clawwright.ts"));
  } catch {
    return false;
  }
}

/** The package root of a node_modules/.bin program: the directory above the innermost
 *  node_modules on the program's path. */
function packageRootOf(from: string): string | undefined {
  let dir = from;
  for (;;) {
    if (basename(dir) === "node_modules") return dirname(dir);
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/** Classifies a handed-over Invocation BY WHAT EXISTS, not by its spelling (design §4.1):
 *  the file the program points to decides — a checkout's gate, a deployment's app.ts,
 *  npm's bin layout — with the checkout root as the fallback anchor for the committed
 *  shims' relative spelling (the gate shim names itself with SHIM_PROGRAM, from wherever the
 *  operator stands). Everything the facts cannot vouch for is the verbatim launch. */
export function launchFromHandover(on: Invocation, facts: HandoverFacts): Launch {
  const program = on.program;
  if (program === "clawwright") return { kind: "system" };
  const uniform = program.split("\\").join("/");
  const here = resolve(facts.cwd, uniform);
  if (basename(here) === "clawwright") {
    const dir = dirname(here);
    if (gateIn(dir, facts.fs)) return { kind: "checkout-shim", root: dir };
    if (facts.fs.exists(resolve(dir, "app.ts"))) return { kind: "deployment-shim", root: dir };
  }
  if (facts.checkoutRoot !== undefined) {
    const atRoot = resolve(facts.checkoutRoot, uniform);
    const dir = dirname(atRoot);
    if (basename(atRoot) === "clawwright" && gateIn(dir, facts.fs)) return { kind: "checkout-shim", root: dir };
  }
  if (on.mode === "local-package" && uniform.includes("node_modules/.bin/")) {
    const root = packageRootOf(dirname(here));
    if (root !== undefined) return { kind: "npm-bin", root };
  }
  return { kind: "verbatim", program, mode: on.mode };
}

/** The v1 JSON a committed shim or launcher writes, single-sourced here so every writer's
 *  emitted text stays byte-identical (INVOCATION_VERSION stays 1; decision O7). */
export function handoverJson(launch: Launch, audience: InvocationAudience = "terminal"): string {
  const host: HostPlatform = "posix";
  const program = spell(launch, "posix", host, undefined) ?? (launch.kind === "verbatim" ? launch.program : SHIM_PROGRAM);
  return JSON.stringify({ version: INVOCATION_VERSION, program, mode: modeOf(launch), audience });
}

/** A legacy CLAWWRIGHT_INVOKED_AS prefix mapped onto the value: a program path (the launcher's
 *  relative spelling included), optionally with the hand-written `--app <name>` suffix the old
 *  variable carried. The old variable never said how the deployment was picked; every writer
 *  spelled the suffix by hand for a selection the cwd would not repeat, so `flag`. The mode
 *  follows the program: the bare system-wide command is `installed`, everything else (a path
 *  into the checkout or a deployment) is `checkout`. */
export function parseLegacyInvokedAs(text: string): Invocation | undefined {
  const value = text.trim();
  if (value === "") return undefined;
  const suffix = /^(.*) --app (\S+)$/.exec(value);
  if (suffix === null || suffix[1].trim() === "") {
    // A value that is only a flag suffix, or whose program carries internal spacing, is
    // garbage a hand-written variable picked up on the way: it reads as unset, like the
    // strict parse. Spacing between program and suffix trims away and is kept.
    if (value.startsWith("--") || /\s/.test(value)) return undefined;
    return { program: value, mode: value === "clawwright" ? "installed" : "checkout", audience: "terminal" };
  }
  const program = suffix[1].trim();
  // The same rule for the program of a suffixed value: "--app x --app y" is not a path.
  if (program.startsWith("--") || /\s/.test(program)) return undefined;
  return { program, mode: program === "clawwright" ? "installed" : "checkout", app: { name: suffix[2], selectedBy: "flag" }, audience: "terminal" };
}


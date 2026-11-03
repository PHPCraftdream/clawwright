// The frame producer registry (stage 7, S1.2a; design §7.1 item 1): every frame a producer
// builds, each built by the REAL constructors from core/io/invocation/frame.ts on the fake
// layout of golden/matrix.ts (ROOT, APP, APP_LOCAL — the same fake tree, no real I/O). The
// hand-over producers read their variables out of the REAL generated texts (the committed
// shim SHIM and mcpLauncherContent), parse them with the REAL parsers and classify them
// with the REAL file-facts adapter (launchFromHandover, S1.3); the defaultLaunch producers
// call the REAL entry-default constructor. The G0–G3/L1–L2 compatibility generations
// (decision O7) keep HAND-WRITTEN env literals from history — independent expectations the
// reader must keep accepting (I11) — but their frames classify through the same real
// adapter on the same layout.
import { resolve, sep } from "node:path";
import {
  INVOCATION_ENV,
  INVOKED_AS_ENV,
  parseInvocation,
  parseLegacyInvokedAs,
  type Invocation,
} from "#framework/core/io/invocation/index.ts";
import {
  checkoutGateFrame,
  defaultLaunch,
  frameFromInvocation,
  handoverOf,
  launchFromHandover,
  launchOf,
  pasteShells,
  type Frame,
  type Host,
  type HostPlatform,
  type Launch,
  type Places,
} from "#framework/core/io/invocation/frame.ts";
import { SHIM } from "#framework/integration/deployment/init.ts";
import { mcpLauncherContent } from "#framework/integration/mcp/project.ts";

/** The fake layout, spelled exactly as golden/matrix.ts spells it (read-only constants):
 *  the checkout ROOT with its gate, the deployment APP under it, and a deployed app's own
 *  local package APP_LOCAL. */
const ROOT = "/clawwright-checkout";
const APP_LOCAL = "/home/u/app-local";
const DOCS = `${ROOT}/docs`;
const DEMO = `${ROOT}/apps/demo`;

/** The fake fs, over that layout: the paths the real file-facts classifier probes. Paths
 *  are compared normalized (absolute, this host's separators), because frame.ts resolves
 *  with node:path and the host here may be Windows. */
const LAYOUT = [
  `${ROOT}/tools/clawwright.ts`,
  `${ROOT}/packages/clawwright/package.json`,
  `${ROOT}/clawwright`,
  `${DEMO}/app.ts`,
  `${APP_LOCAL}/app.ts`,
  `${APP_LOCAL}/node_modules/@phpcraftdream/clawwright/entry/bin.js`,
  `${APP_LOCAL}/node_modules/.bin/clawwright`,
].map((path) => resolve(path).split(sep).join("/").replace(/^[A-Za-z]:/, ""));
const FS = {
  exists: (path: string): boolean => LAYOUT.includes(resolve(path).split(sep).join("/").replace(/^[A-Za-z]:/, "")),
  readFile: (path: string): string | undefined =>
    resolve(path).split(sep).join("/").replace(/^[A-Za-z]:/, "") === LAYOUT[1] ? '{"name":"@phpcraftdream/clawwright"}' : undefined,
};

export interface FrameProducer {
  readonly label: string;
  /** The frame the process runs as, built by a real frame.ts constructor. */
  readonly frame: Frame;
  /** How the process was actually started: the parsed hand-over (env producers) or the
   *  frame's own v1 projection (constructor producers) — the law check's input. */
  readonly invocation: Invocation;
  /** The CLAWWRIGHT_* variables the producer's shim or launcher wrote, when it wrote any. */
  readonly env?: Record<string, string>;
  /** The selection-sweep facts (design §5) this producer also carries: the app selection
   *  the entry sees besides the hand-over — a typed --app, an OC_APP export (including the
   *  empty value), a sole or a cwd selection. Data only; the law's drive through
   *  resolveCheckoutEntry lands in the next chunk. */
  readonly selection?: {
    readonly argv?: readonly string[];
    readonly ocApp?: string;
    readonly soleApp?: string;
    readonly cwdApp?: string;
    /** The checkout's own apps/ for this case, when the shared layout cannot carry it
     *  (the sole case: exactly one deployment under apps/). */
    readonly apps?: readonly string[];
  };
}

// --- hand-over extraction (real texts, real parsers) ----------------------------------------------

/** The committed init shim's two variables, out of the generated text itself. */
const SHIM_JSON = /export CLAWWRIGHT_INVOCATION='([^']+)'/.exec(SHIM)?.[1] ?? "";
const SHIM_LEGACY = /export CLAWWRIGHT_INVOKED_AS=(.*)/.exec(SHIM)?.[1]?.trim() ?? "";

/** The monorepo MCP launcher's two variables: the generated expressions, evaluated with
 *  basename(root) bound to the fake deployment name (the same reading
 *  invocation-hints.check.ts does of the same text). */
const MONOREPO_LAUNCHER = mcpLauncherContent("monorepo");
const LAUNCHER_JSON_SOURCE = /CLAWWRIGHT_INVOCATION = JSON\.stringify\((.*)\);/.exec(MONOREPO_LAUNCHER)?.[1] ?? "";
const LAUNCHER_LEGACY_SOURCE = /CLAWWRIGHT_INVOKED_AS = (.+);/.exec(MONOREPO_LAUNCHER)?.[1] ?? "";
const demo = (expression: string): string => expression.replaceAll("basename(root)", '"demo"');
const LAUNCHER_JSON = JSON.stringify(
  new Function("basename", `return (${demo(LAUNCHER_JSON_SOURCE)})`)() as object,
);
const LAUNCHER_LEGACY = new Function("basename", `return (${demo(LAUNCHER_LEGACY_SOURCE)})`)() as string;

/** The env reading an entry does (takeInvocationFromEnv's rule, on a passed-in record): the
 *  strict JSON wins, the legacy line is the fallback, and nothing set is the entry default —
 *  the bare system-wide command (defaultLaunch, global). */
function handedOver(env: Record<string, string>): Invocation {
  const json = env[INVOCATION_ENV];
  const strict = json === undefined ? undefined : parseInvocation(json);
  return strict
    ?? parseLegacyInvokedAs(env[INVOKED_AS_ENV] ?? "")
    ?? { program: "clawwright", mode: "installed", audience: "terminal" };
}

const HOST: HostPlatform = "posix";
const FACTS = { host: HOST, msys: false };

/** A frame of a KNOWN Launch — frame.ts has no Frame-from-Launch constructor (reported),
 *  so this is the local assembly foundation/invocation/frame.check.ts's frameWith does:
 *  the only decision in it, the shell set, is still the real pasteShells constructor's. */
function frameOf(launch: Launch, hostPlatform: HostPlatform, msys: boolean, cwd: string, places: Places = { checkoutRoot: ROOT }): Frame {
  const host: Host = { kind: "operator", platform: hostPlatform };
  return {
    launch,
    host,
    shells: pasteShells(launch, host, msys),
    cwd: { kind: "dir", path: cwd },
    places,
    app: { state: "none" },
    audience: "terminal",
  };
}

/** The frame a handed-over Invocation runs as, classified by the REAL file-facts adapter
 *  against the fake layout: pasted at the checkout root or under it, the committed shims'
 *  relative spelling names the checkout's own gate; pasted in the deployment directory,
 *  a shim names the deployment's own. */

/** The fixture's paths are POSIX; the real adapter's roots carry this process's resolve()
 *  spelling. Normalize here — the fixture boundary — never in product path semantics. */
const posixPath = (path: string): string => path.replaceAll("\\", "/").replace(/^[A-Za-z]:\//, "/");

function fromHandover(invocation: Invocation, cwd: string, msys = false): Frame {
  const launch = launchFromHandover(invocation, { cwd, fs: FS, checkoutRoot: ROOT });
  const rooted = launch.kind === "checkout-shim" || launch.kind === "deployment-shim" || launch.kind === "npm-bin" ? { ...launch, root: posixPath(launch.root) } : launch;
  const classified = frameOf(rooted, HOST, msys, cwd);
  // The hand-over's app fact rides along: the same mapping frameFromInvocation uses, so a
  // launcher generation's `--app <name>` (L1/L2) survives the frameOf assembly.
  return {
    ...classified,
    app: invocation.app === undefined ? { state: "none" } : { state: "selected", name: invocation.app.name, by: invocation.app.selectedBy },
  };
}

// --- the producers --------------------------------------------------------------------------------

// A constructor producer hands over its own frame's v1 projection (handoverOf).
const gate = (label: string, cwd: string, selection?: FrameProducer["selection"]): FrameProducer => {
  const frame = checkoutGateFrame(ROOT, { ...FACTS, cwd });
  return { label, frame, invocation: handoverOf(frame), selection };
};

// A defaultLaunch producer: the REAL entry-default constructor's Launch, framed.
const defaultCase = (label: string, source: Parameters<typeof defaultLaunch>[0], hostPlatform: HostPlatform, msys: boolean, cwd: string, selection?: FrameProducer["selection"]): FrameProducer => {
  const frame = frameOf(defaultLaunch(source), hostPlatform, msys, cwd);
  return { label, frame, invocation: handoverOf(frame), selection };
};

const list: FrameProducer[] = [
  // The checkout gate shim (checkoutGateFrame), pasted at three places.
  gate("checkout gate shim (cwd: checkout root)", ROOT, { argv: ["--app", "demo", "up"] }),
  gate("checkout gate shim (cwd: docs)", DOCS, { ocApp: "staging" }),
  gate("checkout gate shim (cwd: apps/demo)", DEMO, { cwdApp: "demo", argv: ["up"] }),

  // Hand-over variants: the gate reading the real generated env texts, classified by the
  // REAL file-facts adapter — the init shim's hand-over pasted at the checkout root names
  // the checkout's own gate; the launcher's two-levels-up spelling pasted at apps/demo
  // names it too (launchFromHandover's checkoutRoot anchor).
  {
    label: "checkout gate, handed over by the init shim",
    frame: fromHandover(parseInvocation(SHIM_JSON) as Invocation, ROOT),
    invocation: parseInvocation(SHIM_JSON) as Invocation,
    env: { [INVOCATION_ENV]: SHIM_JSON, [INVOKED_AS_ENV]: SHIM_LEGACY },
  },
  {
    label: "checkout gate, handed over by the monorepo MCP launcher",
    frame: fromHandover(parseInvocation(LAUNCHER_JSON) as Invocation, DEMO),
    invocation: parseInvocation(LAUNCHER_JSON) as Invocation,
    env: { [INVOCATION_ENV]: LAUNCHER_JSON, [INVOKED_AS_ENV]: LAUNCHER_LEGACY },
  },
  // The installed launcher writes no variables: the entry default (G0's reading).
  {
    label: "MCP launcher (installed): no variables — the entry default",
    frame: frameFromInvocation({ program: "clawwright", mode: "installed", audience: "terminal" }, { ...FACTS, cwd: ROOT, places: { checkoutRoot: ROOT } }),
    invocation: { program: "clawwright", mode: "installed", audience: "terminal" },
    selection: { ocApp: "" },
  },

  // defaultLaunch's cases, each the REAL constructor's Launch framed on the layout: the
  // system command, the checkout's own shim at ROOT, the deployment's own shim (posix) or
  // npm's bin wrapper (win32) in APP_LOCAL. The invocation is the frame's own hand-over
  // projection (handoverOf) — the root spelling, not a guessed program.
  defaultCase("defaultLaunch: global install", { source: "global" }, HOST, false, ROOT, { argv: ["up"] }),
  defaultCase("defaultLaunch: checkout copy", { source: "checkout-copy", root: ROOT }, HOST, false, ROOT, { soleApp: "demo" }),
  defaultCase("defaultLaunch: local package (posix)", { source: "local-package", appRoot: APP_LOCAL, host: "posix" }, "posix", false, APP_LOCAL),
  defaultCase("defaultLaunch: local package (win32)", { source: "local-package", appRoot: APP_LOCAL, host: "win32" }, "win32", false, APP_LOCAL),
  defaultCase("defaultLaunch: local package (win32, Git Bash)", { source: "local-package", appRoot: APP_LOCAL, host: "win32" }, "win32", true, APP_LOCAL),

  // Manual verbatim values. The bare word and the spaced absolute path classify as
  // verbatim (launchOf's no-facts rows); recorded, not idealized.
  {
    label: "manual verbatim (bare word)",
    frame: frameFromInvocation({ program: "cw", mode: "installed", audience: "terminal" }, { ...FACTS, cwd: ROOT, places: { checkoutRoot: ROOT } }),
    invocation: { program: "cw", mode: "installed", audience: "terminal" },
  },
  {
    label: "manual verbatim (spaced program)",
    frame: frameFromInvocation({ program: "/opt/claw forge/clawwright", mode: "checkout", audience: "terminal" }, { ...FACTS, cwd: ROOT, places: { checkoutRoot: ROOT } }),
    invocation: { program: "/opt/claw forge/clawwright", mode: "checkout", audience: "terminal" },
  },
  // The S1.4 case-4 producer (O2): the system-wide command pasted inside a deployment the
  // user cwd-selected — advice naming ANOTHER deployment must run there via --project-root.
  (() => {
    const frame = {
      ...frameOf({ kind: "system" } as Launch, HOST, false, DEMO),
      app: { state: "selected", name: "demo", by: "cwd" },
    } as Frame;
    return { label: "system-wide inside apps/demo (cwd selection)", frame, invocation: handoverOf(frame) };
  })(),
];

// --- the O7 compatibility generations: fixture literals from history -------------------------------

// Hand-written, byte for byte as the generations wrote them (design §4.2, decision O7):
// the env VALUES a shim or launcher of each generation exported. Not outputs of the
// current writers — the current G3/L2 texts are pinned elsewhere; these are the
// independent expectations the reader must keep accepting (I11).
const G0_ENV: Record<string, string> = {};
const G1_ENV: Record<string, string> = { [INVOKED_AS_ENV]: "./clawwright" };
const G2_ENV: Record<string, string> = {
  [INVOCATION_ENV]: '{"version":1,"program":"./clawwright","mode":"installed","audience":"terminal"}',
  [INVOKED_AS_ENV]: "./clawwright",
};
const G3_ENV: Record<string, string> = {
  [INVOCATION_ENV]: '{"version":1,"program":"./clawwright","mode":"checkout","audience":"terminal"}',
  [INVOKED_AS_ENV]: "./clawwright",
};
const L1_ENV: Record<string, string> = { [INVOKED_AS_ENV]: "../../clawwright --app demo" };
const L2_ENV: Record<string, string> = {
  [INVOCATION_ENV]: '{"version":1,"program":"../../clawwright","mode":"checkout","app":{"name":"demo","selectedBy":"flag"},"audience":"mcp"}',
  [INVOKED_AS_ENV]: "../../clawwright --app demo",
};

for (const [label, env] of [
  ["G0: shim before 710cf66 wrote no variables", G0_ENV],
  ["G1 (710cf66): the legacy variable alone", G1_ENV],
  ["G2 (a7d027e): v1 installed + legacy (strict parse rejects)", G2_ENV],
  ["G3 (a841c16): v1 checkout + legacy", G3_ENV],
  ["L1 (f620c8a): the legacy launcher variable", L1_ENV],
  ["L2 (a7d027e): v1 checkout launcher + legacy", L2_ENV],
] as const) {
  const invocation = handedOver(env);
  // The paste cwd, honestly per fixture: a shim generation pasted in the deployment
  // directory names the deployment's own shim; the installed launcher and the launcher
  // generations pasted under the checkout name the checkout's gate (or the system
  // command, when nothing was handed over).
  const cwd = label.startsWith("G1") || label.startsWith("G2") || label.startsWith("G3") ? APP_LOCAL : DEMO;
  list.push({
    label: `fixture ${label}`,
    frame: fromHandover(invocation, cwd),
    invocation,
    env,
  });
}

/** The registry, in the order above: gates, hand-overs, defaults, verbatims, then the
 *  O7 generations. The frame law iterates this; golden matrices build columns from it. */
export const FRAME_PRODUCERS: readonly FrameProducer[] = list;

/** One producer by its exact label — the law names cases by producer. */
export function producer(label: string): FrameProducer {
  const found = FRAME_PRODUCERS.find((entry) => entry.label === label);
  if (found === undefined) throw new Error(`unknown frame producer: ${label}`);
  return found;
}

/** A launch spelling the producer registry cannot carry (launchOf is the current adapter):
 *  a bare non-`clawwright` word under installed mode. The spell table's verbatim row and the
 *  pasteShells invariant read this. */
export const VERBATIM_LAUNCH: ReturnType<typeof launchOf> = launchOf({ program: "cw", mode: "installed", audience: "terminal" });

/** The selection sweep (design §5): default, --app flag, OC_APP env, sole, cwd, and the
 *  EMPTY OC_APP value — as producer-level facts the law check drives through
 *  resolveCheckoutEntry (the same producers carry them as `selection` annotations). */
export const SELECTION_CASES: readonly {
  readonly label: string;
  readonly producer: string;
  readonly argv: readonly string[];
  readonly ocApp?: string;
  readonly soleApp?: string;
  readonly cwdApp?: string;
  /** The checkout's own apps/ for this case, when the shared layout cannot carry it. */
  readonly apps?: readonly string[];
}[] = [
  { label: "default", producer: "defaultLaunch: global install", argv: ["up"] },
  { label: "--app\u0020flag", producer: "checkout gate shim (cwd: checkout root)", argv: ["--app", "demo", "up"] },
  { label: "OC_APP\u0020env", producer: "checkout gate shim (cwd: docs)", argv: ["up"], ocApp: "staging" },
  { label: "sole", producer: "defaultLaunch: checkout copy", argv: ["up"], soleApp: "demo", apps: ["demo"] },
  { label: "cwd", producer: "checkout gate shim (cwd: apps/demo)", argv: ["up"], cwdApp: "demo" },
  { label: "EMPTY\u0020OC_APP", producer: "MCP launcher (installed): no variables — the entry default", argv: ["up"], ocApp: "" },
];

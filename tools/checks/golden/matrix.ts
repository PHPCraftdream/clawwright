// The entry decision matrix (refactor plan stage 2, item 4): every layout × argv × env ×
// platform, resolved by the pure entry resolver (entry/resolve.ts) on a fake file system —
// no processes. Not a table-driven re-assertion of the code's own shape: the prefixes are
// rendered through the real commandLine(), the refusals through the same pure report
// builders the entries render, and the file is a golden diff like the other surfaces.

import { basename, dirname } from "node:path";
import { invocation, setInvocation } from "#framework/core/io/invocation/index.ts";
import { commandLine, renderAdvice, SHIM_PROGRAM } from "#framework/core/io/invocation/render.ts";
import { frameFromInvocation, launchFromHandover, type Frame, type HandoverFacts, type Launch } from "#framework/core/io/invocation/frame.ts";
import type { Invocation } from "#framework/core/io/invocation/index.ts";
import { command, type Advice } from "#framework/core/io/invocation/advice.ts";
import { UserError } from "#framework/core/io/log.ts";
import { checkoutGate, installedGate } from "#framework/entry/registry.ts";
import { appConflictRefusal } from "#framework/entry/delegate.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { checkoutInlineNotes, checkoutSubfolderReport, missingDeploymentReport } from "#framework/integration/gate.ts";
import {
  resolveCheckoutEntry,
  resolveInstalledEntry,
  frameworkOwner,
  strayCheckoutApp,
  missingAppDecision,
  type FsProbe,
  type InstalledEntryDecision,
  type MissingAppDecision,
} from "#framework/entry/resolve.ts";

/** The fake checkout root. Path-shaped so node's resolve/relative see a normal tree; the
 *  renderer strips whatever drive prefix this host's path module puts in front of it. */
const ROOT = "/clawwright-checkout";
const APP = "/home/u/app";
const APP_LOCAL = "/home/u/app-local";
const EMPTY = "/home/u/empty";
const STRAY = `${ROOT}/stray-sub`;
const SELF = "/usr/local/lib/node_modules/@phpcraftdream/clawwright/dist/entry/bin.js";
const LOCAL_ENTRY = `${APP_LOCAL}/node_modules/@phpcraftdream/clawwright/entry/bin.js`;

/** The frame the installed command builds its refusals as ("clawwright"): the golden's
 *  builders pin it, because the bash shim row's drop decision reads the frame at build
 *  time — the entries themselves build after bin.ts has installed the real one. */
const INSTALLED_FRAME: Frame = frameFromInvocation({ program: "clawwright", mode: "installed", audience: "terminal" }, { host: "posix", msys: false });

/** A tiny in-memory file system: exact paths plus a canonical-spelling map (Windows case).
 *  Lookups are normalised, because node's resolve spells fake paths with this host's drive
 *  and separators. */
export function fakeFs(files: Record<string, string>, dirs: readonly string[], real: Record<string, string> = {}): FsProbe {
  const norm = (path: string): string => path.replaceAll("\\", "/").replace(/^[A-Za-z]:/, "");
  const canonical = (path: string): string => real[norm(path)] ?? norm(path);
  return {
    exists: (path) => canonical(path) in files || dirs.includes(canonical(path)),
    isDirectory: (path) => dirs.includes(canonical(path)),
    readdir: (path) => {
      const dir = canonical(path);
      const names = new Set<string>();
      for (const file of Object.keys(files)) if (dirname(file) === dir) names.add(basename(file));
      for (const entry of dirs) if (dirname(entry) === dir) names.add(basename(entry));
      return [...names];
    },
    readFile: (path) => files[canonical(path)],
    realpath: (path) => real[path] ?? path,
  };
}

const manifest = JSON.stringify({ name: "@phpcraftdream/clawwright" });
const strayAppTs = 'import { defineApp } from "../../packages/clawwright/core/app.ts";\nexport default defineApp({});\n';

/** Files/dirs shared by every layout, laid out once: the checkout with two deployments, the
 *  stray checkout-style app.ts outside apps/, the installed app, its local-package twin,
 *  and an empty directory. */
const BASE_FILES: Record<string, string> = {
  [`${ROOT}/tools/clawwright.ts`]: "// gate\n",
  [`${ROOT}/packages/clawwright/package.json`]: manifest,
  [`${ROOT}/apps/openclaw/app.ts`]: "export default {};\n",
  [`${ROOT}/apps/demo/app.ts`]: "export default {};\n",
  [`${STRAY}/app.ts`]: strayAppTs,
  [`${APP}/app.ts`]: "export default {};\n",
  [`${APP}/config/desired-state.json`]: "{}\n",
  [`${APP_LOCAL}/app.ts`]: "export default {};\n",
  [`${APP_LOCAL}/config/desired-state.json`]: "{}\n",
  [LOCAL_ENTRY]: "// local package entry\n",
};
const BASE_DIRS = [`${ROOT}/apps`, `${ROOT}/apps/openclaw`, `${ROOT}/apps/demo`, `${ROOT}/apps/fresh`, `${ROOT}/docs`, `${ROOT}/packages`, `${ROOT}/packages/clawwright`, dirname(STRAY), STRAY, `${APP}/config`, `${APP}/recipes`, `${APP}/recipes/sub`, `${APP_LOCAL}/config`, EMPTY];
/** Windows case: the same deployment typed as APPS/<name>. */
const WIN_REAL: Record<string, string> = {
  [`${ROOT}/APPS/openclaw`]: `${ROOT}/apps/openclaw`,
  [`${ROOT}/APPS/openclaw/app.ts`]: `${ROOT}/apps/openclaw/app.ts`,
  [`${ROOT}/apps/demo`]: `${ROOT}/apps/DEMO`,
};

interface CaseLayout {
  readonly id: string;
  /** cwd for the gate decision; undefined — the gate is not the process for this layout. */
  readonly gate?: { readonly cwd: string; readonly handedOver: boolean; readonly program?: string };
  readonly handover: { readonly appRoot: string; readonly localEntry?: string };
  /** cwd for the installed entry's own decisions; undefined — the installed command is
   *  not the process for this layout. */
  readonly installed?: { readonly cwd: string };
}

/** The MCP launcher's program: its shim two levels up from the deployment. */
const LAUNCHER_PROGRAM = "../../clawwright";

const LAYOUTS: readonly CaseLayout[] = [
  { id: "checkout-root", gate: { cwd: ROOT, handedOver: false }, handover: { appRoot: ROOT }, installed: { cwd: ROOT } },
  { id: "apps-openclaw", gate: { cwd: `${ROOT}/apps/openclaw`, handedOver: true, program: SHIM_PROGRAM }, handover: { appRoot: `${ROOT}/apps/openclaw` } },
  // The bare program resolves its deployment from the cwd; the MCP launcher's program is a path
  // out of the deployment (the checkout gate), which never reads the cwd, so its advice keeps --app.
  { id: "apps-demo-bare", gate: { cwd: `${ROOT}/apps/demo`, handedOver: true, program: "clawwright" }, handover: { appRoot: `${ROOT}/apps/demo` } },
  { id: "apps-demo-launcher", gate: { cwd: `${ROOT}/apps/demo`, handedOver: true, program: LAUNCHER_PROGRAM }, handover: { appRoot: `${ROOT}/apps/demo` } },
  // APPS/<name> typed case: the hand-over's canonicalisation is decided here; whether the
  // handed-over gate process then sees its own cwd as inside is the host path module's case
  // rule, not resolver logic — covered end to end by system-install on Windows.
  { id: "apps-upper", handover: { appRoot: `${ROOT}/APPS/openclaw` } },
  { id: "apps-demo-case", handover: { appRoot: `${ROOT}/apps/demo` } },
  { id: "checkout-subfolder", handover: { appRoot: `${ROOT}/docs` }, installed: { cwd: `${ROOT}/docs` } },
  { id: "checkout-fresh-apps", handover: { appRoot: `${ROOT}/apps/fresh` }, installed: { cwd: `${ROOT}/apps/fresh` } },
  { id: "installed-app", handover: { appRoot: APP }, installed: { cwd: APP } },
  { id: "installed-app-local", handover: { appRoot: APP_LOCAL, localEntry: LOCAL_ENTRY }, installed: { cwd: APP_LOCAL } },
  { id: "stray-checkout-app", handover: { appRoot: STRAY }, installed: { cwd: STRAY } },
  { id: "empty-directory", handover: { appRoot: EMPTY }, installed: { cwd: EMPTY } },
  { id: "nested-app", handover: { appRoot: `${APP}/recipes/sub` }, installed: { cwd: `${APP}/recipes/sub` } },
];

const ARGVS: readonly (readonly string[])[] = [
  [],
  ["help"],
  ["status"],
  ["status", "--help"],
  ["--app", "x", "status"],
  ["--app", "openclaw", "status"],
  ["--app", "demo", "status"],
  ["--app=x", "status"],
  ["--app"],
  ["status", "--app", "x"],
];

const ENVS: readonly (readonly [string, string | undefined])[] = [
  ["none", undefined],
  ["OC_APP=x", "x"],
  ["OC_APP=staging", "staging"],
  // An exported-but-blank variable is an explicit selection (decision O3): refused by name
  // where a deployment is needed, ignored by the commands that answer without one.
  ["OC_APP=<blank>", ""],
];

const PLATFORMS: readonly NodeJS.Platform[] = ["linux", "win32", "darwin"];

const GATE_COMMANDS = checkoutGate().map((command) => command.name);
const gateArguments = (name: string) => checkoutGate().find((command) => command.name === name)?.arguments;
const DEPLOYMENT_COMMANDS = ["status", "bootstrap"];
const VARIADIC_COMMANDS = ["exec"];

/** The installed entry decides on the raw argv: --project-root, init placements and help
 *  requests. OC_APP plays no part here — an installed deployment is the cwd's. */
const INSTALLED_ARGVS: readonly (readonly string[])[] = [
  [],
  ["help"],
  ["status"],
  ["status", "--help"],
  ["init"],
  ["init", "--local"],
  ["init", "--", "--local"],
  ["init", "--help"],
  ["init", "--", "--help"],
  ["--project-root"],
  ["--project-root", APP],
  ["--project-root", "relative/dir"],
  ["frobnicate"],
  ["control-mcp"],
  ["--bogus"],
];
/** The installed gate's own commands: the executor answers them before the app.ts check. */
const INSTALLED_GATE_COMMANDS = installedGate("<app-root>").map((command) => command.name);

/** The launch a hand-over program's spelling classifies as (renderArgument's rule). */
const launchOfProgram = (program: string, cwd: string): Launch => {
  const fs = fakeFs(BASE_FILES, BASE_DIRS);
  const on: Invocation = { program, mode: program === "clawwright" ? "installed" : "checkout", audience: "terminal" };
  const facts: HandoverFacts = { cwd, fs };
  return launchFromHandover(on, facts);
};

/** Host-independent path text: this machine's path module may prefix a drive and prefer
 *  backslashes; the fake world spells everything with forward slashes from /. */
function fakePath(text: string): string {
  return text.replaceAll("\\", "/").replace(/[A-Za-z]:(?=\/)/g, "");
}

/** Group 3 of the advice matrix (design 4.2): the refusals the pure entry decisions build,
 *  on the same fake layouts the matrix itself uses, as advice values — never rendered
 *  strings frozen at build time. A clawwright advice with an empty argv (the bare "run the
 *  gate" pointer) is left out: the matrix's P4 has no command word to check it against.
 *  The builders take the frame as an input (rf6-fix33), so no process-global pinning. */
export function entryRefusalAdvice(): { label: string; advice: Advice }[] {
  const rows: { label: string; advice: Advice }[] = [];
  const push = (label: string, error: UserError | undefined): void => {
    if (error === undefined) return;
    error.advice.forEach((advice, index) => {
      if (advice.kind === "clawwright" && advice.argv.length === 0) return;
      rows.push({ label: index === 0 ? label : `${label} (${index + 1})`, advice });
    });
  };
  push("refusal: missing deployment, nothing available", missingDeploymentReport(true, "demo", `${ROOT}/apps/demo`, [], false));
  push("refusal: missing deployment, others available", missingDeploymentReport(true, "openclaw", `${ROOT}/apps/openclaw`, ["demo", "staging"], false));
  push("refusal: several deployments, none selected", missingDeploymentReport(false, "openclaw", `${ROOT}/apps/openclaw`, ["demo", "staging", "third"], false));
  push("refusal: empty directory without app.ts", missingDeploymentReport(true, "demo", `${ROOT}/apps/demo`, [], true));
  push("refusal: checkout gate command from a subfolder", checkoutSubfolderReport("check", ROOT));
  const fs = fakeFs(BASE_FILES, BASE_DIRS);
  // The installed entry: init inside the checkout, and the not-initialised refusal.
  const inCheckout = resolveInstalledEntry({ cwd: `${ROOT}/docs`, rawArgv: ["init"], platform: "linux", fs, frame: INSTALLED_FRAME });
  if (inCheckout.kind === "refuse") inCheckout.refusals.forEach((refusal) => push("refusal: init inside a Clawwright checkout", refusal));
  const outside = resolveInstalledEntry({ cwd: EMPTY, rawArgv: ["status"], platform: "linux", fs, frame: INSTALLED_FRAME });
  if (outside.kind === "run") {
    const missing = missingAppDecision({
      appRoot: outside.appRoot,
      argv: outside.argv,
      checkout: outside.checkout,
      gateCommandNames: INSTALLED_GATE_COMMANDS,
      deploymentCommands: DEPLOYMENT_COMMANDS,
      frame: INSTALLED_FRAME,
    });
    if (missing.kind === "not-initialised") missing.refusals.forEach((refusal) => push("refusal: not initialised (installed)", refusal));
  }
  const inSubfolder = resolveInstalledEntry({ cwd: `${ROOT}/docs`, rawArgv: ["status"], platform: "linux", fs, frame: INSTALLED_FRAME });
  if (inSubfolder.kind === "run") {
    const missing = missingAppDecision({
      appRoot: inSubfolder.appRoot,
      argv: inSubfolder.argv,
      checkout: inSubfolder.checkout,
      gateCommandNames: INSTALLED_GATE_COMMANDS,
      deploymentCommands: DEPLOYMENT_COMMANDS,
      frame: INSTALLED_FRAME,
    });
    if (missing.kind === "not-initialised") missing.refusals.forEach((refusal) => push("refusal: not initialised (in a checkout)", refusal));
  }
  // The pointers the two unknown-X reporters print (their info line renders this advice).
  rows.push({ label: "pointer: unknown command", advice: command(["help"]) });
  rows.push({ label: "pointer: unknown argument", advice: command(["status", "--help"]) });
  return rows;
}

function gateDecisionLine(input: Parameters<typeof resolveCheckoutEntry>[0], program: string = SHIM_PROGRAM): string {
  const decision = resolveCheckoutEntry(input);
  switch (decision.kind) {
    case "refuse":
      return `refuse: ${decision.refusals.map(refusalLine).join(" | ")}`;
    case "refuse-misplaced-app-flag":
      return "refuse-misplaced-app-flag";
    case "refuse-unknown-command":
      return `refuse-unknown-command ${decision.name}`;
    case "gate-command":
      return `gate-command ${decision.name}${decision.app === undefined ? "" : ` app=${decision.app.name}/${decision.app.selectedBy}`} ${JSON.stringify(decision.args)}`;
    case "help-without-deployment":
      return `help-without-deployment: ${decision.description}`;
    case "run": {
      // The prefix through the real renderer, not a restatement of the rule; the column's
      // frame is set only for its own line, so the traversal's pin survives it.
      const previous = invocation();
      const frame: Invocation = { program, mode: "checkout", audience: "terminal", ...(decision.app === undefined ? {} : { app: decision.app }) };
      setInvocation(frame);
      const prefix = commandLine([]);
      setInvocation(previous);
      return `run app=${decision.appName} fact=${decision.app === undefined ? "-" : decision.app.name}/${decision.app?.selectedBy} argv=${JSON.stringify(decision.argv)} prefix=${prefix}${decision.soleNote === undefined ? "" : ` sole=${decision.soleNote}`}`;
    }
  }
}

function fakeJson(values: readonly string[]): string {
  return JSON.stringify(values.map(fakePath));
}

/** One refusal as deterministic text: the message plus its advice rendered under the
 *  checkout-root invocation, so the line does not depend on the process's own call. */
function refusalLine(error: UserError): string {
  const rendered = error.advice.length === 0
    ? []
    : error.advice.map((entry) => renderAdvice(entry, { program: SHIM_PROGRAM, mode: "checkout", audience: "terminal" }));
  return fakePath(rendered.length === 0 ? error.message : `${error.message} => ${rendered.join(" | ")}`);
}

function installedDecisionLine(decision: InstalledEntryDecision): string {
  switch (decision.kind) {
    case "refuse":
      return `refuse: ${decision.refusals.map(refusalLine).join(" | ")}`;
    case "checkout-types-note":
      return "checkout-types-note";
    case "run":
      return `run appRoot=${fakePath(decision.appRoot)} argv=${fakeJson(decision.argv)} launchArgv=${fakeJson(decision.launchArgv)}` +
        (decision.initializing ? " initializing" : "") +
        (decision.localTypesOnly ? " local-types-only" : "") +
        (decision.ancestor === undefined ? "" : ` ancestor=${fakePath(decision.ancestor)}`) +
        (decision.checkout === undefined ? "" : ` checkout=${fakePath(decision.checkout)}`);
  }
}

function missingDecisionLine(decision: MissingAppDecision): string {
  const detail = (entry: { readonly headline: string; readonly refusals: readonly UserError[] }): string =>
    `${fakePath(entry.headline)} | ${entry.refusals.map(refusalLine).join(" | ")}`;
  switch (decision.kind) {
    case "subfolder-report":
      return `subfolder-report: ${fakePath(decision.headline)} | ${refusalLine(decision.refusal)}`;
    case "help":
      return `help (fallback: ${detail(decision.fallback)})`;
    case "not-initialised":
      return `not-initialised: ${detail(decision)}`;
  }
}

function handoverDecisionLine(input: Parameters<typeof frameworkOwner>[0]): string {
  const decision = frameworkOwner(input);
  switch (decision.kind) {
    case "run-here":
      return "run-here";
    case "spawn":
      return `spawn ${decision.entry === LOCAL_ENTRY ? "local-package" : "checkout-gate"} delegated=${decision.delegated} argv=${JSON.stringify(decision.args).replace(ROOT, "<root>")}`;
    case "refuse-app-value":
      return decision.reason === "missing-app-value"
        ? "refuse-app-value: missing"
        : decision.reason === "invalid-app-value"
          ? `refuse-app-value: invalid --app ${decision.typed}`
          : `refuse-app-value: conflict --app ${decision.typed}`;
  }
}

/** The whole matrix as deterministic text; golden.check.ts compares it with expected/entry-matrix.txt. */
export function renderEntryMatrix(): string {
  const lines: string[] = [
    "// Entry decisions (plan stage 2, invariant I3): resolveCheckoutEntry (gate) where the gate",
    "// is the process, frameworkOwner (installed command hand-over) everywhere, the installed",
    "// entry's own placement decisions (resolveInstalledEntry, plus missingAppDecision where",
    "// app.ts is absent), and the stray app.ts predicate. Fake fs, no processes. Paths are",
    "// fake-root relative.",
    "",
  ];
  for (const platform of PLATFORMS) {
    for (const layout of LAYOUTS) {
      const fs = fakeFs(BASE_FILES, BASE_DIRS, platform === "win32" ? WIN_REAL : {});
      for (const [envLabel, ocApp] of ENVS) {
        for (const argv of ARGVS) {
          const label = `platform=${platform} layout=${layout.id} argv=${argv.length === 0 ? "<none>" : JSON.stringify(argv)} env=${envLabel}`;
          lines.push(`== ${label}`);
          if (layout.gate !== undefined) {
            lines.push(`gate: ${gateDecisionLine({
              root: ROOT,
              cwd: layout.gate.cwd,
              argv,
              ocApp,
              handedOver: layout.gate.handedOver,
              launch: layout.gate.handedOver ? launchOfProgram(layout.gate.program ?? SHIM_PROGRAM, layout.gate.cwd) : undefined,
              handedProgram: layout.gate.program,
              fs,
              gateCommands: GATE_COMMANDS,
              deploymentCommands: DEPLOYMENT_COMMANDS,
              variadicCommands: VARIADIC_COMMANDS,
              deploymentArguments: (name) => gateArguments(name) ?? openclawCommands[name]?.arguments,
            }, layout.gate.program)}`);
          }
          lines.push(`handover: ${handoverDecisionLine({
            self: SELF,
            appRoot: layout.handover.appRoot,
            launchArgv: argv,
            argv,
            handedOver: false,
            platform,
            fs,
            localEntry: layout.handover.localEntry,
          })}`);
          const stray = strayCheckoutApp({ self: SELF, appRoot: layout.handover.appRoot, fs });
          lines.push(`stray: ${stray === undefined ? "none" : `checkout=${fakePath(stray.checkout)}`}`);
        }
      }
    }
  }
  // The installed entry: placement decisions on the raw argv, per layout and platform.
  for (const platform of PLATFORMS) {
    const fs = fakeFs(BASE_FILES, BASE_DIRS, platform === "win32" ? WIN_REAL : {});
    for (const layout of LAYOUTS) {
      if (layout.installed === undefined) continue;
      for (const installedArgv of INSTALLED_ARGVS) {
        const label = `platform=${platform} layout=${layout.id} argv=${installedArgv.length === 0 ? "<none>" : JSON.stringify(installedArgv)}`;
        lines.push(`== installed ${label}`);
        const decision = resolveInstalledEntry({ cwd: layout.installed.cwd, rawArgv: installedArgv, platform, fs, frame: INSTALLED_FRAME });
        lines.push(`installed: ${installedDecisionLine(decision)}`);
        if (decision.kind !== "run") continue;
        if (fs.exists(`${decision.appRoot}/app.ts`)) continue;
        if (INSTALLED_GATE_COMMANDS.includes(installedArgv[0])) continue;
        const missing = missingAppDecision({
          appRoot: decision.appRoot,
          argv: decision.argv,
          checkout: decision.checkout,
          gateCommandNames: INSTALLED_GATE_COMMANDS,
          deploymentCommands: DEPLOYMENT_COMMANDS,
          frame: INSTALLED_FRAME,
        });
        lines.push(`missing: ${missingDecisionLine(missing)}`);
      }
    }
  }
  lines.push(
    "",
    "== o3 empty OC_APP",
    `(a) destroy, empty OC_APP: ${o3GateLine(["destroy"], "")}`,
    `(b) help, empty OC_APP: ${o3GateLine(["help"], "")}`,
    `(b) bare, empty OC_APP: ${o3GateLine([], "")}`,
    `(c) control, unset OC_APP: ${o3GateLine(["destroy"], undefined)}`,
  );
  return `${lines.join("\n")}\n`;
}

/** Every refusal the matrices above yield (gate, installed, missing-app, hand-over), deduped
 *  by structure. surfaces/advice-matrix.check.ts selects the ones whose sentence names a
 *  place and asserts every advice row is spelled from that place, not from wherever the
 *  refusing process stood. The builders take the frame as an input (rf6-fix33). */
export function entryDecisionRefusals(): { label: string; error: UserError }[] {
  const rows: { label: string; error: UserError }[] = [];
  const seen = new Set<string>();
  const push = (label: string, error: UserError | undefined): void => {
    if (error === undefined) return;
    const shape = (advice: Advice): string =>
      `${advice.kind}:${"argv" in advice ? advice.argv.join(" ") : ""}:${"text" in advice ? advice.text : ""}:${"note" in advice ? advice.note ?? "" : ""}:${advice.kind === "clawwright" ? advice.app ?? "" : ""}`;
    const key = `${error.message}\n${error.advice.map(shape).join("|")}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ label, error });
  };
  for (const platform of PLATFORMS) {
    const fs = fakeFs(BASE_FILES, BASE_DIRS, platform === "win32" ? WIN_REAL : {});
    for (const layout of LAYOUTS) {
      for (const [envLabel, ocApp] of ENVS) {
        for (const argv of ARGVS) {
          const label = `${platform} ${layout.id} argv=${argv.length === 0 ? "<none>" : JSON.stringify(argv)} env=${envLabel}`;
          if (layout.gate !== undefined) {
            const decision = resolveCheckoutEntry({
              root: ROOT, cwd: layout.gate.cwd, argv, ocApp,
              handedOver: layout.gate.handedOver,
              launch: layout.gate.handedOver ? launchOfProgram(layout.gate.program ?? SHIM_PROGRAM, layout.gate.cwd) : undefined,
              handedProgram: layout.gate.program,
              fs, gateCommands: GATE_COMMANDS, deploymentCommands: DEPLOYMENT_COMMANDS,
              variadicCommands: VARIADIC_COMMANDS,
              deploymentArguments: (name) => gateArguments(name) ?? openclawCommands[name]?.arguments,
            });
            if (decision.kind === "refuse") decision.refusals.forEach((refusal) => push(`gate ${label}`, refusal));
          }
          const handover = frameworkOwner({
            self: SELF, appRoot: layout.handover.appRoot, launchArgv: argv, argv,
            handedOver: false, platform, fs, localEntry: layout.handover.localEntry,
          });
          if (handover.kind === "refuse-app-value" && handover.reason === "app-conflict") {
            push(`handover ${label}`, appConflictRefusal(handover, INSTALLED_FRAME));
          }
        }
      }
    }
    for (const layout of LAYOUTS) {
      if (layout.installed === undefined) continue;
      for (const installedArgv of INSTALLED_ARGVS) {
        const label = `installed ${platform} ${layout.id} argv=${installedArgv.length === 0 ? "<none>" : JSON.stringify(installedArgv)}`;
        const decision = resolveInstalledEntry({ cwd: layout.installed.cwd, rawArgv: installedArgv, platform, fs, frame: INSTALLED_FRAME });
        if (decision.kind === "refuse") {
          decision.refusals.forEach((refusal) => push(label, refusal));
          continue;
        }
        if (decision.kind !== "run") continue;
        if (fs.exists(`${decision.appRoot}/app.ts`)) continue;
        if (INSTALLED_GATE_COMMANDS.includes(installedArgv[0])) continue;
        const missing = missingAppDecision({
          appRoot: decision.appRoot,
          argv: decision.argv,
          checkout: decision.checkout,
          gateCommandNames: INSTALLED_GATE_COMMANDS,
          deploymentCommands: DEPLOYMENT_COMMANDS,
          frame: INSTALLED_FRAME,
        });
        if (missing.kind === "subfolder-report") push(label, missing.refusal);
        if (missing.kind === "help") missing.fallback.refusals.forEach((refusal) => push(label, refusal));
        if (missing.kind === "not-initialised") missing.refusals.forEach((refusal) => push(label, refusal));
      }
    }
  }
  return rows;
}

/** The gate's inline checkout-root notes (rf6-fix30): the very advice rows the sentences
 *  embed, so the place-naming check asserts them under the same per-column law. The bare
 *  gate pointer carries no command word, so it stays out of the advice-matrix rows (the
 *  same rule entryRefusalAdvice applies). */
export function gateInlineNoteAdvice(): { label: string; advice: Advice }[] {
  return checkoutInlineNotes()
    .filter((advice) => advice.kind !== "clawwright" || advice.argv.length > 0)
    .map((advice, index) => ({ label: `gate inline note (${index + 1})`, advice }));
}

/** The three place-naming refusals as a run of `frame` builds them: the bash shim row's
 *  drop decision reads the frame at build time, as the entries do after bin.ts has
 *  set it — the installed copy keeps the row, the shim copy already is the root spelling
 *  and drops it. */
export function placeNamingRefusals(frame: Frame): { label: string; error: UserError }[] {
  const fs = fakeFs(BASE_FILES, BASE_DIRS);
  const rows: { label: string; error: UserError }[] = [];
  const inCheckout = resolveInstalledEntry({ cwd: `${ROOT}/docs`, rawArgv: ["init"], platform: "linux", fs, frame });
  if (inCheckout.kind === "refuse") {
    inCheckout.refusals.forEach((refusal) => rows.push({ label: "init inside a Clawwright checkout", error: refusal }));
  }
  const inSubfolder = resolveInstalledEntry({ cwd: `${ROOT}/docs`, rawArgv: ["status"], platform: "linux", fs, frame });
  if (inSubfolder.kind === "run") {
    const missing = missingAppDecision({
      appRoot: inSubfolder.appRoot,
      argv: inSubfolder.argv,
      checkout: inSubfolder.checkout,
      gateCommandNames: INSTALLED_GATE_COMMANDS,
      deploymentCommands: DEPLOYMENT_COMMANDS,
      frame,
    });
    if (missing.kind === "not-initialised") {
      missing.refusals.forEach((refusal) => rows.push({ label: "not initialised (in a checkout)", error: refusal }));
    }
  }
  rows.push({ label: "--app conflict", error: appConflictRefusal({ typed: "other", app: "demo" }, frame) });
  return rows;
}

/** Decision O3 as literal expectations, independent of the sweep above: an empty OC_APP is
 *  an explicit selection — refused by name where a deployment is needed (a), answered
 *  without one where not (b), and never the default openclaw (c: unset still picks it,
 *  empty refuses instead). */
function o3GateLine(argv: readonly string[], ocApp: string | undefined): string {
  return gateDecisionLine({
    root: ROOT, cwd: ROOT, argv, ocApp, handedOver: false,
    fs: fakeFs(BASE_FILES, BASE_DIRS),
    gateCommands: GATE_COMMANDS, deploymentCommands: DEPLOYMENT_COMMANDS,
    variadicCommands: VARIADIC_COMMANDS,
    deploymentArguments: (name) => gateArguments(name) ?? openclawCommands[name]?.arguments,
  });
}

/** placeNamingRefusals as the installed command builds them: the root-spelled row and the
 *  bash shim's own, side by side. */
export function installedFrameRefusals(): { label: string; error: UserError }[] {
  return placeNamingRefusals(INSTALLED_FRAME);
}

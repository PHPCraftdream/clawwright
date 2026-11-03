// How this process was invoked, for the commands its messages tell a user to run: the
// monorepo gate and the committed shim use the checkout spelling (SHIM_PROGRAM, frame.ts);
// the system-wide command is plain `clawwright`, where the checkout spelling does not even
// run in cmd.exe or PowerShell. Entry points set the frame once, from the environment or
// their own constructors (frame.ts), before any command runs; the value is read everywhere
// through the accessors, never re-derived from strings.

import { SHIM_PROGRAM, parseLegacyInvokedAs } from "./frame.ts";
export { parseLegacyInvokedAs } from "./frame.ts";
import { frameFromInvocation, handoverOf, type Frame, type HostPlatform } from "./frame.ts";

/** The invocation travels to child gate processes as versioned JSON (see serializeInvocation). */
export const INVOCATION_ENV = "CLAWWRIGHT_INVOCATION";
/** Legacy input: committed shims and launchers written before CLAWWRIGHT_INVOCATION exist in
 *  users' deployments and are read and mapped (parseLegacyInvokedAs); today only the committed-shim
 *  and launcher generators still write it, so older frameworks keep getting right hints. */
export const INVOKED_AS_ENV = "CLAWWRIGHT_INVOKED_AS";

export const INVOCATION_VERSION = 1;

export type InvocationMode = "checkout" | "installed" | "local-package";
export type AppSelection = "cwd" | "flag" | "env" | "sole" | "default";
export type InvocationAudience = "terminal" | "mcp";

export interface InvocationApp {
  readonly name: string;
  readonly selectedBy: AppSelection;
}

export interface Invocation {
  /** What the user actually types: the checkout spelling for the checkout gate and the
   *  committed shims, `clawwright` for the system-wide command — the monorepo MCP launcher
   *  names its shim two levels up, so this is a path, not only one of the two names. */
  readonly program: string;
  readonly mode: InvocationMode;
  readonly app?: InvocationApp;
  readonly audience: InvocationAudience;
}

let current: Invocation | undefined;
let installed: Frame | undefined;

/** The host facts of this process, as the frame constructors want them. msys is false:
 *  the quoting decision and the bash fallback must not depend on the environment a run
 *  inherits (the checks and the golden pin it; MSYSTEM's inheritance is unreliable on
 *  Windows anyway — design risk 3). A producer may pass its own fact instead. */
export function frameFacts(): { host: HostPlatform; msys: boolean; cwd: string } {
  return {
    host: process.platform === "win32" ? "win32" : "posix",
    msys: false,
    cwd: process.cwd(),
  };
}

/** Installs a frame built through frame.ts's constructors: the entry's one install. The
 *  v1 Invocation children read is derived from it (handoverOf). */
export function installFrame(frame: Frame): void {
  installed = frame;
  current = handoverOf(frame);
}

/** The frame this run is, derived from the invocation when only that was set. */
export function currentFrame(): Frame {
  return installed ??= frameFromInvocation(invocation(), frameFacts());
}

/** The whole installed frame for render defaults (prose): the entry's install carries the
 *  real roots/places; only the never-installed fallback rebuilds — and it must not cache
 *  that rebuild into `installed`. */
export function invokedFrame(): Frame {
  return installed ?? frameFromInvocation(invocation(), frameFacts());
}

/** The frame an Invocation stands for, without installing it: renderers read the frame of
 *  the invocation they are handed, never the process-global one. */
export function frameOf(on: Invocation): Frame {
  return frameFromInvocation(on, frameFacts());
}

/** The invocation a frame is read back from, for entries that hold a hand-over: the frame
 *  is derived from its spelling, and the value is stored as handed. */
export function setInvocation(value: Invocation): void {
  current = value;
  installed = frameFromInvocation(value, frameFacts());
}

export function invocation(): Invocation {
  return current ??= { program: SHIM_PROGRAM, mode: "checkout", audience: "terminal" };
}

export function serializeInvocation(value: Invocation): string {
  return JSON.stringify({ version: INVOCATION_VERSION, ...value });
}

const MODES: readonly InvocationMode[] = ["checkout", "installed", "local-package"];
const SELECTIONS: readonly AppSelection[] = ["cwd", "flag", "env", "sole", "default"];
const AUDIENCES: readonly InvocationAudience[] = ["terminal", "mcp"];

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strict: malformed JSON, an unknown version, a wrong shape or an extra field reads as
 *  unset — the entry falls back to its own default, and never trusts half a value. */
export function parseInvocation(text: string): Invocation | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!plainObject(parsed)) return undefined;
  const { version, program, mode, app, audience, ...extra } = parsed;
  if (
    version !== INVOCATION_VERSION ||
    typeof program !== "string" || program.trim() === "" ||
    typeof mode !== "string" || !MODES.includes(mode as InvocationMode) ||
    typeof audience !== "string" || !AUDIENCES.includes(audience as InvocationAudience) ||
    Object.keys(extra).length > 0
  ) return undefined;
  // Stored trimmed, like parseLegacyInvokedAs: an untrimmed program renders a broken line.
  const trimmed = program.trim();
  // Producers spell the modes coherently: "installed" is the bare system-wide name, while a
  // `./`-relative program is always a checkout spelling — the committed shim, the monorepo MCP
  // launcher or the local-package copy — never the installed one. Every producer of the variable is held to this by a check that runs each generated text through this parse.
  if (mode === "installed" && (trimmed.startsWith("./") || trimmed.startsWith(".\\"))) return undefined;
  if (app === undefined) return { program: trimmed, mode: mode as InvocationMode, audience: audience as InvocationAudience };
  if (!plainObject(app)) return undefined;
  const { name, selectedBy, ...appExtra } = app;
  if (
    typeof name !== "string" || name.trim() === "" ||
    typeof selectedBy !== "string" || !SELECTIONS.includes(selectedBy as AppSelection) ||
    Object.keys(appExtra).length > 0
  ) return undefined;
  return { program: trimmed, mode: mode as InvocationMode, app: { name: name.trim(), selectedBy: selectedBy as AppSelection }, audience: audience as InvocationAudience };
}

/** Reads the invocation a parent handed over and removes both variables, so descendants
 *  never inherit them. The new variable wins when both are set; a value that fails the
 *  strict parse, or an unset/blank variable pair, reads as unset. */
export function takeInvocationFromEnv(): Invocation | undefined {
  const handed = process.env[INVOCATION_ENV];
  const legacy = process.env[INVOKED_AS_ENV];
  delete process.env[INVOCATION_ENV];
  delete process.env[INVOKED_AS_ENV];
  if (handed !== undefined && handed.trim() !== "") {
    const parsed = parseInvocation(handed);
    if (parsed !== undefined) return parsed;
  }
  return parseLegacyInvokedAs(legacy ?? "");
}

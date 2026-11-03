import { readlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Context } from "../../core/context.ts";

const execFileAsync = promisify(execFile);

/** Injectable for probe-level checks: the real defaults call the OS. */
export const probeSeams = {
  run: (cmd: string, args: string[], opts: { timeout?: number; windowsHide?: boolean }): Promise<{ stdout: string }> =>
    execFileAsync(cmd, args, opts),
  readText: (path: string) => readFile(path, "utf8"),
  platform: () => process.platform,
};

// Whether a pid this framework recorded is still the process that recorded it — shared here
// since every pid clawwright writes into a lock/guard file is this tool's own process.pid,
// wherever it runs. `process.pid`/`process.kill()` always mean the machine actually running
// `clawwright`, never a WSL/SSH target reached through a transport — checking liveness THROUGH
// the transport would compare the wrong two things and call every cross-transport lock
// "foreign" forever.

/** Host name plus the pid space its pids belong to. Windows Node and a WSL distro's Node on
 *  the same PC share a host name but not pids: without the scope, one side's live pid reads
 *  as ESRCH ("dead") to the other, and a sweep would remove a live run's files. */
export function machineName(): string {
  return `${process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? hostname()}:${pidScope()}`;
}

function pidScope(): string {
  if (process.platform !== "linux") return process.platform;
  try {
    // "pid:[4026531836]" — distinct per pid namespace (each WSL distro, each container).
    return `linux-${/\d+/.exec(readlinkSync("/proc/self/ns/pid"))?.[0] ?? "unknown"}`;
  } catch {
    return "linux-unknown";
  }
}

/** This process's own approximate start time, wall-clock ISO — recorded beside a pid so a
 *  later reader can tell a genuinely surviving process from an unrelated one the OS handed
 *  the same pid after the original exited. Derived from process.uptime(), accurate to a few
 *  milliseconds — enough to catch a reused pid. */
export function ownProcessStartedAt(): string {
  return new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();
}

/** WMIC's DMTF wall clock has an explicit signed UTC offset in minutes. Only a single, complete
 *  `<key>=` value proves a birth time; wildcards or partial output prove nothing. */
export function parseWindowsProcessStartedAt(stdout: string, key = "CreationDate"): string | undefined {
  const values = stdout.split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line.startsWith(`${key}=`));
  if (values.length !== 1) return undefined;
  const match = new RegExp(`^${key}=(\\d{4})(\\d{2})(\\d{2})(\\d{2})(\\d{2})(\\d{2})\\.(\\d{6})([+-])(\\d{3})$`).exec(values[0]!);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millis = Math.floor(Number(match[7]) / 1000);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31 ||
      hour > 23 || minute > 59 || second > 59) return undefined;
  // setUTCFullYear avoids Date.UTC's special interpretation of years 00 through 99.
  const wall = new Date(0);
  wall.setUTCFullYear(year, month - 1, day);
  wall.setUTCHours(hour, minute, second, millis);
  if (wall.getUTCFullYear() !== year || wall.getUTCMonth() !== month - 1 ||
      wall.getUTCDate() !== day) return undefined;
  const offsetMinutes = Number(match[9]) * (match[8] === "+" ? 1 : -1);
  return new Date(wall.getTime() - offsetMinutes * 60_000).toISOString();
}

/** Best-effort: when the process currently holding `pid` on this machine actually started,
 *  used only to catch pid reuse. Undefined when the platform tool is unavailable or its
 *  output cannot be parsed — the caller must then fall back to treating the process as alive
 *  rather than risk calling a live one dead. Left un-seamed: it predates probeSeams and has
 *  no probe-level check of its own. */
async function queryProcessStartedAt(pid: number): Promise<string | undefined> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("wmic", ["process", "where", `ProcessId=${pid}`, "get", "CreationDate", "/value"]);
      return parseWindowsProcessStartedAt(stdout);
    }
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)]);
    const parsed = Date.parse(stdout.trim());
    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
  } catch {
    return undefined;
  }
}

/** Shared bound for the Windows probes below: a hung powershell/wmic must not stall a lock
 *  decision, and the console window must not flash on desktop runs. */
const BOUNDED = { timeout: 10_000, windowsHide: true } as const;

/** Whole-second ISO in UTC — the canonical boot identity spelling. Rejects calendar
 *  impossibilities (Feb 30) via the round trip, not just the shape. */
const WHOLE_SECOND_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function wholeSecondIso(iso: string): string | undefined {
  if (!Number.isFinite(Date.parse(iso))) return undefined;
  const v = new Date(iso).toISOString().slice(0, 19) + "Z";
  // The input itself must already name that second: a normalized impossible date (Feb 30 ->
  // Mar 2) is a different instant, never a trusted key.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(iso) && iso.slice(0, 19) + "Z" !== v) return undefined;
  return WHOLE_SECOND_ISO.test(v) && new Date(v).toISOString().slice(0, 19) + "Z" === v ? v : undefined;
}

/** A native answer only when its key has the strict per-source form; otherwise no identity. */
function nativeAnswer(startedAt: string | undefined, prefix: "tick" | "win" | "mac", value: string | undefined): ProcessStartIdentity | undefined {
  if (value === undefined) return undefined;
  if (prefix === "tick" ? !/^[1-9][0-9]{0,15}$/.test(value) : !WHOLE_SECOND_ISO.test(value)) return undefined;
  return { startedAt, key: `${prefix}:${value}`, source: "native" };
}

/** The boot this process runs in, as one canonical `linux:<uuid>` / `win:<iso>` / `mac:<iso>`
 *  id. Linux/WSL reads /proc/sys/kernel/random/boot_id; Windows prefers the OS boot time via
 *  CIM (wmic as fallback); macOS uses kern.boottime. Undefined when the platform cannot answer
 *  — a caller must never read undefined as "a different boot".
 *
 *  A recorded host equal to machineName() already proves same machine AND same pid namespace
 *  (machineName() encodes `:linux-<ns>`); this adds only WHICH boot, the one thing a host
 *  match cannot prove. */
const BOOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Invariant per process run: the boot never changes, and this process's own native start
// identity never changes. Memoize successes only — a transient probe failure (e.g. powershell
// busy) must stay retryable, and an "approximate" fallback must be re-probed.
let cachedBootIdentity: string | undefined;
let cachedSelfStartIdentity: ProcessStartIdentity | undefined;

async function probeBootIdentity(): Promise<string | undefined> {
  if (probeSeams.platform() === "linux") {
    const bootId = (await probeSeams.readText("/proc/sys/kernel/random/boot_id")).trim().toLowerCase();
    return BOOT_ID_PATTERN.test(bootId) ? `linux:${bootId}` : undefined;
  }
    if (probeSeams.platform() === "win32") {
      try {
        const { stdout } = await probeSeams.run("powershell", ["-NoProfile", "-Command",
          "((Get-CimInstance Win32_OperatingSystem).LastBootUpTime).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')"], BOUNDED);
        const v = stdout.trim();
        if (WHOLE_SECOND_ISO.test(v) && Number.isFinite(Date.parse(v)) &&
            new Date(v).toISOString().slice(0, 19) + "Z" === v) return `win:${v}`;
      } catch { /* fall through to wmic */ }
      const { stdout } = await probeSeams.run("wmic", ["os", "get", "LastBootUpTime", "/value"], BOUNDED);
      const iso = parseWindowsProcessStartedAt(stdout, "LastBootUpTime");
      if (iso === undefined) return undefined;
      const v = wholeSecondIso(iso);
      return v === undefined ? undefined : `win:${v}`;
    }
    if (probeSeams.platform() === "darwin") {
      const { stdout } = await probeSeams.run("sysctl", ["-n", "kern.boottime"], BOUNDED);
      const match = /\{\s*sec\s*=\s*(\d+)/.exec(stdout);
      if (match === null) return undefined;
      const v = wholeSecondIso(new Date(Number(match[1]) * 1000).toISOString());
      return v === undefined ? undefined : `mac:${v}`;
    }
    return undefined;
}

/** Success-only memoization: undefined (transient failure) stays retryable. */
async function queryBootIdentity(): Promise<string | undefined> {
  if (cachedBootIdentity === undefined) {
    try { cachedBootIdentity = await probeBootIdentity(); } catch { /* retry next call */ }
  }
  return cachedBootIdentity;
}

/** What the platform itself says about when the process now holding `pid` started. `key` is
 *  the native identity when the platform gives one; `source: "approximate"` means only the
 *  uptime fallback answered, so callers must apply the start-time tolerance. `startedAt` is
 *  absent on a foreign-pid Linux answer (the tick key is native, no wall time is); on the
 *  approximate source it is only ever this querying process's own start time, so it exists
 *  ONLY for the current process's own pid. Never throws: a failed probe for ANOTHER pid
 *  returns undefined — an approximate answer would be our own start time, which can never
 *  prove that pid dead. Only the current process's own pid gets the approximate fallback,
 *  at claim time. */
export interface ProcessStartIdentity {
  readonly startedAt?: string;
  readonly key?: string;
  readonly source: "native" | "approximate";
}

async function queryProcessStartIdentity(pid: number): Promise<ProcessStartIdentity | undefined> {
  // This process's own native start identity cannot change while it runs — cache it. Only a
  // "native" answer is cached: "approximate" (uptime-based) may still improve, so re-probe.
  if (pid === process.pid && cachedSelfStartIdentity !== undefined) return cachedSelfStartIdentity;
  const result = await queryProcessStartIdentityUncached(pid);
  if (result !== undefined) {
    if (pid === process.pid && result.source === "native") cachedSelfStartIdentity = result;
    return result;
  }
  // A failed probe for ANOTHER pid is no identity at all — an approximate answer would be
  // the querying process's own start time, which can never prove that pid dead.
  if (pid !== process.pid) return undefined;
  return { startedAt: ownProcessStartedAt(), source: "approximate" };
}

async function queryProcessStartIdentityUncached(pid: number): Promise<ProcessStartIdentity | undefined> {
  try {
    if (probeSeams.platform() === "linux") {
      // lastIndexOf(")") guards a comm field containing spaces; starttime is field 22,
      // i.e. index 19 after comm.
      const raw = await probeSeams.readText(`/proc/${pid}/stat`);
      const close = raw.lastIndexOf(")");
      const fields = raw.slice(close + 2).split(" ");
      const ticks = fields[19];
      if (close > 0 && ticks !== undefined) {
        // No wall time exists for a foreign pid from ticks alone; own pid knows its own.
        const startedAt = pid === process.pid ? ownProcessStartedAt() : undefined;
        return nativeAnswer(startedAt, "tick", ticks);
      }
    } else if (probeSeams.platform() === "win32") {
      try {
        const { stdout } = await probeSeams.run("powershell", ["-NoProfile", "-Command",
          `((Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')`],
        BOUNDED);
        const v = stdout.trim();
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v))) {
          return nativeAnswer(v, "win", wholeSecondIso(v));
        }
      } catch { /* fall through to wmic */ }
      const { stdout } = await probeSeams.run("wmic", ["process", "where", `ProcessId=${pid}`, "get", "CreationDate", "/value"], BOUNDED);
      const iso = parseWindowsProcessStartedAt(stdout);
      if (iso !== undefined) return nativeAnswer(iso, "win", wholeSecondIso(iso));
    } else {
      const { stdout } = await probeSeams.run("ps", ["-o", "lstart=", "-p", String(pid)], BOUNDED);
      const parsed = Date.parse(stdout.trim());
      if (!Number.isNaN(parsed)) {
        const iso = new Date(parsed).toISOString();
        return nativeAnswer(iso, "mac", wholeSecondIso(iso));
      }
    }
  } catch { /* a failed probe proves nothing — undefined below */ }
  return undefined;
}

/** Swappable for checks: spawning a real child process to answer "when did this start" is
 *  exactly what a unit check must not do to stay deterministic and fast. */
export const platformProbes = {
  processStartedAt: queryProcessStartedAt,
  bootIdentity: queryBootIdentity,
  processStartIdentity: queryProcessStartIdentity,
};

export type Liveness = "alive" | "dead" | "unknown";

export interface LocalProcessRecord {
  readonly pid: number;
  readonly machine: string;
  /** This process's own start time when recorded — absent for a record written before this
   *  field existed, or where recording it was not worth the write. */
  readonly startedAt?: string;
}

/** The recorded start comes from process.uptime(), which counts from after Node's own boot, and
 *  the OS probe has 1 s resolution: under load the two differ by seconds for the SAME process.
 *  Wide on purpose — a live owner called dead loses its state, a reused pid called alive only
 *  keeps a lock a human can break. Windows reuses pids within seconds, so no tolerance separates
 *  reuse from jitter perfectly; 15 s keeps the common live case safe at the cost of holding a
 *  stale lock a little longer. */
export const START_TIME_TOLERANCE_MS = 15_000;

/** "unknown" means: do not assume anything — a different machine's pid can't be signalled
 *  from here, and a probe error other than "no such process" proves nothing either way. A
 *  caller must never treat "unknown" as "dead"; only a human breaking the lock decides that. */
export async function localLiveness(record: LocalProcessRecord): Promise<Liveness> {
  if (record.machine !== machineName()) return "unknown";
  let exists: boolean;
  try {
    process.kill(record.pid, 0);
    exists = true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    if (code === "EPERM") exists = true;
    else return "unknown";
  }
  if (!exists) return "dead";
  if (record.startedAt === undefined) return "alive";
  // Reused pid: a different process now holds this number. Only treated as dead when the
  // actual start time was obtained AND clearly disagrees — never on a probe failure, which
  // falls back to "alive" rather than risk calling a live process dead.
  const actual = await platformProbes.processStartedAt(record.pid);
  if (actual === undefined) return "alive";
  const drift = Math.abs(Date.parse(actual) - Date.parse(record.startedAt));
  return Number.isNaN(drift) || drift <= START_TIME_TOLERANCE_MS ? "alive" : "dead";
}

/** Removes only an empty directory; another owner's contents must survive. Shared by the
 *  instance lock and the mutation guard, whose cleanup paths both need exactly this. */
export async function removeEmptyDirectory(ctx: Context, path: string): Promise<void> {
  if (ctx.transport.removeEmptyDir !== undefined) {
    await ctx.transport.removeEmptyDir(path).catch(() => {});
    return;
  }
  await ctx.transport.exec("rmdir", [path], { allowFailure: true });
}

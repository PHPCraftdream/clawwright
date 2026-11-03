// Read-only target prerequisites for bootstrap --check and startup port preflight.
// check.ts owns the prerequisite report format and exit-code contract.
//
// PREREQ_PROBES is the whole list, one line per entry on purpose — a new probe is exactly one
// more line there, not a second run loop.

import { TransportUnreachableError } from "../../../runtime/transport/transport.ts";
import type { ExecResult } from "../../../runtime/transport/transport.ts";
import { die, warn as logWarn, regexEscape } from "../../../core/io/log.ts";
import { commandLine } from "../../../core/io/invocation/render.ts";
import { parseDfAvailableKb } from "../../operate/watch/health.ts";
import type { Context } from "../../../core/context.ts";

/** Whether `address:port` (or a wildcard bind covering it) already appears in a `ss`/`netstat`
 *  listening-socket listing. Matched loosely against just the local-address column, ending
 *  in ":<port>" — both tools' exact layout and spacing vary by version. */
function listeningLine(output: string, address: string, port: string): string | undefined {
  const pattern = new RegExp(`(?:^|\\s)(?:\\*|0\\.0\\.0\\.0|::|\\[::\\]|${regexEscape(address)}):${port}(?:\\s|$)`);
  return output.split("\n").find((line) => pattern.test(line))?.trim();
}

/** `ss -ltnH` (falling back to `netstat -ltn` where `ss` is not installed) against the
 *  target. Docker's own publish list (portConflict, below) only sees what IT bound, so a
 *  bare process already holding the address:port fails compose deep inside `up` with
 *  nothing but a bind error naming the port — same failure a second deployment's container
 *  causes, from a listener this framework never considered. Absence of both tools is
 *  reported as "unavailable", never silently read as "free": a target this can never check
 *  must say so, not proceed as if it had. */
export async function listeningPortHolder(ctx: Context, address: string, port: string): Promise<string | "unavailable" | undefined> {
  for (const [command, args] of [
    ["ss", ["-ltnH"]],
    ["netstat", ["-ltn"]],
  ] satisfies [string, string[]][]) {
    let result: { code: number; stdout: string } | undefined;
    try {
      result = await ctx.transport.exec(command, args, { allowFailure: true });
    } catch {
      // The tool itself could not even be launched (e.g. a local transport with no such
      // binary on PATH) — same as a nonzero exit below: try the next one.
      result = undefined;
    }
    if (result === undefined || result.code !== 0) continue;
    return listeningLine(result.stdout, address, port);
  }
  return "unavailable";
}

/** Another deployment on the same port fails deep inside compose with a bind error naming
 *  only the port. Said plainly here, before anything is started. */
export async function preflightPort(ctx: Context): Promise<void> {
  const holder = await ctx.runtime.portConflict(ctx.settings.gatewayPort);
  if (holder !== undefined) {
    die(
      `port ${ctx.settings.gatewayPort} is already published by ${holder} — ` +
        "give this deployment its own OPENCLAW_GATEWAY_PORT in .env",
    );
  }

  // Docker's own publish list is the only thing the check above sees. If this deployment's
  // OWN gateway is already running, it legitimately holds the address:port already — an
  // ordinary bootstrap re-run, not a conflict — so the raw listening-socket probe below is
  // skipped rather than refusing an instance against itself.
  if (await ctx.runtime.isRunning()) return;

  const { bindAddress, gatewayPort } = ctx.settings;
  const listener = await listeningPortHolder(ctx, bindAddress, gatewayPort);
  if (listener === "unavailable") {
    logWarn(
      `could not check whether ${bindAddress}:${gatewayPort} is already listening — neither ss nor netstat ` +
        "answered on the target. Proceeding without that check: if compose then fails to bind, something else " +
        "already holds this port.",
    );
    return;
  }
  if (listener !== undefined) {
    die(
      `${bindAddress}:${gatewayPort} is already listening (${listener}) — not through Docker, so the check ` +
        "above never saw it. Give this deployment its own OPENCLAW_GATEWAY_PORT in .env, or stop whatever is " +
        "using this one.\n" +
        "This check and the later bind are not atomic — something else could still take the port in between.",
    );
  }
}

export type PrereqStatus = "ok" | "warn" | "fail";

export interface PrereqResult {
  readonly status: PrereqStatus;
  /** What was checked and, for anything short of ok, what was found. */
  readonly what: string;
  /** What to do about it — absent for ok, since there is nothing to do. */
  readonly next?: string;
}

export interface PrereqProbe {
  readonly run: (ctx: Context) => Promise<PrereqResult>;
}

function ok(what: string): PrereqResult {
  return { status: "ok", what };
}
function warn(what: string, next: string): PrereqResult {
  return { status: "warn", what, next };
}
function fail(what: string, next: string): PrereqResult {
  return { status: "fail", what, next };
}

// Below the free-space threshold, bootstrap can still start but is one log rotation away
// from a full disk; a constant rather than an env var, unlike watch's own OC_WATCH_DISK_MIN_MB
// (health.ts) — that one tunes an ALREADY-running instance's alerting, this one is a one-time
// "is this machine roomy enough to start on" sanity check.
const MIN_FREE_DISK_MB = 5 * 1024;

/** Walks up from `path` to the nearest ancestor that actually exists on the target — the
 *  same boundary datadir.ts's own ancestry resolution walks, kept as its own small copy here
 *  rather than exported from there: that module's version is entangled with the destructive
 *  chown/mkdir it guards, and this one is read-only and must stay that way. A transport that
 *  cannot even answer `exists` for an ancestor stops the walk there rather than guessing
 *  further up. */
async function nearestExistingAncestor(ctx: Context, path: string): Promise<string> {
  let probe = path;
  for (;;) {
    let present: boolean;
    try {
      present = await ctx.transport.exists(probe);
    } catch (error) {
      if (error instanceof TransportUnreachableError) throw error;
      return probe;
    }
    if (present) return probe;
    const parent = probe.slice(0, Math.max(probe.lastIndexOf("/"), 1));
    if (parent === probe) return probe;
    probe = parent;
  }
}

/** The target user's own name and primary group, `id -un`/`id -gn` — read-only, and named
 *  rather than numeric (unlike datadir.ts's fixed uid:gid OWNER, which chown needs as
 *  numbers to match the container) because this line is read by a person deciding whether to
 *  type it, and a name is what they typed to log in. Undefined when either call fails to
 *  answer 0 — the ready line then falls back to a path-only form rather than guessing a name. */
async function targetUserIdentity(ctx: Context): Promise<{ user: string; group: string } | undefined> {
  try {
    const user = await ctx.transport.exec("id", ["-un"], { allowFailure: true });
    if (user.code !== 0) return undefined;
    const group = await ctx.transport.exec("id", ["-gn"], { allowFailure: true });
    if (group.code !== 0) return undefined;
    const userName = user.stdout.trim();
    const groupName = group.stdout.trim();
    return userName === "" || groupName === "" ? undefined : { user: userName, group: groupName };
  } catch (error) {
    if (error instanceof TransportUnreachableError) throw error;
    return undefined;
  }
}

async function readyLine(ctx: Context, path: string): Promise<string> {
  const identity = await targetUserIdentity(ctx);
  return identity === undefined
    ? `sudo install -d ${path}  (then hand it to whoever runs ${commandLine("bootstrap")})`
    : `sudo install -d -o ${identity.user} -g ${identity.group} ${path}`;
}

/** ok when `path` (or, absent that, its nearest existing ancestor) is already writable — the
 *  same "can this be prepared without a password prompt" question sudoFor() (datadir.ts) asks
 *  mid-bootstrap, answered here read-only and without dying, so every directory in the report
 *  gets its own line instead of the report stopping at the first one that needs work. */
async function dirReadinessProbe(ctx: Context, role: string, path: string): Promise<PrereqResult> {
  const nearest = await nearestExistingAncestor(ctx, path);
  const writable = await ctx.transport.exec("test", ["-w", nearest], { allowFailure: true });
  if (writable.code === 0) {
    return ok(nearest === path ? `${role} ${path} is writable` : `${role} ${path} can be created (${nearest} is writable)`);
  }
  return fail(`${role} ${path} needs root to prepare`, await readyLine(ctx, path));
}

/** `docker info`'s exit code and server version, parsed from a plain ExecResult — the pure
 *  half of dockerProbe, fed a canned result by a check. */
export function parseDockerInfo(result: Pick<ExecResult, "code" | "stdout" | "stderr">): PrereqResult {
  if (result.code === 0) {
    const version = result.stdout.trim();
    return ok(`docker daemon is reachable${version === "" ? "" : ` (server ${version})`}`);
  }
  return fail(
    "docker is installed but the daemon did not answer `docker info`",
    "start the Docker daemon (Docker Desktop, or the docker service) on the target",
  );
}

async function dockerProbe(ctx: Context): Promise<PrereqResult> {
  let result: ExecResult;
  try {
    result = await ctx.transport.exec("docker", ["info", "--format", "{{.ServerVersion}}"], { allowFailure: true });
  } catch (error) {
    if (error instanceof TransportUnreachableError) throw error;
    return fail("docker is not on PATH on the target", `install Docker Engine, then re-run ${commandLine(["bootstrap", "--check"])}`);
  }
  return parseDockerInfo(result);
}

/** `docker compose version`'s exit code, parsed the same way parseDockerInfo is. */
export function parseComposeVersion(result: Pick<ExecResult, "code" | "stdout" | "stderr">): PrereqResult {
  if (result.code === 0) {
    const version = result.stdout.trim();
    return ok(`compose v2 is available${version === "" ? "" : ` (${version})`}`);
  }
  return fail(
    "`docker compose version` failed — the compose v2 plugin is missing",
    "install the Docker Compose v2 plugin (docker-compose-plugin)",
  );
}

async function composeProbe(ctx: Context): Promise<PrereqResult> {
  let result: ExecResult;
  try {
    result = await ctx.transport.exec("docker", ["compose", "version"], { allowFailure: true });
  } catch (error) {
    if (error instanceof TransportUnreachableError) throw error;
    return fail("could not run `docker compose version` on the target", "install Docker Engine and the Compose v2 plugin");
  }
  return parseComposeVersion(result);
}

async function portProbe(ctx: Context): Promise<PrereqResult> {
  const { bindAddress, gatewayPort } = ctx.settings;
  const holder = await listeningPortHolder(ctx, bindAddress, gatewayPort);
  if (holder === "unavailable") {
    return warn(
      `could not determine whether ${bindAddress}:${gatewayPort} is free — neither ss nor netstat answered on the target`,
      "bootstrap's own preflight will still catch a conflict when it actually starts",
    );
  }
  if (holder !== undefined) {
    return fail(
      `${bindAddress}:${gatewayPort} is already listening (${holder})`,
      "give this deployment its own OPENCLAW_GATEWAY_PORT in .env, or stop whatever is using it",
    );
  }
  return ok(`gateway port ${gatewayPort} is free`);
}

/** `df -Pk`'s exit code and parsed availability against the threshold — the pure half of
 *  diskProbe. Below the threshold is a warning, never a failure: bootstrap can still start,
 *  it just should not be a surprise when it later cannot. */
export function parseDiskSpace(path: string, result: Pick<ExecResult, "code" | "stdout" | "stderr">, minFreeMb: number): PrereqResult {
  if (result.code !== 0) {
    return warn(`could not determine free disk space at ${path}`, "run df -h on the target and check by hand");
  }
  const availableKb = parseDfAvailableKb(result.stdout);
  if (availableKb === undefined) {
    return warn(`df -Pk ${path} returned output this could not parse`, "run df -h on the target and check by hand");
  }
  const availableMb = availableKb / 1024;
  if (availableMb < minFreeMb) {
    return warn(
      `only ${availableMb.toFixed(0)} MB free at ${path}`,
      `free up space, or point OC_DATA_DIR at a volume with at least ${minFreeMb} MB free`,
    );
  }
  return ok(`${availableMb.toFixed(0)} MB free at ${path}`);
}

async function diskProbe(ctx: Context): Promise<PrereqResult> {
  const nearest = await nearestExistingAncestor(ctx, ctx.settings.dataDir);
  let result: ExecResult;
  try {
    result = await ctx.transport.exec("df", ["-Pk", nearest], { allowFailure: true });
  } catch (error) {
    if (error instanceof TransportUnreachableError) throw error;
    return warn(`could not run df -Pk ${nearest} on the target`, "run df -h on the target and check by hand");
  }
  return parseDiskSpace(nearest, result, MIN_FREE_DISK_MB);
}

// --- GNU userland capabilities ---------------------------------------------------------------
// Target-side commands this framework runs (find -printf, stat -c, readlink -f, sha256sum,
// tar --numeric-owner, /proc) are GNU/Linux-specific. A reachable WSL/ssh target can still run
// BusyBox or BSD userland — passes `docker info`/`df` fine, then fails mid-mutation on the
// first GNU-only flag. This probe catches that here, read-only (inspects only, never writes),
// run over stdin (`sh -s`) so wsl.exe cannot re-parse it as a `-c` command line.
//
// Mirrors service/inspection.ts's TARGET_NOT_GNU code but is not threaded through
// gatherInspection: a target's userland does not change between calls, so paying a round trip
// on every doctor/plan/inspect would buy nothing — `bootstrap --check` is the one place it runs.
export const GNU_USERLAND_PROBE_SCRIPT = `
find /tmp -maxdepth 0 -printf '' >/dev/null 2>&1 && echo find-printf=ok || echo find-printf=missing
stat -c %s / >/dev/null 2>&1 && echo stat-c=ok || echo stat-c=missing
readlink -f / >/dev/null 2>&1 && echo readlink-f=ok || echo readlink-f=missing
printf x | sha256sum >/dev/null 2>&1 && echo sha256sum=ok || echo sha256sum=missing
{ tar --numeric-owner --help >/dev/null 2>&1 || tar --version 2>/dev/null | grep -q GNU; } && echo tar-numeric-owner=ok || echo tar-numeric-owner=missing
test -r /proc/self/stat && echo proc=ok || echo proc=missing
`;

type GnuCapability = "find-printf" | "stat-c" | "readlink-f" | "sha256sum" | "tar-numeric-owner" | "proc";

const GNU_CAPABILITY_ORDER: readonly GnuCapability[] = [
  "find-printf",
  "stat-c",
  "readlink-f",
  "sha256sum",
  "tar-numeric-owner",
  "proc",
];

// What each (non-/proc) capability is named for a reader and the package that provides it,
// grouped so "stat -c" and "readlink -f" (both coreutils) collapse into one install line
// instead of naming coreutils twice.
const GNU_CAPABILITY_TOOL: Record<Exclude<GnuCapability, "proc">, { readonly tool: string; readonly pkg: string }> = {
  "find-printf": { tool: "find -printf (findutils)", pkg: "findutils" },
  "stat-c": { tool: "stat -c (coreutils)", pkg: "coreutils" },
  "readlink-f": { tool: "readlink -f (coreutils)", pkg: "coreutils" },
  "sha256sum": { tool: "sha256sum (coreutils)", pkg: "coreutils" },
  "tar-numeric-owner": { tool: "tar --numeric-owner", pkg: "tar" },
};

/** Parses the probe script's own `capability=ok`/`capability=missing` lines — the pure half of
 *  gnuUserlandProbe, fed a canned ExecResult by a check. A line this cannot recognize is
 *  ignored rather than misread; a capability with no recognized line for it at all is treated
 *  the same as an explicit `=missing` — a target that did not say ok gets no benefit of the
 *  doubt. Every capability unreported (empty stdout, a shell that answered nothing) is not the
 *  same claim as every capability missing, so that case warns instead of failing outright. */
export function parseGnuUserlandCheck(result: Pick<ExecResult, "code" | "stdout" | "stderr">): PrereqResult {
  const reported = new Map<string, boolean>();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^([a-z0-9-]+)=(ok|missing)$/.exec(line.trim());
    if (match === null) continue;
    reported.set(match[1]!, match[2] === "ok");
  }

  if (reported.size === 0) {
    return warn(
      "could not determine the target's GNU userland capabilities — the probe produced no output",
      `re-run ${commandLine(["bootstrap", "--check"])}; verify a POSIX sh is on the target's PATH`,
    );
  }

  const missing = GNU_CAPABILITY_ORDER.filter((capability) => reported.get(capability) !== true);
  if (missing.length === 0) {
    return ok("target userland has GNU find/stat/readlink/coreutils/tar and /proc");
  }

  // Nothing at all answered ok: this is not a Linux box missing one package, it is very likely
  // not a Linux box at all — the same situation LOCAL_TARGET_UNSUPPORTED (transport.ts) already
  // refuses for a `local` target on the wrong host, now found instead on a reachable WSL/ssh one.
  if (missing.length === GNU_CAPABILITY_ORDER.length) {
    return fail(
      "target lacks a GNU/Linux userland (find -printf, stat -c, readlink -f, sha256sum, tar --numeric-owner, and /proc all missing)",
      "use a Linux target; macOS is only supported as an ssh host",
    );
  }

  const tools = missing.map((capability) => (capability === "proc" ? "/proc" : GNU_CAPABILITY_TOOL[capability].tool));
  const packages = [
    ...new Set(
      missing
        .filter((capability): capability is Exclude<GnuCapability, "proc"> => capability !== "proc")
        .map((capability) => GNU_CAPABILITY_TOOL[capability].pkg),
    ),
  ];
  const steps: string[] = [];
  if (packages.length > 0) {
    steps.push(`install ${packages.join(" ")} — \`apk add ${packages.join(" ")}\` on Alpine, \`apt-get install -y ${packages.join(" ")}\` on Debian/Ubuntu`);
  }
  if (missing.includes("proc")) steps.push("mount /proc, or use a Linux target — macOS is only supported as an ssh host");

  return fail(`target lacks GNU ${tools.join(", ")}`, steps.join("; "));
}

async function gnuUserlandProbe(ctx: Context): Promise<PrereqResult> {
  let result: ExecResult;
  try {
    result = await ctx.transport.exec("sh", ["-s"], { input: GNU_USERLAND_PROBE_SCRIPT, allowFailure: true });
  } catch (error) {
    if (error instanceof TransportUnreachableError) throw error;
    return fail(
      "no POSIX sh on the target to probe GNU userland capabilities",
      "install a POSIX shell (dash, busybox sh, or bash) on the target",
    );
  }
  return parseGnuUserlandCheck(result);
}

/** Every prerequisite `bootstrap --check` reports, in report order. Add one to this list —
 *  nothing else — to add a prerequisite to the report. */
export const PREREQ_PROBES: PrereqProbe[] = [
  { run: dockerProbe },
  { run: composeProbe },
  { run: (ctx) => dirReadinessProbe(ctx, "data directory", ctx.settings.dataDir) },
  { run: (ctx) => dirReadinessProbe(ctx, "backup directory", ctx.settings.backupDir) },
  { run: (ctx) => dirReadinessProbe(ctx, "snapshot directory", ctx.settings.snapshotDir) },
  { run: portProbe },
  { run: diskProbe },
  { run: gnuUserlandProbe },
];

/** Runs every probe in order and collects the results. A TransportUnreachableError from any
 *  one of them is never caught here — check.ts turns it into the same TARGET_UNREACHABLE
 *  finding every other command reports it as, instead of a partial report that pretends the
 *  probes after it still mean something. */
export async function runPrereqProbes(ctx: Context, probes: readonly PrereqProbe[] = PREREQ_PROBES): Promise<PrereqResult[]> {
  const results: PrereqResult[] = [];
  for (const probe of probes) results.push(await probe.run(ctx));
  return results;
}

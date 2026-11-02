// The instance lock's primitives: on-disk holder shape, staleness/aging maths,
// human-readable refusal text, and the directory-claim/takeover/publish steps one
// acquisition goes through. Imports nothing from instance-lock.ts — the reentrancy layer
// (chainLocks/heldScopes) and the HeldLock handle live there and import these instead,
// re-exporting the ones callers use so instance-lock.ts stays every consumer's import path.

import { commandLine } from "../../core/io/invocation/render.ts";
import { manual, type Advice } from "../../core/io/invocation/advice.ts";
import { randomBytes } from "node:crypto";

import { locksDir } from "../../core/env.ts";
import { log, die } from "../../core/io/log.ts";
import { machineName, localLiveness, ownProcessStartedAt, removeEmptyDirectory, platformProbes, START_TIME_TOLERANCE_MS, type ProcessStartIdentity } from "./process-identity.ts";
import type { Context } from "../../core/context.ts";

/** Legacy fallback: judges staleness for a holder with no `heartbeatAt` (pre-field record).
 *  Anything newer is judged by HEARTBEAT_STALE_AFTER_MS instead (isStale below), since
 *  `recipe install` legitimately holds the lock across a build that outlives this. */
export const STALE_AFTER_MS = 30 * 60 * 1000;

/** A holder with a heartbeat this old has stopped refreshing, not merely running long. Far
 *  above HEARTBEAT_INTERVAL_MS so a few missed writes aren't mistaken for a dead holder. */
export const HEARTBEAT_STALE_AFTER_MS = 10 * 60 * 1000;

export interface LockHolder {
  readonly operationId: string;
  /** What the holder is doing: "apply", "rollback", "provision-agent example-recipe". */
  readonly what: string;
  /** Best effort, for a human reading a refusal: the machine and process that took it. */
  readonly by: string;
  readonly takenAt: string;
  /** Which acquisition of the lock directory this record belongs to. Absent on a legacy
   *  holder, whose immutable owner identity must match instead. */
  readonly generation?: string;
  /** This host's identity (machineName()). `pid` is only askable against THIS machine's
   *  process table when `host` matches — every recorded pid is the CLI's own, never a
   *  WSL/SSH transport target's. */
  readonly host?: string;
  /** The acquiring process's own pid. */
  readonly pid?: number;
  /** Approximate start time, recorded to catch pid reuse. */
  readonly startedAt?: string;
  /** Native owner-start identity when the platform gives one ("tick:<n>" / "win:<iso>" /
   *  "mac:<iso>"); absent on approximate records and legacy records. */
  readonly startKey?: string;
  /** Whether `startedAt` came from the platform's own process record ("native") or the
   *  uptime approximation ("approximate"). */
  readonly startSource?: "native" | "approximate";
  /** This boot's identity (platformProbes.bootIdentity()), recorded at acquisition. Absent on
   *  records written before this field existed; those never qualify for automatic takeover.
   *  Optional so an old reader still parses a new record, and a new reader refuses an old one. */
  readonly bootId?: string;
  /** Last time the holder proved it is alive, refreshed on interval, set at acquisition too.
   *  Absent on a legacy record; isStale() then falls back to `takenAt`. */
  readonly heartbeatAt?: string;
}

/** Public owner facts only; historical pids have no known PID namespace. */
export interface LockOwnerIdentity {
  readonly identitySource: "structured" | "legacy-by";
  readonly host: string;
  readonly pid: number;
  readonly startedAt?: string;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function safePhysicalHost(value: string): boolean {
  return value.length <= 160 && value.split(".").every((label) =>
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label));
}

function containsUnsafeIdentityText(text: string, includeSpace: boolean): boolean {
  return [...text].some((char) => {
    const code = char.charCodeAt(0);
    return code <= (includeSpace ? 32 : 31) || (code >= 127 && code <= 159);
  });
}

function safeOwnerHost(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 160 || containsUnsafeIdentityText(value, true)) return false;
  const ownerHost = /^([^:]+)(?::(?:win32|darwin|aix|android|freebsd|openbsd|netbsd|sunos|cygwin|haiku|linux-(?:[1-9][0-9]*|unknown)))?$/.exec(value);
  return ownerHost !== null && safePhysicalHost(ownerHost[1]!);
}

/** Exact bounded historical spelling, not a general-purpose display-string parser. */
function historicalByIdentity(value: unknown): LockOwnerIdentity | undefined {
  if (typeof value !== "string" || value.length > 256 || containsUnsafeIdentityText(value, false)) return undefined;
  const match = /^([a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63})@([a-zA-Z0-9.-]{1,160}) pid ([1-9][0-9]{0,15})$/.exec(value);
  if (match === null || match[0] !== value || !safePhysicalHost(match[2]!)) return undefined;
  const pid = Number(match[3]);
  return Number.isSafeInteger(pid) ? { identitySource: "legacy-by", host: match[2]!, pid } : undefined;
}

/** One reader for observation, refusal and takeover. Presence is not truthiness: explicit
 *  null/undefined structured fields never fall back to a historical display string. */
export function readLockOwnerIdentity(value: unknown): LockOwnerIdentity | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const holder = value as LockHolder;
  if (typeof holder.operationId !== "string" || holder.operationId.trim().length === 0 || !validTimestamp(holder.takenAt)) return undefined;
  const structured = ["host", "pid", "startedAt", "heartbeatAt", "generation"].some((key) => Object.hasOwn(holder, key));
  if (!structured) return historicalByIdentity(holder.by);
  if (!Object.hasOwn(holder, "host") || !Object.hasOwn(holder, "pid") ||
      !safeOwnerHost(holder.host) || !Number.isSafeInteger(holder.pid) || (holder.pid ?? 0) <= 0 ||
      (Object.hasOwn(holder, "startedAt") && !validTimestamp(holder.startedAt)) ||
      (Object.hasOwn(holder, "heartbeatAt") && !validTimestamp(holder.heartbeatAt)) ||
      (Object.hasOwn(holder, "generation") && !validGeneration(holder.generation)) ||
      (Object.hasOwn(holder, "startKey") && !validStartKey(holder.startKey)) ||
      (Object.hasOwn(holder, "startSource") &&
        holder.startSource !== "native" && holder.startSource !== "approximate")) return undefined;
  // Historical by cannot accompany a modern generation or contradict structured identity.
  // Modern :scope display strings do not match the historical grammar.
  const historical = historicalByIdentity(holder.by);
  if (historical !== undefined && (Object.hasOwn(holder, "generation") ||
      historical.host !== holder.host || historical.pid !== holder.pid)) return undefined;
  return { identitySource: "structured", host: holder.host, pid: holder.pid!, startedAt: holder.startedAt };
}

/** A physical hostname alone is never enough to select our process table. */
export function isLocalLockOwner(identity: LockOwnerIdentity): boolean {
  return identity.identitySource === "structured" && identity.host.includes(":") &&
    !identity.host.endsWith(":linux-unknown") && identity.host === machineName();
}

export function legacyByOwnerAdvice(host: string, breakLockSupported = true): string {
  return `Historical owner PID namespace is unknown; verify the owner in its ORIGINAL PID namespace first. Candidate host/PID metadata is not proof of death or authorization; ${breakLockSupported
    ? `then explicitly rerun the intended operation with --break-lock and exact --break-foreign-lock '${host}' confirmation`
    : "this command does not accept --break-lock; choose an intended operation supporting exact foreign-owner confirmation"}.`;
}

/** Only a validated, scoped local identity can be signalled here. */
function isProvablyDeadHere(holder: LockHolder): boolean {
  const identity = readLockOwnerIdentity(holder);
  if (identity === undefined || !isLocalLockOwner(identity)) return false;
  try {
    process.kill(identity.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** One canonical boot-id form per source: `linux:<uuid>` (strict lowercase) or
 *  `win:<iso>` / `mac:<iso>` (whole-second UTC). A record whose bootId fails this validation
 *  is NOT proof of anything and refuses exactly as before. */
const BOOT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BOOT_TIME = /^(win|mac):(20\d{2}|[1-9]\d{3})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\dZ$/;

function validBootId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.startsWith("linux:")) return BOOT_UUID.test(value.slice(6));
  const time = BOOT_TIME.exec(value);
  return time !== null && Number.isFinite(Date.parse(value.slice(4))) &&
    new Date(value.slice(4)).toISOString().slice(0, 19) + "Z" === value.slice(4);
}

const START_TICK_KEY = /^tick:[1-9][0-9]{0,15}$/;

function validStartKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (START_TICK_KEY.test(value)) return true;
  const time = BOOT_TIME.exec(value);            // BOOT_TIME already pins win|mac + whole-second shape
  return time !== null && Number.isFinite(Date.parse(value.slice(4))) &&
    new Date(value.slice(4)).toISOString().slice(0, 19) + "Z" === value.slice(4);
}

const SOURCE_PREFIX = /^([a-z]+):/;

function bootSource(id: string): string { return SOURCE_PREFIX.exec(id)?.[1] ?? id; }

function keySource(id: string): string { return SOURCE_PREFIX.exec(id)?.[1] ?? id; }

export interface DeathProof {
  readonly proven: boolean;
  readonly reason?: "rebooted" | "process-gone" | "pid-reused";
}

/** Proof requires the recorded boot to differ (the machine rebooted since the claim) or, on the
 *  same boot, the pid to be gone or its start time to disagree (pid reuse); anything less keeps
 *  today's refusal. Never kills or signals anything beyond the permission-check `kill(pid, 0)`
 *  already used for liveness. */
export async function proveOwnerDead(holder: LockHolder): Promise<DeathProof> {
  // Host match proves same machine AND same pid namespace — machineName() already encodes
  // `:linux-<ns>`; platforms without namespaces have none to mismatch.
  const identity = readLockOwnerIdentity(holder);
  if (identity === undefined || !isLocalLockOwner(identity)) return { proven: false };
  // Legacy/partial record: exactly today's refusal.
  if (!validTimestamp(holder.startedAt) || !validBootId(holder.bootId)) return { proven: false };
  // Probe failure never proves death.
  const currentBoot = await platformProbes.bootIdentity();
  if (currentBoot === undefined) return { proven: false };
  // Only same-source boot identities may be compared; never across linux/win/mac.
  if (bootSource(currentBoot) !== bootSource(holder.bootId!)) return { proven: false };
  if (currentBoot !== holder.bootId) return { proven: true, reason: "rebooted" };
  try {
    process.kill(identity.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? { proven: true, reason: "process-gone" } : { proven: false };
  }
  // Pid exists: its start identity disagreeing with the record means a reused pid. Doubt —
  // a failed probe, a malformed record, sources that cannot be compared — is never proof.
  const actual = await platformProbes.processStartIdentity(identity.pid);
  if (holder.startKey !== undefined) {
    // A native record may only be settled by a native answer on BOTH sides; a malformed
    // record key is doubt, never a fall back to the approximate comparison.
    if (holder.startSource !== "native" || !validStartKey(holder.startKey)) return { proven: false };
    if (actual === undefined || actual.source !== "native" || actual.key === undefined || !validStartKey(actual.key)) return { proven: false };
    if (keySource(holder.startKey) !== keySource(actual.key)) return { proven: false };
    return holder.startKey === actual.key ? { proven: false } : { proven: true, reason: "pid-reused" };
  }
  // No native key on record: a native answer about the pid alone cannot be compared with an
  // approximate record — native on one side only is not proof. Without an owner start
  // identity at all, proof is impossible → refuse.
  if (holder.startSource !== "approximate") return { proven: false };
  if (actual === undefined || actual.source !== "approximate" || actual.key !== undefined || actual.startedAt === undefined) return { proven: false };
  // Both sides explicitly approximate: the 15 s tolerance stays.
  const drift = Math.abs(Date.parse(actual.startedAt) - Date.parse(holder.startedAt!));
  return Number.isNaN(drift) || drift <= START_TIME_TOLERANCE_MS ? { proven: false } : { proven: true, reason: "pid-reused" };
}

/** The lock itself is a DIRECTORY: `mkdir` on an existing path fails atomically on every
 *  POSIX filesystem, works through wsl.exe and ssh too. Must be a plain `mkdir`, not `mkdir
 *  -p` (which succeeds on an existing directory), hence exec rather than transport.mkdirp.
 *
 *  Lives beside the data directory, never inside it: `restore` moves the old one aside and
 *  unpacks a new one, so a lock inside would let a second process create its own in the new
 *  tree mid-restore. Beside it alone isn't enough either (the data directory's parent can
 *  stay root:root), so the lock lives in its own directory (datadir.ts), owned by whoever
 *  runs the tooling; the data directory's name is kept so two deployments sharing a parent
 *  cannot collide. */
export function lockHome(ctx: Context): string {
  return locksDir(ctx.settings.dataDir);
}

export function lockPath(ctx: Context): string {
  return `${lockHome(ctx)}/operation.lock`;
}

function holderPath(ctx: Context): string {
  return `${lockPath(ctx)}/holder.json`;
}

/** The one place holder.json is written, initial claim and every heartbeat refresh alike —
 *  transport.writeFile is write-temp-then-rename, so a reader never sees a partial record. */
export async function writeHolderRecord(ctx: Context, holder: LockHolder): Promise<void> {
  await ctx.transport.writeFile(holderPath(ctx), `${JSON.stringify(holder, null, 2)}\n`);
}

/** A directory marker that proves which acquisition won the lock directory. `mkdir lockPath`
 *  only says the directory didn't exist a moment ago, not who owns it NOW. The marker names
 *  the winner instead: `gen-<token>`, minted before the acquisition's first command,
 *  created with the same atomic fail-if-exists `mkdir`. */
function generationMarkerPath(ctx: Context, generation: string): string {
  return `${lockPath(ctx)}/gen-${generation}`;
}

/** Claims the lock directory as this acquisition's, by moving its own generation marker out
 *  of the way. This is the compare-and-swap both races turn on: a gap between a separate
 *  read and write is where a takeover could put a different owner's lock at the same path.
 *  `rename` is atomic, so moving a path only this acquisition can still own settles the
 *  question and acts on it in one operation. Returns where the marker was parked, or
 *  undefined when the directory is not ours to touch. */
export async function claimOwnedLockDirectory(ctx: Context, generation: string): Promise<string | undefined> {
  const trash = `${lockPath(ctx)}/.released-${randomBytes(6).toString("hex")}`;
  try {
    const moved = await ctx.transport.exec("mv", [generationMarkerPath(ctx, generation), trash], { allowFailure: true });
    return moved.code === 0 ? trash : undefined;
  } catch {
    return undefined;
  }
}

/** Whether this acquisition's generation marker is still in place - i.e. the lock directory
 *  is still this acquisition's to clean up. */
export async function ownsLockGeneration(ctx: Context, generation: string): Promise<boolean> {
  const present = await ctx.transport.exec("test", ["-e", generationMarkerPath(ctx, generation)], { allowFailure: true });
  return present.code === 0;
}

/** Empties a lock directory this caller has proven it owns: the parked marker, the holder
 *  file while still this acquisition's, then the root via plain rmdir, never recursive —
 *  anything that appeared inside meanwhile makes rmdir fail, leaving a stale lock for a
 *  human rather than deleting a live one. Best effort throughout. */
export async function removeOwnedLock(ctx: Context, generation: string, trash: string): Promise<void> {
  await ctx.transport.exec("rm", ["-rf", trash], { allowFailure: true });
  const current = await readLockHolder(ctx);
  if (current === undefined || current.generation === generation) {
    // A file, not a directory: an empty-directory remove would refuse it.
    await ctx.transport.remove(holderPath(ctx)).catch(() => {});
  }
  await removeEmptyDirectory(ctx, lockPath(ctx));
}

/** Cleans an uncommitted claim without traversing another owner's marker. */
async function removeFailedMarkerClaim(ctx: Context, generation: string): Promise<void> {
  // The marker command may have created its directory before losing the acknowledgement.
  // Remove only that exact marker, then the lock root only if it is still empty.
  await removeEmptyDirectory(ctx, generationMarkerPath(ctx, generation));
  await removeEmptyDirectory(ctx, lockPath(ctx));
}

async function readHolderAt(ctx: Context, path: string): Promise<LockHolder | undefined> {
  try {
    const raw = await ctx.transport.readFile(path);
    if (raw.length > 65536) return undefined;
    const parsed = JSON.parse(raw) as LockHolder;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.operationId === "string" ? parsed : undefined;
  } catch {
    // Absent, unreadable, or not JSON. The directory may still exist, and takeLock treats
    // that as held-by-someone-unknown rather than free — a reason to ask a human, not proceed.
    return undefined;
  }
}

export async function readLockHolder(ctx: Context): Promise<LockHolder | undefined> {
  // A takeover's compare-and-swap reads the holder from the directory it just moved aside,
  // not from the lock path — this is the plain lock-path read.
  return readHolderAt(ctx, holderPath(ctx));
}

/** Wins the lock, or says why not. Plain mkdir's exit code is the answer. A failure isn't
 *  automatically a held lock — an unwritable parent fails the same way — so the directory
 *  itself settles it: present means someone holds it, absent means mkdir failed for its own
 *  reason, worth repeating verbatim. */
async function claimDirectory(ctx: Context): Promise<{ won: boolean; heldByOther: boolean; detail: string }> {
  // Idempotent container prep, not a signal: costs nothing and saves every command from
  // needing a bootstrap first. Only the lock itself is claimed with a plain mkdir below.
  await ctx.transport.exec("mkdir", ["-p", lockHome(ctx)], { allowFailure: true });

  const result = await ctx.transport.exec("mkdir", [lockPath(ctx)], { allowFailure: true });
  if (result.code === 0) return { won: true, heldByOther: false, detail: "" };

  const exists = await ctx.transport.exec("test", ["-d", lockPath(ctx)], { allowFailure: true });
  return { won: false, heldByOther: exists.code === 0, detail: (result.stderr || result.stdout).trim() };
}

/** Modern tokens must be meaningful marker names, not arbitrary falsy JSON values. */
function validGeneration(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
}

/** A legacy record needs meaningful immutable identity, not just two absent generations.
 *  Birth time is optional on older records, but when supplied must be a valid timestamp. */
function validLegacyHolder(holder: LockHolder): boolean {
  return !Object.hasOwn(holder, "generation") && readLockOwnerIdentity(holder) !== undefined;
}

function sameTakeoverHolder(observed: LockHolder, displaced: LockHolder | undefined): boolean {
  if (displaced === undefined || readLockOwnerIdentity(observed) === undefined || readLockOwnerIdentity(displaced) === undefined) return false;
  if (validGeneration(observed.generation)) {
    return validGeneration(displaced.generation) && displaced.generation === observed.generation;
  }
  if (!validLegacyHolder(observed) || !validLegacyHolder(displaced)) return false;
  const observedIdentity = readLockOwnerIdentity(observed);
  const displacedIdentity = readLockOwnerIdentity(displaced);
  if (observedIdentity === undefined || displacedIdentity === undefined || observedIdentity.identitySource !== displacedIdentity.identitySource) return false;
  if (observedIdentity.identitySource === "legacy-by") {
    return displaced.by === observed.by && displaced.operationId === observed.operationId &&
      displaced.takenAt === observed.takenAt && displaced.what === observed.what;
  }
  return displaced.host === observed.host && displaced.pid === observed.pid &&
    displaced.operationId === observed.operationId && displaced.takenAt === observed.takenAt &&
    displaced.startedAt === observed.startedAt;
}

/** Moves a lock aside and accepts only the validated acquisition that was observed. */
async function claimTakeover(
  ctx: Context,
  observedHolder: LockHolder,
): Promise<{ won: boolean; detail: string }> {
  const displaced = `${lockPath(ctx)}.stale-${randomBytes(6).toString("hex")}`;
  const moved = await ctx.transport.exec("mv", [lockPath(ctx), displaced], { allowFailure: true });
  if (moved.code !== 0) return { won: false, detail: (moved.stderr || moved.stdout).trim() };

  const displacedHolder = await readHolderAt(ctx, `${displaced}/holder.json`);
  if (!sameTakeoverHolder(observedHolder, displacedHolder)) {
    // Use the target's existing publication idiom (mv -nT, then verify): -n alone
    // can nest a directory into a colliding live root, and a skipped -n move exits zero.
    // Never remove either tree on a mismatch, a collision, or an uncertain acknowledgement.
    try {
      const restored = await ctx.transport.exec("mv", ["-nT", "--", displaced, lockPath(ctx)], { allowFailure: true });
      const source = await ctx.transport.exec("test", ["-e", displaced], { allowFailure: true });
      const destination = await ctx.transport.exec("test", ["-d", lockPath(ctx)], { allowFailure: true });
      if (restored.code === 0 && source.code === 1 && destination.code === 0) {
        return { won: false, detail: "the lock changed during takeover; displaced directory restored" };
      }
    } catch {
      // A transport error cannot authorize cleanup of a possibly live owner.
    }
    return { won: false, detail: `the lock changed during takeover; displaced directory retained or restoration unconfirmed at ${displaced}; inspect both paths` };
  }

  const result = await ctx.transport.exec("mkdir", [lockPath(ctx)], { allowFailure: true });
  // Best-effort cleanup of the now-unreachable displaced directory must not turn an
  // already-won takeover into a reported failure.
  await ctx.transport.exec("rm", ["-rf", displaced], { allowFailure: true });
  if (result.code !== 0) return { won: false, detail: (result.stderr || result.stdout).trim() };
  return { won: true, detail: "" };
}

/** Since the lock was taken, never affected by the heartbeat. For the refusal's "started by
 *  X, N ago" line. */
export function ageMs(holder: LockHolder, now = Date.now()): number {
  const taken = Date.parse(holder.takenAt);
  return Number.isNaN(taken) ? 0 : now - taken;
}

/** Since the holder last proved it is alive: `heartbeatAt`, or `takenAt` for a legacy record
 *  — correctly reading as "never refreshed". */
export function heartbeatAgeMs(holder: LockHolder, now = Date.now()): number {
  const at = Date.parse(holder.heartbeatAt ?? holder.takenAt);
  return Number.isNaN(at) ? 0 : now - at;
}

/** A legacy record with no heartbeatAt is judged by how long ago it was taken
 *  (STALE_AFTER_MS); everything else by how long its heartbeat has gone quiet
 *  (HEARTBEAT_STALE_AFTER_MS), regardless of when taken — the fix for a live `recipe install`
 *  outliving STALE_AFTER_MS. */
export function isStale(holder: LockHolder, now = Date.now()): boolean {
  if (holder.heartbeatAt === undefined) return ageMs(holder, now) > STALE_AFTER_MS;
  return heartbeatAgeMs(holder, now) > HEARTBEAT_STALE_AFTER_MS;
}

function humanAge(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} minute(s)`;
  return `${Math.floor(minutes / 60)} hour(s)`;
}

/** Same as humanAge, but second-level resolution below a minute — "12 seconds ago" beats
 *  "less than a minute ago" for the refusal's "still running" line. */
function humanShortAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return seconds < 60 ? `${seconds} second(s)` : humanAge(ms);
}

/** Every command that supports break-lock must actually accept it. A command that doesn't
 *  passes `false` here so the advice never names a flag it would then reject as unknown. */
export function breakLockAdvice(breakLockSupported: boolean): string {
  return breakLockSupported
    ? "take it over with --break-lock"
    : "this command does not accept --break-lock; verify the owner and choose an intended operation that supports explicit takeover";
}

/** The stale holder's heartbeat line, shared with the checks that prove it. */
export function staleHeartbeatLine(ageMs: number): string {
  return `not refreshed for ${humanAge(ageMs)}.`;
}

/** The takeover lost to a concurrent one. */
export const TAKEOVER_LOST_LINE = "Another operation already took it over. Re-run if the instance is still locked.";

/** The message a blocked run gets. Exported so the checks can assert what it tells the
 *  reader — a refusal that does not say who holds the lock leaves them with nothing to do
 *  but delete files and hope. */
export function refusalMessage(holder: LockHolder, now = Date.now(), breakLockSupported = true): string {
  const age = ageMs(holder, now);
  const identity = readLockOwnerIdentity(holder);
  const lines = [
    `another operation is changing this instance: ${holder.what} (${holder.operationId})`,
    identity?.identitySource === "legacy-by"
      ? `candidate owner host ${identity.host} pid ${identity.pid}; PID namespace unknown, ${humanAge(age)} ago`
      : `started by ${holder.by}, ${humanAge(age)} ago`,
  ];
  if (identity?.identitySource === "legacy-by") {
    lines.push(legacyByOwnerAdvice(identity.host, breakLockSupported));
    return lines.join("\n");
  }
  const stale = isStale(holder, now);
  // A fact, not a guess: recorded on this machine and the pid is provably gone. Independent
  // of staleness — a crash seconds ago is just as dead as one thirty minutes ago.
  const deadHere = isProvablyDeadHere(holder);
  lines.push(
    stale
      ? staleHeartbeatLine(heartbeatAgeMs(holder, now))
      : `refreshed ${humanShortAge(heartbeatAgeMs(holder, now))} ago — owner liveness must be checked.`,
  );
  if (deadHere) {
    lines.push(DEAD_HERE_LINE);
  }
  lines.push(
    // --break-lock is offered only once one of the two facts above supports it — a live,
    // recently-refreshed holder is never told to break its own lock.
    deadHere
      ? `If you are sure nothing is running, ${breakLockAdvice(breakLockSupported)}.`
      : identity !== undefined && !isLocalLockOwner(identity)
        ? breakLockSupported
          ? `Verify the remote owner in its original PID namespace first; takeover requires --break-lock and exact --break-foreign-lock ${JSON.stringify(identity.host)} confirmation.`
          : "Verify the remote owner first; this command does not accept --break-lock; choose an intended operation supporting exact foreign-owner confirmation."
        : liveWaitLine(holder.operationId),
  );
  return lines.join("\n");
}

export function refusalAdvice(holder: LockHolder | undefined, breakLockSupported = true): Advice {
  if (holder === undefined) return manual("Owner identity is unknown; do not take over by age alone.");
  const identity = readLockOwnerIdentity(holder);
  if (identity === undefined) return manual("Owner identity is malformed or unknown; do not take over by age alone.");
  if (identity.identitySource === "legacy-by") return manual(legacyByOwnerAdvice(identity.host, breakLockSupported));
  if (isProvablyDeadHere(holder)) return manual(`Owner proven dead; ${breakLockSupported ? "explicitly rerun the intended operation with --break-lock" : "this command does not accept --break-lock; choose an intended operation supporting explicit takeover"}.`);
  if (!isLocalLockOwner(identity)) return manual(`Verify the remote owner in its original PID namespace first; ${breakLockSupported ? `the intended operation requires --break-lock and exact --break-foreign-lock ${JSON.stringify(identity.host)} confirmation` : "this command does not accept --break-lock; choose an intended operation supporting exact foreign-owner confirmation"}.`);
  return manual("Wait for the owner; live or unknown owners cannot be taken over by age.");
}

export const DEAD_HERE_LINE = "Its recorded process is not running on this machine anymore — not a guess, the pid itself is gone.";

/** A live holder is waited out, never broken. */
export function liveWaitLine(operationId: string): string {
  return `Wait for it to finish, or run ${commandLine(["operations", operationId])} to see what it is doing.`;
}

/** Held by something that never said what it was. Worth its own message: the reader needs to
 *  know there is no name to look for, rather than assuming the report lost it. */
export function unreadableLockMessage(ctx: Context): string {
  return [
    `this instance is locked by an operation that did not record who it is (${lockPath(ctx)})`,
    "Most likely a run that won the lock and stopped before naming itself.",
    "Owner identity is unknown; do not take over by age alone.",
  ].join("\n");
}

/** Options every lock-taking entry point threads through unchanged. `breakLockSupported`
 *  defaults true; a command that doesn't accept --break-lock passes false.
 *  `breakForeignLockHost` is the exact host id an operator confirmed as an orphaned
 *  mutation-guard owner's machine — never inferred. */
export interface LockOptions {
  readonly breakLock?: boolean;
  readonly breakLockSupported?: boolean;
  readonly breakForeignLockHost?: string;
  /** Opt-in metadata recovery: refuse fresh acquisition or a changed owner. */
  readonly expectedOwner?: LockHolder;
  readonly strictVerification?: boolean;
}

/** Wins the lock directory, or takes over an existing one under --break-lock; never both silently. */
export async function acquireOrTakeOver(ctx: Context, options: LockOptions): Promise<void> {
  const claim = options.expectedOwner === undefined
    ? await claimDirectory(ctx)
    : { won: false, heldByOther: (await ctx.transport.exec("test", ["-d", lockPath(ctx)], { allowFailure: true })).code === 0, detail: "expected existing owner is no longer observable" };

  if (!claim.won && !claim.heldByOther) {
    if (options.expectedOwner !== undefined) throw new Error("expected existing lock is absent, changed or unreadable; metadata takeover refused");
    // Not a lock at all: mkdir could not run. --break-lock would fail the same way, so it's
    // not offered.
    die(
      `could not take the instance lock at ${lockPath(ctx)}: ${claim.detail === "" ? "mkdir failed" : claim.detail}\n` +
        `Nothing holds it — the directory is not there. ${lockHome(ctx)} has to exist and be writable ` +
        `by whoever runs this tooling; ${commandLine(["bootstrap"])} prepares it.`,
    );
  }

  if (claim.won) return;

  const existing = await readLockHolder(ctx);
  if (options.expectedOwner !== undefined && !sameTakeoverHolder(options.expectedOwner, existing)) {
    throw new Error("the lock owner changed before metadata takeover; nothing authorized this owner");
  }

  if (options.breakLock !== true) {
    // Metadata takeover has its own authorization; automatic takeover is not it.
    if (options.expectedOwner === undefined && existing !== undefined) {
      const proof = await proveOwnerDead(existing);
      if (proof.proven) {
        const takeover = await claimTakeover(ctx, existing);
        if (!takeover.won) {
          die(
            `could not take over the instance lock at ${lockPath(ctx)}: ${takeover.detail === "" ? "the lock changed during takeover" : takeover.detail}\n` +
              TAKEOVER_LOST_LINE,
          );
        }
        log(`taking over the lock held by ${existing.what} (${existing.operationId}) — owner proven dead (${proof.reason}); no --break-lock required`);
        return;
      }
    }
    // An existing directory with no readable holder is still someone's — most likely a run
    // that won it and died before writing its name. Refusing is the safe reading.
    die(
      existing === undefined
        ? unreadableLockMessage(ctx)
        : refusalMessage(existing, undefined, options.breakLockSupported),
      refusalAdvice(existing, options.breakLockSupported),
    );
  }

  const identity = existing === undefined ? undefined : readLockOwnerIdentity(existing);
  if (existing === undefined || identity === undefined) {
    die(existing === undefined
      ? "lock owner acquisition identity is unknown; takeover cannot compare ownership"
      : "lock owner acquisition identity is malformed; takeover cannot compare ownership", refusalAdvice(existing));
  }
  if (isLocalLockOwner(identity)) {
    const life = await localLiveness({ machine: identity.host, pid: identity.pid, startedAt: identity.startedAt });
    if (life !== "dead") die("the recorded lock owner is live or unknown; --break-lock cannot take it over", manual("Wait for the owner; do not take over by age."));
  } else if (options.breakForeignLockHost !== identity.host) {
    die("foreign lock owner requires exact --break-foreign-lock host confirmation", refusalAdvice(existing, options.breakLockSupported));
  }
  const takeover = await claimTakeover(ctx, existing);
  if (!takeover.won) {
    // Another caller's takeover or release already changed this path between the read above
    // and this attempt — refused like a fresh claim against a directory still there.
    die(
      `could not take over the instance lock at ${lockPath(ctx)}: ${takeover.detail === "" ? "the lock changed during takeover" : takeover.detail}\n` +
        TAKEOVER_LOST_LINE,
    );
  }

  if (!options.strictVerification) log(`taking over the lock held by ${existing.what} (${existing.operationId}) — --break-lock`);
}

/** Mints this acquisition's identity — a fresh random generation, before its first command. */
export function mintHolder(what: string, operationId: string, bootId?: string, start?: ProcessStartIdentity): { generation: string; holder: LockHolder } {
  const generation = randomBytes(12).toString("hex");
  const takenAt = new Date().toISOString();
  const holder: LockHolder = {
    operationId,
    what,
    by: `${process.env.USERNAME ?? process.env.USER ?? "unknown"}@${machineName()} pid ${process.pid}`,
    takenAt,
    generation,
    host: machineName(),
    pid: process.pid,
    startedAt: start?.startedAt ?? ownProcessStartedAt(),
    ...(start?.key === undefined ? {} : { startKey: start.key }),
    ...(start === undefined ? {} : { startSource: start.source }),
    ...(bootId === undefined ? {} : { bootId }),
    // Set at acquisition, not left for the first tick, so the lock never looks pre-heartbeat.
    heartbeatAt: takenAt,
  };
  return { generation, holder };
}

/** A fresh mkdir proves this process created the lock, but that proof is lost if writing
 *  holder.json then fails. This marker lets cleanup distinguish our incomplete claim from a
 *  lock another process took over meanwhile. */
export async function claimGenerationMarker(ctx: Context, generation: string): Promise<void> {
  let marker;
  try {
    marker = await ctx.transport.exec("mkdir", ["-m", "700", generationMarkerPath(ctx, generation)], { allowFailure: true });
  } catch (error) {
    await removeFailedMarkerClaim(ctx, generation).catch(() => {});
    throw error;
  }
  if (marker.code !== 0) {
    const detail = (marker.stderr || marker.stdout).trim();
    await removeFailedMarkerClaim(ctx, generation).catch(() => {});
    throw new Error(`could not record instance lock ownership${detail === "" ? "" : `: ${detail}`}`);
  }
}

/** Publishes holder.json, or rolls this claim back via the same CAS release() uses in instance-lock.ts. */
export async function writeHolderOrRollback(ctx: Context, generation: string, holder: LockHolder): Promise<void> {
  try {
    await writeHolderRecord(ctx, holder);
  } catch (error) {
    // The holder never got written, so whether this directory is still ours is settled by
    // the marker alone, via one atomic operation rather than a read-then-remove (which a
    // takeover could race, leaving the cleanup deleting a claim already live).
    const trash = await claimOwnedLockDirectory(ctx, generation);
    if (trash !== undefined) {
      try {
        await removeOwnedLock(ctx, generation, trash);
      } catch {
        // Preserve the write failure. A cleanup error must not hide the useful cause.
      }
    }
    throw error;
  }
}

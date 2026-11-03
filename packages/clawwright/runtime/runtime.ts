// The runtime contract: what a command may ask of the thing that runs OpenClaw.
//
// Commands talk to this interface and never to Docker. Today there is exactly one
// implementation (Docker); a native installation would be a sibling file, and no command
// would change. That is the whole point of the indirection — it is checked by grepping the
// command files for "docker" and "compose".

import { die } from "../core/io/log.ts";
import type { ExecResult } from "./transport/transport.ts";
import type { Context } from "../core/context.ts";

/** What a recipe author guarantees about a cold migration backup (declared, never inferred). */
interface RecipeMigrationStorageGuarantee {
  readonly persistentState: "all-in-declared-named-volumes-and-bind-mounts";
  readonly restore: "application-safe-including-compensation";
}
export type RecipeMigrationBackup = RecipeMigrationStorageGuarantee & (
  | { readonly consistency: "application-cold-safe"; readonly cleanShutdown: "flushes-all-writers" }
  | { readonly consistency: "application-verified-cold"; readonly cleanShutdown: "verified-by-post-stop-hook";
      readonly verification: "migration-verify.ts" }
);

/** Thrown by `execInHelper` when the helper container is not up, so callers can fall back
 *  to `runOneOff` without mistaking it for the command itself having failed. */
export class HelperNotRunning extends Error {
  constructor(service: string) {
    super(`no running helper for "${service}"`);
    this.name = "HelperNotRunning";
  }
}

/** Thrown by a read-only runtime query when the deployment's data directory doesn't exist on
 *  the target — a never-bootstrapped deployment. Every runtime call needs somewhere to write
 *  private files beside the data directory, and a still-root-owned parent refuses that mkdir
 *  pre-bootstrap. Callers that answer plainly (status, doctor, inspect) catch this. */
export class NotBootstrapped extends Error {
  constructor(dataDir: string) {
    super(`${dataDir} does not exist on the target — this deployment has never been bootstrapped`);
    this.name = "NotBootstrapped";
  }
}

/** The shared preflight for a command that mutates an EXISTING instance: refuses with
 *  NotBootstrapped's message before takeLock() runs. Commands that CREATE the instance
 *  (bootstrap, restore into an empty target, push, deploy) must never call this. */
export async function requireBootstrapped(ctx: Context): Promise<void> {
  try {
    await ctx.runtime.isRunning();
  } catch (error) {
    if (!(error instanceof NotBootstrapped)) throw error;
    // Structured advice, not prose: MCP/JSON surfaces render the advice field the same way
    // the console renders its arrow line.
    die(error.message, command(["bootstrap"]));
  }
}

export interface RunOneOffOptions {
  /** Compose profile or equivalent grouping. */
  profile?: string;
  /** Skip dependencies — used when the service itself must not be started. */
  noDeps?: boolean;
  /** Override the entrypoint, e.g. to run `node dist/index.js …`. */
  entrypoint?: string;
  /** Feed finite stdin; output is captured and stdin closes immediately. */
  input?: string;
  /** Stream output live even with finite input: the child's stdin stays piped, but on a real
   *  terminal stdout/stderr inherit instead of being accumulated (and lost). Default:
   *  stream only when no input is given. */
  stream?: boolean;
  /** Relay live process stdio as an exact duplex protocol, without capturing stdout. */
  stdioProtocol?: boolean;
  /** Return a non-zero exit as a normal ExecResult instead of throwing. Needed by callers
   *  that must inspect the *full* stdout/stderr — the thrown-error path truncates detail to
   *  a few lines. */
  allowFailure?: boolean;
}

/** One ordered log line, as the runtime's log reads hand them back. `ts` is the docker
 *  timestamp (present when docker supplied one, used only for ordering and stripped from
 *  display); `stream` and `service` are present when known. `text` is the line as it prints
 *  today, timestamp prefix removed. */
export interface RuntimeLogRecord {
  ts?: string;
  stream?: "stdout" | "stderr";
  service?: string;
  text: string;
}

/** Serialises records one JSON object per line (NDJSON); empty input yields an empty
 *  string. Shared so the commands that emit logs keep an identical encoding. */
export function jsonLogLines(records: RuntimeLogRecord[]): string {
  return records.map((r) => JSON.stringify(r) + "\n").join("");
}

export interface Runtime {
  /** Human-readable name for diagnostics. */
  readonly description: string;
  /** Executables this runtime needs on the machine that hosts the service. Asked for when
   *  provisioning a new host, so applications do not have to name them. */
  readonly requiredTools: string[];

  /** Starts the instance in the background. */
  start(): Promise<void>;
  /** Stops and removes it; persistent data is untouched. */
  stop(extraArgs?: string[]): Promise<void>;
  /** Stops without removing — used to quiesce before a snapshot. */
  pause(): Promise<void>;
  /** Restarts the running instance in place, so it re-reads configuration it only loads at
   *  startup. Not start(): starting an already-healthy instance is a no-op for a bind-mount
   *  edit, since nothing the runtime compares (image, ports, environment) changed. */
  restart(): Promise<void>;
  /** Brings the instance in step with current configuration via compose recreate — restart()'s
   *  counterpart, which keeps the container as created. Environment is fixed at creation, so
   *  a changed .env value reaches the service only through this. Reads .env at call time, not
   *  the process's start-time snapshot. Optional: replaces the container, so a runtime that
   *  can't pay that cost leaves the decision to the operator. */
  reconcile?(): Promise<void>;
  /** Follows the log until interrupted. */
  followLogs(extraArgs?: string[]): Promise<void>;
  /** Reads the last `tail` lines as ordered records, the two streams docker delivers merged
   *  chronologically by timestamp. `readLogs` formats these. */
  readLogRecords(tail?: string, extraArgs?: string[]): Promise<RuntimeLogRecord[]>;
  /** Reads the last `tail` lines, time-ordered across both streams. Bounded counterpart of
   *  followLogs, for a caller that cannot be interrupted. Omitting `tail` uses followLogs's
   *  default. */
  readLogs(tail?: string, extraArgs?: string[]): Promise<string>;
  /** Shows what is running. */
  showStatus(): Promise<void>;
  /** Fetches the image without starting anything. */
  pullImage(): Promise<void>;
  /** The digest a reference resolves to, read without pulling any layer or moving any local
   *  tag — a shared tag another deployment uses must not start pointing at different content
   *  just because this deployment checked it. Undefined when the registry can't be asked. */
  resolveImageDigest?(reference: string): Promise<string | undefined>;
  /** Recreates on `reference`, keeping it in transient runtime settings for validation;
   *  never rewrites .env. Signals immediately before the potentially mutating command,
   *  so callers do not compensate preparation failures that cannot have changed it. */
  recreateWithImage?(reference: string, onMutationStart?: () => void): Promise<void>;
  /** The running (or last) container's own exit code, or undefined when unreadable — a
   *  migration exiting during startup is otherwise indistinguishable from one still starting. */
  lastExitCode?(): Promise<number | undefined>;

  /** True when the instance's main process is up. */
  isRunning(): Promise<boolean>;
  /** The runtime's own health verdict, separate from an HTTP probe: the two can disagree,
   *  and that disagreement has already caught a broken healthcheck here. */
  health(): Promise<string>;
  /** Identifier of the exact image in use, for reproducibility. */
  imageReference(): Promise<string | undefined>;
  /** The running container's image, independent of the configured tag. */
  runningImageIdentity?(): Promise<{ imageId: string; digests: string[]; version?: string; containerId: string } | undefined>;
  /** The running container's own environment — what it started with, not what this machine's
   *  .env currently says. A repo-env value injected once at creation lives on inside the
   *  container even if the operator's copy is later lost. Undefined when not introspectable. */
  runningEnvironment?(): Promise<Record<string, string> | undefined>;
  /** The running container's connection facts — plumbing values read back from Docker, so a
   *  stale .env is repairable from the instance still running. NOT a secret — safe to print.
   *  Undefined when not introspectable; an absent field means Docker's answer didn't carry it. */
  runningConnectionFacts?(): Promise<
    { dataDir?: string; port?: string; bindAddress?: string; composeProject?: string; image?: string } | undefined
  >;
  /** A log tail plus an env-redacted `docker inspect` dump of the container running right
   *  NOW — for incident evidence, captured before a caller mutates it. Undefined when
   *  there's nothing to snapshot. */
  captureIncidentSnapshot?(tail: string): Promise<{ logs: string; inspect: string } | undefined>;

  /** When the running instance started, as epoch milliseconds, or undefined when not running.
   *  The instance reads its configuration only at startup, so comparing this against the
   *  config file's timestamp is what makes a stale-but-running instance observable. */
  startedAt(): Promise<number | undefined>;

  /** Runs a throwaway container for `service`. */
  runOneOff(service: string, args: string[], options?: RunOneOffOptions): Promise<ExecResult>;

  /** Starts a long-lived helper container so `execInHelper` can exec into it instead of
   *  paying `runOneOff`'s per-call create/destroy cost (~5-7s one-off vs ~1-3s exec warm). */
  startHelper(service: string, profile: string): Promise<void>;
  /** Stops and removes the helper container started by `startHelper`. */
  stopHelper(service: string, profile: string): Promise<void>;
  /** True when the helper container for `service` exists and is running. */
  helperRunning(service: string): Promise<boolean>;
  /** Runs a command inside the already-running helper container for `service`. */
  execInHelper(
    service: string,
    args: string[],
    options?: { input?: string; stream?: boolean; stdioProtocol?: boolean; allowFailure?: boolean; timeoutMs?: number },
  ): Promise<ExecResult>;
  /** The general form of execInHelper: any command, not just the app's own CLI entrypoint —
   *  for ad hoc diagnostics. Throws HelperNotRunning when not up. `options.timeoutMs` bounds
   *  the WHOLE call, so a wedged container/resolver/client can't stall past its budget. */
  execCommand?(
    service: string,
    command: string,
    args: string[],
    options?: { input?: string; stream?: boolean; stdioProtocol?: boolean; allowFailure?: boolean; timeoutMs?: number },
  ): Promise<ExecResult>;

  /** Name of whatever already publishes `port` and does not belong to this deployment,
   *  or undefined when the port is free to bind. */
  portConflict(port: string): Promise<string | undefined>;

  /** Probes an unauthenticated service endpoint from the instance's own network. */
  probe(endpoint: string, timeoutMs?: number): Promise<number>;
  /** Polls until the service serves or the timeout expires. */
  waitForHealth(timeoutSeconds?: number): Promise<void>;

  /** Operates a side stack — deployed next to the instance but isolated, with its own
   *  project name. Used for recipes, so a third-party service can't take the gateway down. */
  stack(project: string, definitionPath: string, ownership?: { verifyOwnership: boolean; legacyProjects?: readonly string[]; recipeName?: string }): Stack;
}

/** One compose service's state, as `serviceStates()` reports it. */
export interface StackServiceState {
  /** True when the container's own state is "running" — not "exited", "created" or
   *  missing entirely. */
  readonly running: boolean;
  /** Compose's own healthcheck verdict ("healthy", "unhealthy", "starting"), or undefined
   *  when the service declares no healthcheck at all, distinct from one not settled yet. */
  readonly health?: string;
}

/** Safe, allowlisted evidence; no raw Docker Config, environment, or health commands. */
export interface StackContainerEvidence {
  readonly id: string;
  readonly project: string;
  readonly provenance: "matched" | "legacy" | "foreign" | "unknown";
  readonly service?: string;
  readonly state?: string;
  readonly health?: string;
  readonly exitCode?: number;
  readonly startError?: string;
  readonly imageId?: string;
  /** Display-only, redacted paths. Executors must verify raw private mount identities,
   *  never use these strings as storage sources or as drift fingerprints. */
  readonly mounts?: readonly { type: string; source: string; destination: string; writable: boolean; name?: string }[];
  readonly logs?: string;
}
export interface StackInspection {
  readonly containers: readonly StackContainerEvidence[];
  /** Unknown is never reported as an empty stack. */
  readonly namespaces: readonly { project: string; status: "present" | "absent" | "unknown" }[];
  readonly unknown: readonly { project: string; cause: "transport" | "malformed"; detail: string }[];
}
export interface StackRecoverOptions {
  readonly service: string;
  readonly build?: boolean;
  readonly pull?: boolean;
  readonly timeoutSeconds?: number;
}
export interface StackRecoverPlan {
  readonly token: string;
  readonly service: string;
  readonly imageIds: readonly string[];
  readonly build: boolean;
  readonly pull: boolean;
  readonly containers: readonly StackContainerEvidence[];
  readonly impacts: readonly string[];
}
export type MigrationObservedState = "running" | "stopped" | "partial" | "unknown" | "absent";
export interface StackMigrationEvidence {
  readonly applicationVerification: "author-guaranteed" | "pending" | "verified" | "unknown";
  readonly cleanShutdownVerified: boolean;
  readonly archivesVerified: boolean;
  readonly sourceResumeAttempted: boolean;
  readonly source: MigrationObservedState;
  readonly target: MigrationObservedState;
}
export interface MigrationBackupEvidence {
  readonly sourceProject: string;
  readonly targetProject: string;
  /** Target-clock ISO timestamp captured immediately before stopping source writers. */
  readonly stopStartedAt: string;
  readonly containers: readonly {
    readonly id: string;
    readonly service: string;
    readonly exitCode: number;
    readonly finishedAt: string;
  }[];
}
export interface MigrationBackupVerification {
  readonly verified: true;
}
export interface StackMigrateOptions {
  /** Loaded recipe author declaration. Optional for source compatibility only; runtime rejects absence. */
  readonly migrationBackup?: RecipeMigrationBackup;
  /** Required for conditional contracts, never called by planning. Read-only observer only. */
  readonly verifyMigrationBackup?: (evidence: MigrationBackupEvidence) => Promise<MigrationBackupVerification>;
  /** Fresh, absolute target-side private backup directory; retained on every outcome. */
  readonly backupRoot: string;
  readonly timeoutSeconds?: number;
  /** Existing local immutable helper image ID; never fetched or built. */
  readonly helperImage?: string;
  /** Gentle shutdown grace, independently bounded from readiness (default 180, max 3600). */
  readonly shutdownTimeoutSeconds?: number;
}
export interface StackMigratePlan {
  readonly helperImage: string;
  readonly shutdownTimeoutSeconds: number;
  readonly migrationBackup: RecipeMigrationBackup;
  readonly token: string;
  readonly sourceProject: string;
  readonly targetProject: string;
  readonly services: readonly string[];
  readonly backupRoot: string;
  readonly volumes: readonly { source: string; target: string }[];
  readonly inventory: readonly StackContainerEvidence[];
  readonly images: readonly { service: string; imageId: string }[];
  readonly impacts: readonly string[];
}
export interface StackMigrationResult {
  readonly migrationBackup: RecipeMigrationBackup;
  readonly evidence: StackMigrationEvidence;
  readonly backupRoot: string;
  readonly journalPath: string;
  readonly retainedSource: true;
}
export interface StackRetireLegacyOptions {
  /** Fresh, absolute target-side private backup directory; retained on every outcome. */
  readonly backupRoot: string;
  /** Trusted local sha256 image ID for storage tools; default is the legacy stack's first image. */
  readonly helperImage?: string;
  /** Gentle stop grace, bounded 1..3600 (default 180); a container that will not stop refuses. */
  readonly shutdownTimeoutSeconds?: number;
}
export interface StackRetireLegacyPlan {
  readonly token: string;
  /** The recipe's current (empty) namespace, which must stay untouched. */
  readonly project: string;
  /** The single populated legacy namespace the plan retires. */
  readonly legacyProject: string;
  readonly containers: readonly StackContainerEvidence[];
  /** Writable storage observed on the legacy containers; backed up cold, never deleted. */
  readonly storage: readonly { type: "bind" | "volume"; source: string; destination: string; writable: boolean; name?: string }[];
  /** Images stay retained after the containers are removed; exact rollback anchors. */
  readonly retainedImages: readonly { service?: string; imageId: string }[];
  /** Immutable local helper image used for the capability probe and cold backups. */
  readonly helperImage: string;
  readonly backupRoot: string;
  readonly shutdownTimeoutSeconds: number;
  readonly operations: readonly string[];
  readonly impacts: readonly string[];
}
export interface StackRetireLegacyFailureRecovery {
  readonly stoppedContainers: readonly string[];
  readonly restartArgv: readonly string[];
  readonly restartCommand: string;
}
export interface StackRetireLegacyResult {
  readonly legacyProject: string;
  readonly backupRoot: string;
  readonly journalPath: string;
  readonly removedContainers: readonly { id: string; service?: string; imageId?: string }[];
  readonly retainedImages: readonly { service?: string; imageId: string }[];
  /** Everything the recorded rollback needs; inspect JSON files in backupRoot are authoritative. */
  readonly rollback: {
    readonly inspectRecorded: true;
    readonly archives: readonly { key: string; type: "bind" | "volume"; source: string; archive: string; helperImage: string; restoreArgv: readonly string[]; restore: string }[];
    readonly containers: readonly { id: string; service?: string; imageId: string; ports: readonly { containerPort: string; hostIp?: string; hostPort: string }[];
      mounts: readonly { type: string; source: string; destination: string; name?: string }[]; envNames: readonly string[] }[];
  };
}
/** Executor owns neither deployment locks nor hooks. Caller supplies its lock scope. */
export type StackLock = <T>(action: () => Promise<T>) => Promise<T>;

export interface Stack {
  inspect?(options?: { logs?: boolean; tail?: number }): Promise<StackInspection>;
  planRecover?(options: StackRecoverOptions): Promise<StackRecoverPlan>;
  recover?(plan: StackRecoverPlan, withLock: StackLock): Promise<void>;
  planMigrate?(options: StackMigrateOptions): Promise<StackMigratePlan>;
  migrate?(plan: StackMigratePlan, withLock: StackLock): Promise<StackMigrationResult>;
  planRetireLegacy?(options: StackRetireLegacyOptions): Promise<StackRetireLegacyPlan>;
  retireLegacy?(plan: StackRetireLegacyPlan, withLock: StackLock): Promise<StackRetireLegacyResult>;
  /** Builds images defined by the stack. */
  build(): Promise<void>;
  /** Starts it in the background. `wait` asks compose to block until every service is
   *  running (and healthy, where declared) or `timeoutSeconds` elapses — only when a caller
   *  has a bounded readiness declaration, so a stuck healthcheck can't hang install forever. */
  up(options?: { wait?: boolean; timeoutSeconds?: number }): Promise<void>;
  /** Stops and removes it; --volumes only when explicitly asked. */
  down(removeVolumes?: boolean): Promise<void>;
  status(): Promise<void>;
  /** Extra args such as --no-color pass through to compose logs. */
  followLogs(extraArgs?: string[]): Promise<void>;
  /** Same records as Runtime.readLogRecords, for a recipe's own stack. */
  readLogRecords(tail: string, extraArgs?: string[]): Promise<RuntimeLogRecord[]>;
  /** Same bound as Runtime.readLogs, for a recipe's own stack. */
  readLogs(tail: string, extraArgs?: string[]): Promise<string>;
  /** True when ANY container from this project is up — a single live sidecar satisfies it
   *  even while the main service is down. install's readiness check uses serviceStates()
   *  instead, which doesn't have that blind spot. */
  isRunning(): Promise<boolean>;
  /** Per-service state, keyed by compose service name — lets a caller require ALL of a
   *  multi-service recipe's declared services instead of one live container. */
  serviceStates(): Promise<Record<string, StackServiceState>>;
}

/** Delays without blocking the event loop — the one polling primitive every wait loop that
 *  watches a runtime transition shares. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `runningConnectionFacts()` behind one try/catch: not running and "this runtime could not
 *  introspect it" both read as `undefined` here, since every caller treats them the same —
 *  nothing to check right now either way. */
export async function safeConnectionFacts(
  ctx: Context,
): Promise<{ bindAddress?: string; port?: string } | undefined> {
  try {
    return await ctx.runtime.runningConnectionFacts?.();
  } catch {
    return undefined;
  }
}
import { command } from "../core/io/invocation/advice.ts";

// Compose invocation and the per-call environment file it needs. Settings can be replaced
// wholesale by reconcile(), so this class never caches them in a field of its own: every
// read and write goes through the accessors the caller supplies.

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { UserError } from "../../core/io/log.ts";
import { composeFile, locksDir, toSettings, loadEnv, type Settings } from "../../core/env.ts";
import { deploymentDir, composeProjectName } from "../deployment.ts";
import { machineName, ownProcessStartedAt, localLiveness } from "../lock/process-identity.ts";
import type { PathBridge } from "../../core/paths.ts";
import type { ExecResult, Transport } from "../transport/transport.ts";
import { NotBootstrapped, type RunOneOffOptions, type RuntimeLogRecord } from "../runtime.ts";

/** Removes `compose-*` directories a PAST call to `withEnvFile` left behind (a crash between
 *  mkdir and this method's finally block). Only ones provably abandoned: owner.json naming
 *  this machine, with a pid provably gone. Best-effort: a failure here must never block the
 *  real compose call that follows. */
async function sweepStaleComposeEnvs(transport: Transport, directory: string): Promise<void> {
  let entries: string[];
  try {
    entries = await transport.listFiles(directory);
  } catch {
    return;
  }
  const names = new Set(
    entries
      .map((entry) => entry.split("/")[0] ?? "")
      .filter((name) => /^compose-[0-9a-f-]+$/.test(name)),
  );
  for (const name of names) {
    const path = `${directory}/${name}`;
    let owner: { pid?: unknown; machine?: unknown; startedAt?: unknown } | undefined;
    try {
      owner = JSON.parse(await transport.readFile(`${path}/owner.json`)) as typeof owner;
    } catch {
      continue; // Unreadable or missing: cannot prove this run is gone, so it is left alone.
    }
    if (typeof owner !== "object" || owner === null) continue;
    if (typeof owner.machine !== "string" || owner.machine !== machineName() || typeof owner.pid !== "number") continue;
    const liveness = await localLiveness({
      pid: owner.pid,
      machine: owner.machine,
      startedAt: typeof owner.startedAt === "string" ? owner.startedAt : undefined,
    });
    if (liveness !== "dead") continue;
    await transport.remove(path).catch(() => {});
  }
}

/** Detects control characters unsupported by the env-file serializer. */
function hasUnsupportedControls(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code < 32 && code !== 9) || code === 127) return true;
  }
  return false;
}

/** Encodes values as literal double-quoted Compose env-file entries. */
/** The pure `-T` decision for `compose run`: no PTY whenever our stdout is not a terminal, in
 *  stdio-protocol mode, or when finite input is piped in — compose would otherwise allocate a
 *  pseudo-TTY against that pipe. Exported so the check pins the decision without a docker call. */
export function oneOffDisableTty(isTTY: boolean, hasInput: boolean, stdioProtocol: boolean): boolean {
  return stdioProtocol || isTTY !== true || hasInput;
}

export function serializeComposeEnv(env: Record<string, string>): string {
  const entries = Object.entries(env);
  const invalidNames = entries.filter(([name]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)).map(([name]) => name);
  if (invalidNames.length > 0) throw new Error(`invalid environment variable name: ${invalidNames.join(", ")}`);
  const invalidValues = entries
    .filter(([, value]) => typeof value !== "string" || hasUnsupportedControls(value))
    .map(([name]) => name);
  if (invalidValues.length > 0) {
    throw new Error(`cannot pass ${invalidValues.join(", ")} to compose: a value contains an unsupported control character`);
  }
  return entries
    .map(([name, value]) => `${name}=${JSON.stringify(value).replaceAll("$", "$$$$")}`)
    .join("\n") + "\n";
}

/** Log lines can embed colour codes from inside the container; `--no-color` on compose
 *  cannot remove those. */
export function stripAnsi(text: string): string {
  // Escape built from a char code, not a literal: oxlint denies control characters inside
  // regex literals (no-control-regex).
  return text.replace(new RegExp(`${String.fromCharCode(27)}(?:\\[[0-?]*[ -/]*[@-~]|[@-_])`, "g"), "");
}

// RFC3339 with `Z` or a numeric offset; the fraction may be absent or 1-9 digits (docker
// itself emits 6). The fraction and offset groups CAPTURE: timestampKey() reads them as
// match[2]/match[3] to build its ordering key — non-capturing there would drop the fraction
// and force every offset to "Z". The other matchers only read the whole timestamp (group 1
// or 2), so the inner groups are simply ignored there. Matched against ONE token only — the
// first timestamp after the compose
// prefix is docker's; any later timestamp on the line belongs to the application and stays
// in the text.
const TIMESTAMP = "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.(\\d{1,9}))?(Z|[+-]\\d{2}:?\\d{2})?";

/** Two log-line layouts with `--timestamps`:
 *  A (compose): optionally ANSI-coloured `service`, `\s*\|\s?`, docker timestamp, text —
 *    `proxy-1  | 2026-10-21T11:26:48.622092Z INFO boot`
 *  B (plain `docker logs`, incident-snapshot): timestamp first, then text.
 *  Structure is matched on the ANSI-stripped line, but `text` is cut from the ORIGINAL line
 *  (only the docker timestamp token is removed), so compose's colour codes in the prefix
 *  survive and the display stays as docker would have shown it, minus the timestamp.
 *  Exact expectations, verbatim: `proxy-1  | 2026-10-21T11:26:48.622092Z INFO boot` →
 *  service "proxy-1", text "proxy-1  | INFO boot"; with "\u001B[36mproxy-1\u001B[0m" as the
 *  prefix the escapes stay in the text: "\u001B[36mproxy-1\u001B[0m  | x"; layout B
 *  `2026-10-21T11:26:48.622092Z INFO boot` → no service, text "INFO boot"; a line that is
 *  only prefix + timestamp yields the prefix alone with trailing space trimmed
 *  ("proxy-1  |"). A line with no timestamp at all inherits the previous ts of its stream. */
function parseLogStream(text: string, stream: "stdout" | "stderr"): RuntimeLogRecord[] {
  if (text === "") return []; // split("\n") on "" yields [""], which would invent an empty line.
  const lines = text.split("\n");
  if (lines.length > 0 && text.endsWith("\n")) lines.pop();
  const records: RuntimeLogRecord[] = [];
  let previous = ""; // Untimestamped lines inherit the previous line's ts: keep stream-relative order next to their neighbours.
  for (const line of lines) {
    const plain = stripAnsi(line);
    const composeMatch = new RegExp(`^([^\\s|]+)\\s*\\|\\s?(${TIMESTAMP})`).exec(plain);
    const plainMatch = composeMatch ? undefined : new RegExp(`^(${TIMESTAMP})`).exec(plain);
    const tsToken = composeMatch?.[2] ?? plainMatch?.[1];
    if (tsToken === undefined) {
      records.push({ ts: previous, stream, text: line });
      continue;
    }
    // Cut exactly the docker timestamp token (and one following space) from the original
    // line; the first occurrence is docker's, later identical tokens are the application's.
    const at = line.indexOf(tsToken);
    const after = line.slice(at + tsToken.length);
    // prefixOnly: nothing but the single consumed space followed the timestamp.
    const prefixOnly = after === "" || after === " ";
    const text = line.slice(0, at) + (after.startsWith(" ") ? after.slice(1) : after);
    if (composeMatch === null) {
      records.push({ ts: tsToken, stream, text: text === "" ? "" : text });
    } else {
      records.push({
        ts: tsToken,
        stream,
        service: stripAnsi(composeMatch[1] ?? ""),
        // Empty application line: keep the (timestamp-free) prefix so the record is not blank.
        text: prefixOnly ? plain.slice(0, plain.indexOf(tsToken)).trimEnd() : text,
      });
    }
    previous = tsToken;
  }
  return records;
}

/** Ordering key for an RFC3339 timestamp, parsed BY VALUE into parts: `sec` is exact integer
 *  epoch seconds built from Date.UTC() of the date-time COMPONENTS with the numeric offset
 *  applied (Date.parse is not used, so fraction/offset quirks like `fraction === ""` cannot
 *  produce an invalid head); the fraction lives only in `ns`, right-padded to 9 digits and
 *  compared lexicographically afterwards ("622092000" < "622100000"). Never compare raw
 *  timestamp strings from records that may carry different offsets. A key with NaN sec
 *  (Date.UTC failed — should not happen for a matched token, or ts is an inherited "") falls
 *  back to the raw string in the comparator, so nothing crashes; "" sorts first and equal
 *  strings keep input order. */
function timestampKey(ts: string): { sec: number; ns: string; raw: string } {
  const match = new RegExp(`^(${TIMESTAMP})$`).exec(ts);
  if (match === null) return { sec: NaN, ns: "", raw: ts };
  const whole = match[1] ?? "";
  const fraction = match[2] ?? "";
  const offset = match[3];
  const year = Number(whole.slice(0, 4));
  const month = Number(whole.slice(5, 7));
  const day = Number(whole.slice(8, 10));
  const hour = Number(whole.slice(11, 13));
  const minute = Number(whole.slice(14, 16));
  const second = Number(whole.slice(17, 19));
  let sign = 0;
  let offsetMinutes = 0;
  if (offset !== undefined && offset !== "Z") {
    sign = offset.charAt(0) === "-" ? -1 : 1;
    offsetMinutes = Number(offset.slice(1, 3)) * 60 + Number(offset.slice(-2));
  }
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const epochMs = utcMs - sign * offsetMinutes * 60000;
  return { sec: epochMs / 1000, ns: fraction.padEnd(9, "0"), raw: ts };
}

function compareKeys(a: { sec: number; ns: string; raw: string }, b: { sec: number; ns: string; raw: string }): number {
  if (!Number.isNaN(a.sec) && !Number.isNaN(b.sec)) {
    return a.sec !== b.sec ? a.sec - b.sec : a.ns < b.ns ? -1 : a.ns > b.ns ? 1 : 0;
  }
  return a.raw < b.raw ? -1 : a.raw > b.raw ? 1 : 0;
}

/** Merges the two blocks docker not on a TTY delivers as one chronological sequence, ordered
 *  by the parsed timestamp key. stdout's records are appended first, then stderr's, and ONE
 *  sort follows: `Array.prototype.sort` is stable per spec (ES2019+), so ties keep input
 *  order — which naturally puts stdout before stderr. Tail is applied AFTER merging: a fresh
 *  stderr line must survive a tail that old stdout lines do not. tail <= 0 yields nothing. */
export function mergeLogStreams(stdout: string, stderr: string, tail?: number): RuntimeLogRecord[] {
  const merged = [...parseLogStream(stdout, "stdout"), ...parseLogStream(stderr, "stderr")];
  const keys = merged.map((record) => timestampKey(record.ts ?? ""));
  const order = merged.map((record, index) => ({ record, key: keys[index]! }));
  order.sort((a, b) => compareKeys(a.key, b.key));
  const sorted = order.map((entry) => entry.record);
  return tail === undefined ? sorted : tail <= 0 ? [] : sorted.slice(-tail);
}

export function formatLogRecords(records: RuntimeLogRecord[]): string {
  return records.length === 0 ? "" : records.map((r) => r.text).join("\n") + "\n";
}

/** Runs `docker compose` for one service, with the per-call env-file plumbing (`withEnvFile`,
 *  `compose`) that every invocation needs. Settings are read/written through accessors:
 *  reconcile() replaces the whole object, and every caller must see it immediately. */
export class ComposeOperations {
  #transport: Transport;
  #getSettings: () => Settings;
  #setSettings: (settings: Settings) => void;
  #paths: PathBridge;
  #service: string;
  #logTail: string;
  #reconcileSettings?: () => Promise<Settings>;

  constructor(
    transport: Transport,
    getSettings: () => Settings,
    setSettings: (settings: Settings) => void,
    paths: PathBridge,
    service: string,
    logTail: string,
    reconcileSettings: (() => Promise<Settings>) | undefined,
  ) {
    this.#transport = transport;
    this.#getSettings = getSettings;
    this.#setSettings = setSettings;
    this.#paths = paths;
    this.#service = service;
    this.#logTail = logTail;
    this.#reconcileSettings = reconcileSettings;
  }

  /** Supplies one operation's environment by file and removes it on completion. Defaults to
   *  the settings this runtime was built with; reconcile() hands in fresh ones read from
   *  disk. Public: helper-container and side-stack callers share this exact plumbing. */
  async withEnvFile<T>(
    action: (path: string) => Promise<T>,
    settings: Settings = this.#getSettings(),
  ): Promise<T> {
    const stageDefinition = this.#transport.writePrivateFile?.bind(this.#transport);
    if (this.#transport.sessionScoped === true && stageDefinition === undefined) {
      throw new UserError("SSJACK_PRIVATE_STAGING_REQUIRED");
    }
    const directory = locksDir(settings.dataDir);
    const privateDirectory = `${directory}/compose-${randomUUID()}`;
    const path = `${privateDirectory}/compose.env`;
    const ownerPath = `${privateDirectory}/owner.json`;
    const owner = JSON.stringify({ pid: process.pid, machine: machineName(), startedAt: ownProcessStartedAt() });
    const body = serializeComposeEnv(settings.env);
    let cleanupNeeded = false;
    let operationFailed = false;
    let operationError: unknown;
    let cleanupError: unknown;
    let result!: T;
    try {
      try {
        await this.#transport.mkdirp(directory);
      } catch (error) {
        // A missing data directory means nobody bootstrapped this deployment; the sibling
        // "-locks" directory shares that parent. Any other failure propagates as-is.
        if (!(await this.#transport.exists(settings.dataDir))) {
          throw new NotBootstrapped(settings.dataDir);
        }
        throw error;
      }
      await sweepStaleComposeEnvs(this.#transport, directory);
      // Keep file creation private even before writeFile applies its mode.
      await this.#transport.exec("mkdir", ["-m", "700", privateDirectory]);
      cleanupNeeded = true;
      // Owner recorded before the token-bearing file: a crash between these two writes still
      // leaves owner.json in place, which the sweep above needs.
      await this.#transport.writeFile(ownerPath, owner, "600");
      if (this.#transport.sessionScoped === true) {
        const definition = await readFile(composeFile);
        await stageDefinition!(`${privateDirectory}/compose.yaml`, definition);
      }
      await this.#transport.writeFile(path, body, "600");
      result = await action(path);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    } finally {
      if (cleanupNeeded) {
        try {
          await this.#transport.remove(privateDirectory);
        } catch (error) {
          cleanupError = error;
        }
      }
    }
    if (operationFailed) throw operationError;
    if (cleanupError !== undefined) {
      throw new Error(`could not remove the temporary compose environment: ${(cleanupError as Error).message}`);
    }
    return result;
  }

  /** Compose needs the file and project directory in the target's coordinates: the tooling
   *  may be on Windows while compose runs inside WSL. */
  async #composeArgs(envFileOnTarget: string): Promise<string[]> {
    // Project directory is the deployment's, so two deployments sharing a definition stay
    // separate. Project name is stated rather than left to compose, or they'd share
    // containers/networks/volumes. --env-file REPLACES the project directory's own .env, so
    // the file written above carries the whole environment, not just the secret part.
    const scopedDirectory = posix.dirname(envFileOnTarget);
    const [file, projectDir] = this.#transport.sessionScoped === true
      ? [posix.join(scopedDirectory, "compose.yaml"), scopedDirectory]
      : await Promise.all([
        this.#paths.toTarget(composeFile),
        this.#paths.toTarget(deploymentDir()),
      ]);
    return [
      "compose",
      "--env-file",
      envFileOnTarget,
      "--project-name",
      composeProjectName(),
      "--file",
      file,
      "--project-directory",
      projectDir,
    ];
  }

  // Failures propagate by default: only the read-only queries below opt out, since "the
  // project doesn't exist yet" is an answer, not an error.
  async compose(
    args: string[],
    stream = false,
    allowFailure = false,
    settings: Settings = this.#getSettings(),
    beforeExec?: () => void,
  ): Promise<ExecResult> {
    return this.withEnvFile(async (envFile) => {
      const base = await this.#composeArgs(envFile);
      beforeExec?.();
      return this.#transport.exec("docker", [...base, ...args], {
        stream,
        allowFailure,
        unsetEnv: Object.keys(settings.env),
      });
    }, settings);
  }

  async start(): Promise<void> {
    await this.compose(["up", "--detach", this.#service], true);
  }

  async stop(extraArgs: string[] = []): Promise<void> {
    await this.compose(["--profile", "cli", "down", ...extraArgs], true);
  }

  async pause(): Promise<void> {
    await this.compose(["stop", this.#service], true);
  }

  /** Keeps the container — environment included, interpolated once at creation: an edited
   *  .env needs reconcile(), an edited bind-mounted file is exactly what this is for. */
  async restart(): Promise<void> {
    await this.compose(["restart", this.#service], true);
  }

  /** `up` against the deployment .env as it is on disk NOW, not this process's start-time
   *  snapshot. The fresh settings are then kept: a later compose call with the old ones would
   *  make compose recreate the service with them (a rotated token silently reverted). */
  async reconcile(): Promise<void> {
    const current = this.#reconcileSettings !== undefined
      ? await this.#reconcileSettings()
      : toSettings(await loadEnv());
    await this.compose(["up", "--detach", this.#service], true, false, current);
    this.#setSettings(current);
  }

  async followLogs(extraArgs: string[] = []): Promise<void> {
    await this.compose(["logs", "--follow", "--tail", this.#logTail, this.#service, ...extraArgs], true);
  }

  async readLogRecords(tail?: string, extraArgs: string[] = []): Promise<RuntimeLogRecord[]> {
    // The configured default is applied AFTER the merge too: docker's --tail bounds its work
    // per stream, but the final bound must hold over the merged sequence.
    const bound = tail ?? this.#logTail;
    const result = await this.compose(["logs", "--timestamps", "--tail", bound, this.#service, ...extraArgs]);
    return mergeLogStreams(result.stdout, result.stderr, Number(bound));
  }

  /** No --follow, and captured rather than streamed: the caller wants the text back, not a
   *  stream on the terminal. Time-ordered across both streams: docker not on a TTY delivers
   *  stdout and stderr as two separate blocks, so a plain `--tail N` over one captured stream
   *  is not the last N by time. */
  async readLogs(tail: string | undefined, extraArgs: string[] = []): Promise<string> {
    return formatLogRecords(await this.readLogRecords(tail, extraArgs));
  }

  async showStatus(): Promise<void> {
    await this.compose(["ps"], true);
  }

  async pullImage(): Promise<void> {
    await this.compose(["pull", this.#service], true);
  }

  async isRunning(): Promise<boolean> {
    const result = await this.compose(["ps", "--quiet", this.#service], false, true);
    if (result.code !== 0) {
      throw new Error(`could not determine whether service "${this.#service}" is running: ${result.stderr.trim() || `docker compose ps exited ${result.code}`}`);
    }
    return result.stdout.trim() !== "";
  }

  /** Recreate on a digest and keep that image in this runtime's transient settings for
   *  subsequent validation and start calls. The deployment's durable .env stays untouched. */
  async recreateWithImage(reference: string, onMutationStart?: () => void): Promise<void> {
    const current = this.#reconcileSettings !== undefined ? await this.#reconcileSettings() : toSettings(await loadEnv());
    const target = { ...current, image: reference, env: { ...current.env, OPENCLAW_IMAGE: reference } };
    await this.compose(["up", "--detach", this.#service], true, false, target, () => {
      this.#setSettings(target);
      onMutationStart?.();
    });
  }

  /** `-T` is added whenever our stdout is not a terminal: compose otherwise allocates a
   *  pseudo-TTY, and a TTY does not survive the trip through wsl.exe — the command
   *  succeeds while its output vanishes. Also with finite input: a PTY against this
   *  process's piped stdin breaks the run (see oneOffDisableTty). */
  async runOneOff(service: string, args: string[], options: RunOneOffOptions = {}): Promise<ExecResult> {
    if (this.#transport.sessionScoped === true && options.stdioProtocol === true) {
      throw new UserError("SSJACK_STDIO_PROTOCOL_UNSUPPORTED");
    }
    const prefix: string[] = [];
    if (options.profile !== undefined) prefix.push("--profile", options.profile);

    const runArgs = ["run", "--rm"];
    if (oneOffDisableTty(process.stdout.isTTY === true, options.input !== undefined, options.stdioProtocol === true)) runArgs.push("-T");
    if (options.noDeps === true) runArgs.push("--no-deps");
    if (options.entrypoint !== undefined) runArgs.push("--entrypoint", options.entrypoint);

    return this.withEnvFile(async (envFile) => {
      const base = await this.#composeArgs(envFile);
      return this.#transport.exec("docker", [...base, ...prefix, ...runArgs, service, ...args], {
        stream: options.stream ?? options.input === undefined,
        input: options.input,
        stdioProtocol: options.stdioProtocol,
        allowFailure: options.allowFailure,
        unsetEnv: Object.keys(this.#getSettings().env),
      });
    });
  }
}

// Host contexts: the roles `clawwright host` can target on the operator's own machine.
//
// A context is a role, resolved per platform — never a hardcoded "on Windows do X". "target"
// is the deployment's own transport; "engine" is wherever the container runtime actually
// executes; "local" is the bare machine, unwrapped. Resolution reports where the command
// actually ended up, and says so when a role collapsed onto another one on this host.

import { die } from "#src/core/io/log.ts";
import type { Context } from "#src/core/context.ts";
import { spawnLocal, stripWslNuls, type ExecOptions, type ExecResult } from "#src/runtime/transport/transport.ts";

export type HostContextName = "target" | "engine" | "local";

export const ENGINE_DISTRO = "docker-desktop";

/** Where the engine context collapses onto the bare machine — the note the command prints. */
export const SAME_MACHINE = "engine and local are the same machine on this host";

export const NO_LOCAL_ROOT = "the local context on windows has no root to elevate to — run the command from an elevated shell yourself";

/** Docker Desktop's engine distro: the note naming why every command there arrives as root. */
export function engineDistroNote(targetDescription: string): string {
  return `engine runs in Docker Desktop's ${ENGINE_DISTRO} WSL2 distro — not the target's ${targetDescription} — as its default user, root (uid 0): the distro has no other login user`;
}

export interface HostExecution {
  /** Where the command actually runs, in the transport's own naming ("wsl:docker-desktop", "local", "wsl:Ubuntu-24.04"...). */
  readonly description: string;
  /** Set when this context is not actually a distinct machine here — printed by the command so the report is honest. */
  readonly note?: string;
  /** Whether the command's children are spawned by this process (true: the bare machine,
   *  identity answered here) or reach another login context through a transport (false:
   *  `id -u` is the honest probe). Drives which probe the consent gate uses. */
  readonly runsHere: boolean;
  /** Set when every command in this execution arrives as root (uid 0) regardless of path —
   *  not because it asked, but because the place it runs has no other user (Docker Desktop's
   *  docker-desktop distro: default user root, no other login). The command layer demands
   *  --root --confirm-root consent before anything runs. Only the statically-known arrival;
   *  every other context is probed at run time (probeHostIdentity). */
  readonly arrivesAsRoot?: boolean;
  exec(command: string, args: string[], options: ExecOptions): Promise<ExecResult>;
  elevate(command: string, args: string[], options: ExecOptions): Promise<ExecResult>;
}

/** What the identity probe established about the user a host command will actually arrive
 *  as — the question the consent gate is really about. The flags choose requested
 *  elevation; only this answers what would be obtained. */
export interface IdentityProbe {
  /** true: the command arrives as root — uid 0, or Windows' elevated administrator token,
   *  root's equivalent there. false: the probe provably answered otherwise. undefined: the
   *  probe could not answer — the command requires explicit consent before it can run. */
  readonly arrivesAsRoot: boolean | undefined;
  /** Where the answer came from; the consent refusal names it. */
  readonly evidence: string;
}

export interface HostEnvironment {
  readonly platform: NodeJS.Platform;
  readonly listWslDistros: () => Promise<string[]>;
  /** The identity question for the bare machine, answered from this process itself.
   *  Injected so a check can play root without being root. */
  readonly localIdentity: () => Promise<IdentityProbe>;
}

/** wsl.exe emits UTF-16LE on the versions in the field, and spawnLocal decodes bytes as
 *  UTF-8, which leaves interleaved NUL characters; stripWslNuls (runtime/transport/wsl.ts)
 *  normalizes both encodings, shared with the transport's own unreachable-target detail. */
export function parseWslDistroListing(stdout: string): string[] {
  return stripWslNuls(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

export const realHostEnvironment: HostEnvironment = {
  platform: process.platform,
  listWslDistros: async () => {
    // A rejection (wsl.exe missing or broken) is "no distros", not an error: the caller only
    // asks whether Docker Desktop's engine distro exists, and a machine without WSL answers no.
    try {
      const result = await spawnLocal("wsl.exe", ["--list", "--quiet"], { allowFailure: true });
      return parseWslDistroListing(result.stdout);
    } catch {
      return [];
    }
  },
  localIdentity: () => probeLocalIdentity(process.platform),
};

/** `--exec`, same as WslTransport's: the plain `--` form re-parses argv through the distro's
 *  default shell; --exec hands it over verbatim. Without `-u` the distro's default user runs
 *  the command — root for docker-desktop — which is why the consent gate lives in the
 *  command layer, not here. */
export function wslEngineCommand(distro: string, command: string, args: string[], root: boolean): { command: string; args: string[] } {
  return {
    command: "wsl.exe",
    args: [...(root ? ["-u", "root"] : []), "-d", distro, "--exec", command, ...args],
  };
}

/** `-n`: non-interactive sudo fails fast when a password would be required, instead of
 *  hanging on a prompt an automated caller can never answer. */
export function sudoCommand(command: string, args: string[]): { command: string; args: string[] } {
  return { command: "sudo", args: ["-n", command, ...args] };
}

const PROBE_TIMEOUT_MS = 30_000;

/** The probe's options: captured, never streamed; allowed to fail, because a refusal to
 *  answer is an answer — "unknown"; and bounded, so an unreachable target cannot stall
 *  the gate. */
function uidProbeOptions(): ExecOptions {
  return { input: "", allowFailure: true, timeoutMs: PROBE_TIMEOUT_MS };
}

/** `id -u`'s answer, or nothing: the last non-empty stdout line, and only when it is a bare
 *  number and the probe itself exited 0. A banner, a locale, a trailing CR — none of these
 *  is a uid, and the gate must never mistake any of them for one. */
export function probeUidAnswer(result: ExecResult): string | undefined {
  if (result.code !== 0) return undefined;
  const line = result.stdout.split(/\r?\n/).reverse().find((entry) => entry.trim() !== "")?.trim();
  return line !== undefined && /^\d+$/.test(line) ? line : undefined;
}

/** Asks the far side of a transport who the command would run as, BEFORE it runs: `id -u`
 *  — read-only, the auditors' own probe — against a WSL distro (its default user may be
 *  root) or an SSH host (root logins exist). Anything short of a definite uid is
 *  "unknown", never "not root". */
/** Evidence wording of the transport identity probe: where the uid answer came from. */
export function probeAnsweredEvidence(uid: string, description: string): string {
  return `the identity probe id -u answered uid ${uid} on ${description}`;
}

export function probeNoAnswerEvidence(description: string): string {
  return `the identity probe (id -u) got no usable answer from ${description}`;
}

export async function probeTransportIdentity(exec: HostExecution["exec"], description: string): Promise<IdentityProbe> {
  try {
    const uid = probeUidAnswer(await exec("id", ["-u"], uidProbeOptions()));
    return uid === undefined
      ? { arrivesAsRoot: undefined, evidence: probeNoAnswerEvidence(description) }
      : { arrivesAsRoot: uid === "0", evidence: probeAnsweredEvidence(uid, description) };
  } catch {
    return { arrivesAsRoot: undefined, evidence: `the identity probe (id -u) could not run against ${description}` };
  }
}

/** The real whoami, not whatever "whoami" PATH answers first: on a developer machine an
 *  MSYS build (Git for Windows) often comes first, and that whoami takes no /groups — the
 *  probe would then answer "unknown" on exactly the machines that run the checks. */
function windowsWhoami(): string {
  const root = process.env.SystemRoot ?? process.env.windir;
  return root === undefined ? "whoami" : `${root}\\System32\\whoami.exe`;
}

/** The bare machine's children inherit this process's identity: uid on platforms that have
 *  one, on Windows the shell's integrity level (an elevated administrator token is root's
 *  equivalent). whoami's group names are localized, so the SID literals are read instead.
 *  Best effort: anything the platform will not answer comes back undefined. */
export async function probeLocalIdentity(platform: NodeJS.Platform): Promise<IdentityProbe> {
  if (platform === "win32") {
    try {
      const result = await spawnLocal(windowsWhoami(), ["/groups"], uidProbeOptions());
      const elevated = result.stdout.includes("S-1-16-12288") || result.stdout.includes("S-1-16-16384");
      const answered = result.code === 0 && (elevated || result.stdout.includes("S-1-16-8192"));
      return !answered
        ? { arrivesAsRoot: undefined, evidence: "whoami /groups would not answer this shell's integrity level" }
        : elevated
          ? { arrivesAsRoot: true, evidence: "this shell holds an elevated administrator token (root's Windows equivalent), which local children inherit" }
          : { arrivesAsRoot: false, evidence: "this shell holds no elevated token, which local children inherit" };
    } catch {
      return { arrivesAsRoot: undefined, evidence: "whoami /groups could not run on this machine" };
    }
  }
  const uid = process.getuid?.();
  return uid === undefined
    ? { arrivesAsRoot: undefined, evidence: "this platform exposes no uid to check" }
    : uid === 0
      ? { arrivesAsRoot: true, evidence: "this process already runs as uid 0, which local children inherit" }
      : { arrivesAsRoot: false, evidence: `this process runs as uid ${uid}, which local children inherit` };
}

/** The identity probe for one resolved execution: the bare machine answers from this
 *  process, everything reached over a transport is asked directly. */
export function probeHostIdentity(execution: HostExecution, environment: HostEnvironment): Promise<IdentityProbe> {
  return execution.runsHere ? environment.localIdentity() : probeTransportIdentity(execution.exec, execution.description);
}

function localExecution(platform: NodeJS.Platform, note?: string): HostExecution {
  return {
    description: "local",
    note,
    runsHere: true,
    exec: (command, args, options) => spawnLocal(command, args, options),
    elevate: platform === "win32"
      ? () => die(NO_LOCAL_ROOT)
      : (command, args, options) => {
        const sudo = sudoCommand(command, args);
        return spawnLocal(sudo.command, sudo.args, options);
      },
  };
}

export async function resolveHostContext(ctx: Context, name: HostContextName, environment: HostEnvironment = realHostEnvironment): Promise<HostExecution> {
  switch (name) {
    case "target":
      // The deployment's own transport, verbatim. Elevation is sudo -n THROUGH the same
      // transport, which works uniformly across local, wsl and ssh targets.
      return {
        description: ctx.transport.description,
        runsHere: false,
        exec: (command, args, options) => ctx.transport.exec(command, args, options),
        elevate: (command, args, options) => {
          const sudo = sudoCommand(command, args);
          return ctx.transport.exec(sudo.command, sudo.args, options);
        },
      };
    case "local":
      return localExecution(environment.platform);
    case "engine": {
      if (environment.platform === "win32") {
        const distros = await environment.listWslDistros();
        if (distros.includes(ENGINE_DISTRO)) {
          const viaWsl = (root: boolean) => (command: string, args: string[], options: ExecOptions): Promise<ExecResult> => {
            const wsl = wslEngineCommand(ENGINE_DISTRO, command, args, root);
            return spawnLocal(wsl.command, wsl.args, options);
          };
          return {
            description: `wsl:${ENGINE_DISTRO}`,
            note: engineDistroNote(ctx.transport.description),
            arrivesAsRoot: true,
            runsHere: false,
            exec: viaWsl(false),
            elevate: viaWsl(true),
          };
        }
        return localExecution("win32", `no "${ENGINE_DISTRO}" WSL distro found — ${SAME_MACHINE}`);
      }
      // A future platform branch (macOS / Docker Desktop for Linux bridge their VM differently) is the intended extension point.
      return localExecution(environment.platform, `no separate engine VM is reachable on ${environment.platform} yet — ${SAME_MACHINE}`);
    }
  }
}

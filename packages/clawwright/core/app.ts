// Application API: how code is driven by this framework, from console and MCP. The
// framework handles transport, path translation, and container operation; an application
// supplies its own settings, commands, and secrets. Minimal example:
//
//   export default defineApp({
//     name: "hello",
//     description: "Example",
//     commands: { ping: { summary: "...", run: async (ctx) => { ... } } },
//   });

import type { Env } from "./env.ts";
import type { Context } from "./context.ts";
import type { MountPoint } from "./paths.ts";
import type { ValueParser } from "./values/value.ts";

export type ArgumentKind = "positional" | "flag" | "option" | "variadic";

/** Section `--help` groups a command under, in this fixed order (see cli.ts's
 *  GROUP_HEADINGS) — grouped by operator intent, not alphabetically. */
export type CommandGroup =
  | "start-stop"
  | "check"
  | "change"
  | "save-move"
  | "security-access"
  | "integrations"
  | "low-level";

/** Description of an argument, used for help text and for the MCP schema. */
export interface CommandArgument {
  readonly name: string;
  readonly description: string;
  /** The text the MCP tool schema shows for this argument, verbatim; absent: the schema shows `description`. */
  readonly summary?: string;
  readonly required?: boolean;
  /** How the argument appears on a command line:
   *    positional  <archive>          bare value, order matters
   *    flag        --force            present or absent, no value
   *    option      --profile share    a named value
   *    variadic    <args…>            every remaining value, in order
   *
   *  Drives help text, the MCP tool schema, and the argv an MCP call is rebuilt into, so
   *  `kind` must match what the parser actually requires. Only one variadic per command,
   *  last — the "rest" catch-all for arguments a `cli` command hands to another program. */
  readonly kind: ArgumentKind;
  /** Accepted values. Enforced before the command runs and published in the tool schema. */
  readonly choices?: readonly string[];
  /** What an option's value is — `hostId`, `n`, `artifact` — printed as `--name <valueName>`
   *  by the shared help renderer and folded into the MCP tool description. Applies to
   *  `option` only. foundation/core/command/spec/parse.check.ts fails if a declared option omits it. */
  readonly valueName?: string;
  /** Parses the typed value once, in one voice on every surface; without it the raw text
   *  reaches the command's run. Mutually exclusive with `choices` on an option. */
  readonly parse?: ValueParser<unknown>;
  /** The declared element kind of a variadic (the public carrier; spec bodies carry `value`). */
  readonly value?: ValueParser<unknown>;
  /** For a multi-action command (backup's `action` positional): which action(s) this
   *  argument belongs to. Absent for a single-action command or a shared argument. Read by
   *  help-render and by parseDeclaredArgs' cross-action lookup. */
  readonly actions?: readonly string[];
}

export interface AppCommand {
  /** One line shown in the command list and as the MCP tool's short description. */
  readonly summary: string;
  /** Grouped `--help` section. Optional on the type for bare test fixtures; the real command
   *  set cannot skip it — foundation/cli/help-groups.check.ts fails on a missing/unknown group. */
  readonly group?: CommandGroup;
  /** Longer explanation for `help <command>` and the MCP tool description.
   *  Plain paragraphs, wrapped by nothing here. Optional when summary says it all. */
  readonly details?: string;
  readonly run: (ctx: Context, args: string[]) => Promise<void>;
  /** Declared arguments; also what the MCP tool schema is generated from. */
  readonly arguments?: CommandArgument[];
  /** Commands that replace or destroy state. Exposed over MCP only with an explicit
   *  confirmation argument — a tool call is easier to trigger by accident than a typed command. */
  readonly destructive?: boolean;
  /** Keeps the console form out of MCP, for behaviour that cannot be a tool call (streams
   *  until interrupted, owns stdio for a protocol). Not permission to leave the capability
   *  unreachable over MCP: the surface is meant to mirror the terminal, so a command marked
   *  here owes either an MCP form declared beside it (a bounded variant) or an entry in
   *  MCP_EXEMPTIONS (mcp-server.ts) with the reason. mcp-mirror.check.ts enforces this. */
  readonly consoleOnly?: boolean;
  /** Works on a deployment with no .env yet — framework creates it and the gateway token
   *  before building the context. Without this, a first run fails in the settings parser. */
  readonly preparesEnvironment?: boolean;
  /** Every successful tool call returns the same envelope (declared as the tool's
   *  outputSchema): the command's captured output whole in `result`, plus whether it
   *  changed anything, what was found, what to do next. The command itself is unchanged —
   *  it already emits JSON through emit() when captured. A mixed command (some actions
   *  return plain text) still answers in the envelope, with that text as `result`; per-action
   *  change/confirmation facts belong to changedWhen/requiresConfirmationWhen instead. */
  readonly structured?: boolean;
  /** The command only observes. Lets a tool result state `changed: false` as fact, which is
   *  what makes it safe for an agent to call between steps. */
  readonly readOnly?: boolean;
  /** Refines read-only reporting for command groups with mixed subcommands. */
  readonly readOnlyWhen?: (args: string[]) => boolean;
  /** Says whether a call made a change, independently of whether it needs confirmation. */
  readonly changedWhen?: (args: string[]) => boolean;
  /** Refines which calls need explicit MCP confirmation for a mixed command. */
  readonly requiresConfirmationWhen?: (args: string[]) => boolean;
  /** Successful output carries registered credential values on purpose (`mcp-creds`), so
   *  the response redaction that guards every other answer lets it through instead of
   *  masking with "***". A failure is never exempt — the mask still applies to it. */
  readonly exportsSecrets?: boolean;
}

/** A variable the application needs, and where it is expected. */
export interface AppSecret {
  readonly name: string;
  readonly location: "repo-env" | "target-env";
  readonly usedBy: string;
  /** Required unless explicitly false. */
  readonly required?: boolean;
}

/** Mirrors service/archive/profile.ts's Profile without importing it — core/ has no
 *  dependency on service/. */
export type BackupProfile = "full" | "migrate" | "share";

/** Why an archive was created. Most backups are the operator's own data (`backup`, `pull`,
 *  or upgrade's pre-upgrade copy) and afterBackup fires for all of them. `internal` is for
 *  an archive a self-check creates only to prove the backup/restore mechanism works (smoke's
 *  round-trip and privacy checks) — never operator data, so a hook that encrypts or exports
 *  backups must not run on it. */
export type BackupPurpose = "backup" | "pull" | "upgrade" | "internal";

export interface AfterBackupInfo {
  readonly ctx: Context;
  /** Path of the published, rotated archive on the target. */
  readonly archive: string;
  readonly profile: BackupProfile;
  readonly purpose: BackupPurpose;
}

export interface BeforeRestoreInfo {
  readonly ctx: Context;
  /** Path of the archive restore was given, before anything on the target is touched. */
  readonly archive: string;
}

export interface AppDefinition {
  /** Short identifier, used in messages. */
  readonly name: string;
  readonly description: string;
  /** Extra environment defaults. Receives a copy of the parsed `.env`; returned values land
   *  in `ctx.settings.env`. Explicit `.env` values win; derived settings are rebuilt from
   *  the merged environment. */
  readonly settings?: (env: Env) => Record<string, string>;
  /** Secrets required before the service can start. Dynamic because the list usually
   *  depends on what is configured on the target. */
  readonly secrets?: (ctx: Context) => Promise<AppSecret[]>;
  /** Recipe root, relative to the deployment or absolute. An active set source takes priority. */
  readonly recipesDir?: string;
  /** How the data directory appears inside the container. The framework translates paths
   *  but does not know the image's layout, so the map comes from here. */
  readonly mounts?: (dataDir: string) => MountPoint[];
  /** Which service the runtime operates — without this the framework would have to guess a
   *  name. The container itself is found through the compose project, not named here. */
  readonly service?: {
    readonly name: string;
    readonly logTail?: string;
  };
  /** Called after a backup archive is published and rotated (already exists at `archive`) —
   *  a hook can copy it off-host, encrypt it, etc. Not called for `purpose: "internal"`. A
   *  hook that throws leaves the archive published; the command reports the hook's failure
   *  rather than deleting or hiding a backup that already exists. */
  readonly afterBackup?: (info: AfterBackupInfo) => Promise<void> | void;
  /** Called before a restore touches anything on the target — a hook can decrypt or fetch
   *  the real archive and return the path to restore from instead; returning nothing keeps
   *  `archive` as given. A hook that throws stops the restore before it starts. */
  readonly beforeRestore?: (info: BeforeRestoreInfo) => Promise<string | void> | string | void;
  readonly commands: Record<string, AppCommand>;
}

/** The dispatcher's own two commands — not app commands, not the gate's: neither carries a
 *  Context (entry/cli.ts answers them before the app.commands lookup). The one place their
 *  names live; integration/gate.ts re-exports them for its registry claim. */
export const DISPATCHER_COMMANDS = ["control-mcp", "help"] as const;

/** Turns a plain object into a checked application definition at declaration time. */
export function defineApp(definition: AppDefinition): AppDefinition {
  if (definition.name.trim() === "") throw new Error("an application needs a name");
  if (Object.keys(definition.commands).length === 0) {
    throw new Error(`application "${definition.name}" declares no commands`);
  }
  // A name the dispatcher answers would make every command of this deployment unreachable:
  // the registry's claim refuses the dispatch, so refuse the declaration instead.
  const reserved = Object.keys(definition.commands).find((name) => (DISPATCHER_COMMANDS as readonly string[]).includes(name));
  if (reserved !== undefined) {
    throw new Error(`command name "${reserved}" is reserved by the dispatcher — rename the command; the dispatcher answers ${DISPATCHER_COMMANDS.join(" and ")} itself`);
  }
  return definition;
}

/** Commands that may be exposed as MCP tools. */
export function mcpCommands(app: AppDefinition): [string, AppCommand][] {
  return Object.entries(app.commands).filter(([, command]) => command.consoleOnly !== true);
}

// Management command group: status, credentials, recipes, remote deploys and the MCP
// bridges. Split out of index.ts, which merges every group's fragment into one
// openclawCommands.

import type { AppCommand } from "#src/core/app.ts";
import { materializeCommands } from "#src/core/command/index.ts";

import { MEMORY } from "#src/commands/management/configuration/memory/index.ts";
import { STATUS } from "#src/commands/interface/status.ts";
import { CLI } from "#src/commands/interface/cli.ts";
import { EXEC } from "#src/commands/interface/exec.ts";
import { HOST } from "#src/commands/interface/host/index.ts";
import { CLI_START, CLI_STOP } from "#src/commands/interface/cli-helper.ts";
import { CONFIGURE_PROVIDER } from "#src/commands/management/configuration/credentials/provider.ts";
import { MCP_SERVE, MCP_SETUP, MCP_CREDS } from "#src/commands/management/configuration/credentials/mcp.ts";
import { DEPLOY } from "#src/commands/management/deploy/index.ts";
import { LOCK } from "#src/commands/management/lock.ts";
import { SECRETS } from "#src/commands/management/configuration/secrets.ts";
import { RECIPE } from "#src/commands/management/recipe/index.ts";
import { PROVISION_AGENT } from "#src/commands/management/provision-agent/index.ts";
import { FILES } from "#src/commands/management/files.ts";

export const managementCommands: Record<string, AppCommand> = materializeCommands({
  memory: { summary: "Declare, set up, inspect, index, verify memory", group: "change", ...MEMORY, structured: true,
    details:
      "Declares and runs OpenClaw's agent memory search. Three modes: embeddings (vector search through an embedding provider, plus keyword search), keyword (full-text search only, no embeddings) and disabled.\n" +
      "plan and configure work on this machine only: plan previews the memory settings a mode implies, configure writes them into config/desired-state.json, keeping memory options and SecretRefs it does not own. Neither touches the instance — run apply-config and restart afterwards to put them in force.\n" +
      "status reads each agent's memory state and is read-only. {--deep} also asks the embedding provider whether it is ready, which may cost money or download a model, so it needs {--allow-spend} and {--allow-download}.\n" +
      "setup prepares local embeddings: it installs the exact approved plugin version and downloads the GGUF model from an immutable source, checked against its SHA256 and a byte limit. Nothing is installed or downloaded without {--allow-install} and {--allow-download}, and every approval is checked before the target is contacted.\n" +
      "index rebuilds the memory index of the selected agents ({--agent} <id> or {--all-agents}). verify proves search works end to end: it writes a uniquely named test note into the agent's workspace memory, indexes, searches for it, then removes only that note and reindexes.\n" +
      "setup, index and verify change the instance: they take the instance lock, need confirmation over MCP, and run inside the CLI helper — start it first with the cli-start command. See docs/guide/data-and-backups.md: Declared memory." },
  status: {
    summary: "Show containers, image, health, data usage",
    group: "start-stop",
    ...STATUS,
    details:
      "Prints both health verdicts side by side — the HTTP probes (healthz/startupz/readyz) " +
      "and the runtime's own opinion —\n" +
      "because they can disagree: an image whose healthcheck binary is missing\n" +
      "reports \"unhealthy\" forever while the gateway is serving traffic fine.\n" +
      "{--json} emits the same facts structured instead of the container table, since that " +
      "table is not machine-readable: target, runtime, exposure, bootstrapped, running, " +
      "image, health, serviceUrl, dataUsage.",
  },
  lock: {
    summary: "Pin the instance's composition, or verify it",
    group: "save-move",
    ...LOCK,
    details:
      "Writes config/deployment.lock.json: the framework version, the image reference and " +
      "its resolved digest, a checksum per recipe file, a checksum of the declaration, and " +
      "the names — never the values — of the secrets the instance requires.\n" +
      "desired-state.json already reproduces the settings. What it cannot say is which " +
      "image actually ran (a tag moves, a digest does not) or which version of a recipe's " +
      "content an agent was answering from.\n" +
      "The boundary, since it is easy to over-promise: this pins the composition, not the " +
      "behaviour. The same lock brought up twice is the same code, image and content — and " +
      "the model can still answer differently.\n" +
      "{--check} compares without writing; `{clawwright inspect}` reports the same differences as " +
      "warnings, because an instance that drifted from its lock still works and it is the " +
      "reader who decides whether the difference was intended.\n" +
      "Meant to be committed.",
    structured: true,
  },
  cli: {
    summary: "Run the OpenClaw CLI in a throwaway container",
    group: "low-level",
    ...CLI,
    details:
      "Everything after `cli` is passed straight through to OpenClaw's own CLI, e.g.\n" +
      "`{clawwright cli config get gateway.mode}`.\n" +
      "By default each call is a fresh one-off container sharing the gateway's network " +
      "namespace, paying for its create/destroy on every call.\n" +
      "Run `{clawwright cli-start}` once and this execs into that container instead, skipping that " +
      "cost — noticeably faster, though both paths go through the WSL2/Docker Desktop " +
      "boundary either way and neither is instant.\n" +
      "`{clawwright cli --help}` prints this text, same as `{clawwright help cli}`; to reach OpenClaw's " +
      "own --help instead, put it after a bare --: `{clawwright cli -- --help}`.\n" +
      "Payloads travel two ways: {--stdin} pipes this process's standard input to the command, " +
      "and {--file} stages a local file into the data directory and hands its container path to " +
      "the command wherever the argument list says @file, removing the staged copy afterwards " +
      "(worked examples: the commands guide).",
    // Declared destructive not because it destroys anything itself, but because it can run
    // anything OpenClaw's CLI can — including that CLI's own destructive subcommands. Over
    // MCP that earns the same confirmation push/restore/deploy need, rather than a second
    // mechanism invented for this one command.
  },
  exec: {
    summary: "Run a command in the same sidecar as `cli`",
    group: "low-level",
    ...EXEC,
    details:
      "Unlike `cli`, which always runs OpenClaw's own CLI entrypoint, this runs whatever " +
      "command you give it, e.g. `{clawwright exec curl -fsS http://127.0.0.1:18789/healthz}` " +
      "or `{clawwright exec cat /app/docs/channels/telegram.md}`.\n" +
      "Same container as `cli`: the OpenClaw image, the gateway's network namespace, the " +
      "same data mounts, the same one-off-vs-helper choice.\n" +
      "A captured run (over MCP or a pipe) decodes its output as UTF-8 text: bytes that are " +
      "not valid UTF-8 come back as replacement characters, not the original bytes.\n" +
      "Like `cli`, this takes {--stdin} (pipe this process's standard input to the command) and " +
      "{--file} (stage a local file and name its container path with @file in the arguments).",
    // Same reasoning as `cli`: it can run anything, so it gets the same MCP confirmation.
  },
  host: {
    summary: "Run a command on the host, not in a container",
    group: "low-level",
    ...HOST,
    details:
      "Unlike exec/cli, which run inside the deployment's own containers, this reaches the " +
      "machine-side layers: a WSL distro's resolv.conf, Docker Desktop's own settings, the bare host.\n" +
      "The context is a role, resolved per platform:\n" +
      "  target  the deployment's own transport (local/wsl/ssh), the same one every other command uses;\n" +
      "  engine  wherever the container engine actually executes — Docker Desktop's docker-desktop " +
      "WSL2 distro on Windows. Where no separate engine exists (native Linux dockerd, or no backend " +
      "yet for this platform), it says so and runs in the same place as local;\n" +
      "  local   this machine, unwrapped.\n" +
      "Privilege is stated where it arrives, not where it is named. target and local run as the " +
      "operator's own user; there {--root} {--confirm-root} together elevate ({--root} alone and " +
      "{--confirm-root} alone do nothing): sudo -n, so a required password fails fast instead of " +
      "hanging; wsl -u root in the engine distro, where WSL grants it without a password; refused " +
      "outright where there is no root concept.\n" +
      "engine is the exception: Docker Desktop's docker-desktop distro has no login user but root, " +
      "so every engine command arrives as root (uid 0) before any flag is read. There the two flags " +
      "are not an upgrade but the consent the command needs to run at all — without them it is " +
      "refused, not downgraded; with them it is pinned to -u root explicitly.\n" +
      "Everything from the first non-flag argument on (optionally after a bare --) is the command, " +
      "verbatim — over MCP pass it as the args list, no leading --.\n" +
      "A captured run (over MCP or a pipe) decodes its output as UTF-8 text: bytes that are " +
      "not valid UTF-8 come back as replacement characters.",
    // Same reasoning as cli/exec: it can run anything the targeted machine allows, so it gets
    // the same MCP confirmation. --help shows this command's own help rather than passing
    // through, the same tradeoff exec makes.
  },
  "cli-start": {
    summary: "Start the persistent CLI helper",
    group: "low-level",
    ...CLI_START,
    details:
      "`{clawwright cli}` and `{clawwright mcp-serve}` normally pay for a fresh container on every call " +
      "(`docker compose run --rm`) — creating and tearing one down costs several seconds " +
      "even with a warm image.\n" +
      "This starts a long-lived container instead (same image, mounts and network as the " +
      "one-off), so both commands `docker exec` into it instead of creating a new one — " +
      "consistently faster, though the exact saving depends on how busy Docker Desktop's " +
      "WSL2 VM is at the time.\n" +
      "Idempotent. Not started by `{clawwright up}`; `{clawwright down}` removes it along with anything " +
      "else under the \"cli\" profile.",
  },
  "cli-stop": {
    summary: "Stop the persistent CLI helper",
    group: "low-level",
    ...CLI_STOP,
    details: "`{clawwright cli}`/`{clawwright mcp-serve}` fall back to a one-off container once this is stopped.",
  },
  "configure-provider": {
    summary: "Configure model providers from target env vars",
    group: "change",
    ...CONFIGURE_PROVIDER,
    details:
      "Provider ids come from models.providers/auth.profiles. A populated <ID>_API_KEY " +
      "entry in target config/.env opts into a new provider; {--env} selects a different " +
      "variable and explicit models.providers.<id>.apiKey SecretRefs are preserved. Keys " +
      "never enter openclaw.json. {--provider} and {--env} make any provider convention explicit.",
  },
  secrets: {
    summary: "Show required secrets and their state",
    group: "change",
    ...SECRETS,
    details:
      "The manifest comes from two sources, not one: explicit SecretRefs in openclaw.json,\n" +
      "plus the conventional key each configured provider expects but never references " +
      "directly (scanning the config alone misses the provider key entirely).\n" +
      "Each variable is delivered to one of two runtime locations — repo-env (.env next to " +
      "the repository) or target-env (<data>/config/.env on the target). The local store " +
      "under secrets/ is the source of truth and {--apply} delivers each value to its declared " +
      "location.\n" +
      "{--template} writes config/secrets.template.env (safe to commit: names only, no " +
      "values).\n" +
      "{--init-store} {--store} <name> creates apps/<deployment>/secrets/<name>.env to fill " +
      "in by hand —\n" +
      "it refuses to overwrite an existing store unless {--force} is given, since the " +
      "values it would destroy exist nowhere else.\n" +
      "{--apply} {--store} <name> installs that store's values into both runtime locations, and " +
      "the two locations take different paths from there: target-env values are re-read by " +
      "the gateway on restart, while repo-env values were interpolated into the container's " +
      "environment at creation —\n" +
      "so with an instance running, {--apply} recreates the container itself (it is replaced, " +
      "not merely signalled), waits for health, and confirms the new values are in force " +
      "without printing them; a stopped instance picks them up on the next start.\n" +
      "{--dump} {--store} <name> is the reverse: recovers what an already-running instance " +
      "actually holds — target-env from the target's own config/.env, repo-env (the " +
      "gateway token) from the running container's own environment, since it is never " +
      "written to the target's filesystem at all —\n" +
      "into a local store, for when the operator side's own copy was lost while the " +
      "instance kept running. A name it cannot recover is left blank and named in the " +
      "report, never guessed.\n" +
      "up/bootstrap refuse to start when something required is missing, rather than let " +
      "the gateway crash-loop.\n" +
      "Over MCP, status and template operations need no confirmation; {--apply}, {--init-store} " +
      "and {--dump} require confirm: true. {--force} remains an explicit separate choice.\n" +
      "{--json} emits the default report (names/state/where-found, never values) as JSON — " +
      "refused together with {--template}/{--print-template}/{--init-store}/{--apply}/{--dump}.",
  },
  recipe: {
    summary: "Deploy service recipes beside the instance",
    group: "change",
    ...RECIPE,
    // One envelope for every action's answer, declared once as the tool's outputSchema:
    // verify, onboard and diagnose contribute their JSON, and the text actions carry
    // their text in `result` — no action's response falls outside the declared shape. A
    // new action needs nothing here but its declared effect: an effect of read answers
    // changed: false, any other effect from the answer's own document (or true).
    structured: true,
    details:
      "A recipe is a third-party service living beside the instance — its own directory " +
      "under the deployment's recipes/, its own compose project, its own lifecycle.\n" +
      "It cannot take the gateway down with it and a snapshot never picks up its images " +
      "or volumes.\n" +
      "Building happens on the target (a fresh Rust or Go build takes minutes and streams " +
      "rather than hangs silently); a recipe kept in the repository but marked disabled " +
      "refuses `install` unless {--force-disabled} is given.\n" +
      "install, remove, verify, onboard and diagnose take the instance lock for their whole run — " +
      "install across its build, so minutes — during which other mutating operations are refused " +
      "with the holder named, and a caller that already holds the lock runs them as its own steps " +
      "instead of refusing itself;\n" +
      "list, status and logs take no lock, and neither does import or new: both write only the " +
      "repository's recipes/ directory, not the instance, so either works before bootstrap has " +
      "prepared the lock home.\n" +
      "An optional recipes/<name>/prepare.ts " +
      "hook belongs to the application and may generate private target config before build or " +
      "reconcile the running service afterwards;\n" +
      "verify.ts and onboard.ts hooks expose app-owned checks and onboarding through MCP, " +
      "gated as mutations — confirm and the instance lock — because the framework cannot " +
      "know what an app-owned hook touches;\n" +
      "install does not report success the moment up returns: recipe.json may declare " +
      "readiness — services, the compose services that must be running (healthy where they " +
      "declare a healthcheck), and timeoutMs, how long to wait, two minutes by default — and " +
      "install proceeds to afterStart only once every listed service has held that state for a " +
      "five-second grace window;\n" +
      "otherwise install fails, naming what never came up " +
      "(missing / not running / not healthy), skips afterStart, and leaves the stack for " +
      "diagnose. A recipe with no readiness declaration still gets a five-second check of every " +
      "service compose reports for the project, but no per-service wait to hold a slow starter to.\n" +
      "import copies <source> — a directory with its own recipe.json — into recipes/ under " +
      "new-name, defaulting to the source directory's own name, and refuses to overwrite; " +
      "the framework does not interpret domain-specific fields.\n" +
      "import leaves out credential-shaped names: the framework's generic set (.env*, " +
      "secrets/, *.token, *.secrets.env) plus " +
      "whatever the source's own recipe.json declares under privateFiles — a filter over file " +
      "names, not a guarantee: a credential under any other name is copied unless the source " +
      "declares it.\n" +
      "Anything left out is named: skipped: N file(s) — <path> (<reason>), ...; prepare.ts, " +
      "verify.ts and onboard.ts run on this machine with the operator's rights during " +
      "bootstrap/up/recipe verify — read an imported recipe's hooks before running them.\n" +
      "Where the running recipe may keep generated credentials is a separate declaration in " +
      "the same file: privatePaths — literal, data-relative paths.\n" +
      "migrate and share snapshots exclude them, full keeps them, and the private-config " +
      "helpers refuse a private write anywhere else. The two fields are not interchangeable: " +
      "privateFiles is recipe-relative (what import copies), privatePaths is data-relative " +
      "(where the target keeps secrets).\n" +
      "diagnose bundles one report instead of several manual round trips: whether the " +
      "recipe's stack is running, a bounded tail of every service in it (not just one), " +
      "and the verify.ts hook's own result if it has one — gated like verify itself, since " +
      "it runs that same hook and the framework cannot know it is read-only.\n" +
      "list {--json} emits {recipes, bundles, broken} instead of the text catalog.\n" +
      "new scaffolds recipes/<name>/ — a minimal recipe.json and compose.yml skeleton, no " +
      "hooks by default — refuses an existing directory the same way import does; {--with-hooks} " +
      "also adds commented prepare.ts/verify.ts stubs. Repository-side only, like import: no " +
      "target, no lock.",
  },
  files: {
    summary: "Apply or preview declared deployment files",
    group: "change",
    ...FILES,
    details:
      "Reads config/files.json and syncs declared source directories into the instance data directory. " +
      "mirror prunes undeclared files; overlay prunes only ledger-owned files. Use {--dry-run} to preview " +
      "and {--apply} to write. Only data files and the ownership ledger change; the gateway is not restarted. " +
      "See docs/guide/files.md.",
    structured: true,
  },
  "provision-agent": {
    summary: "Wire a recipe's MCP server to an OpenClaw agent",
    ...PROVISION_AGENT,
    group: "change",
    details:
      "Idempotent, re-runnable: creates the isolated agent declared by " +
      "recipes/<recipe>/agent/config.json if missing, mirrors the recipe's files into its " +
      "data mount so the container can spawn its server.ts, registers it as an MCP " +
      "server, and — if agent/cron-message.txt is present — adds a cron job that sends " +
      "the agent that message on a schedule.\n" +
      "Workspace prompt files (recipes/<recipe>/agent/*.md) are declared state and get " +
      "rewritten every run, same as apply-config; anything the agent writes to its own " +
      "workspace afterward (e.g. under memory/) is never touched by this command.\n" +
      "A cron job needing a scope this deployment's \"cli\" client does not have yet " +
      "is reported for manual approval through a trusted admin session or the Control UI; " +
      "only accept and set try offer --with-model for explicit model approval. A scope " +
      "upgrade never starts a model turn implicitly.\n" +
      "Requires the gateway to be running ({clawwright up}).",
  },
  deploy: {
    summary: "Deploy over SSH and bootstrap the server",
    group: "save-move",
    ...DEPLOY,
    details:
      "Two separate deliveries, not one checkout copied wholesale.\n" +
      "The framework (code) is mirrored in full, deletions included, with everything " +
      "credential-bearing excluded — its own .env, apps/, data/, snapshots/, secrets/.\n" +
      "This deployment (config) is sent by name and by file: only its declaration, " +
      "desired state and recipes; its own .env, secret stores and snapshots never leave " +
      "this machine.\n" +
      "A custom recipesDir must be relative and stay inside the deployment; absolute " +
      "or external recipe roots are refused before connecting.\n" +
      "The server generates its own gateway token, so a leaked local one cannot unlock " +
      "it, and provider keys are never copied — put them in <data>/config/.env there, " +
      "same as locally.\n" +
      "Refuses to touch anything if a dependency is missing on the server, rather than " +
      "leaving it half set up.\n" +
      "Available only when the framework runs from a Clawwright checkout: there has to be " +
      "a checkout for \"mirror the framework\" to mean anything. Installed as a package it " +
      "refuses outright rather than mirroring whatever sits above the package.",
  },
  "mcp-serve": {
    summary: "stdio MCP bridge to the service's own channels",
    group: "integrations",
    ...MCP_SERVE,
    details:
      "Runs OpenClaw's own `mcp serve` and speaks JSON-RPC straight through stdio —\n" +
      "this is the bridge an MCP client (Claude Code, Codex, Claude Desktop) uses to read and " +
      "send messages in OpenClaw's channels.\n" +
      "Set up a client with `{clawwright mcp-setup}`; this command is what the generated config " +
      "actually invokes, not something to run by hand.\n" +
      "Not the same thing as `{clawwright control-mcp}`, which exposes this deployment's own " +
      "commands as MCP tools instead — mcp-setup registers both.\n" +
      "By default this is a one-off container; run `{clawwright cli-start}` first and it execs into " +
      "that container instead, cutting the wait before the client's first response — paid " +
      "once per connection either way.\n" +
      "After the gateway's container exists, the bridge waits for it to answer its health " +
      "probe — up to 90 seconds by default; {--wait} seconds overrides this (bounded at 600), " +
      "and {--wait} 0 restores the old fail-fast behaviour. Everything the wait prints goes " +
      "to stderr, never into the protocol stream.",
    // Owns stdin/stdout for JSON-RPC; cannot be a tool itself.
    consoleOnly: true,
  },
  "mcp-setup": {
    summary: "Configure project MCP servers (Claude Code, Codex)",
    group: "integrations",
    ...MCP_SETUP,
    details:
      "Registers `clawwright` (mcp-serve, the bridge to OpenClaw's own channels) and " +
      "`clawwright-control` —\n" +
      "control-mcp, this deployment's own commands as tools (status, backup, secrets, " +
      "and the rest), so they don't have to be typed by hand.\n" +
      "Writes project .mcp.json for Claude Code and .codex/config.toml for Codex. " +
      "Other servers and settings are preserved; invalid or ambiguous configuration is refused.\n" +
      "init and new-app do this automatically. Use {--client} claude or {--client} codex to update " +
      "only one client. Launch paths are resolved inside the project, without absolute host paths. " +
      "The client may still require project trust or server approval; reconnect it after setup.",
    structured: true,
  },
  "mcp-creds": {
    summary: "Print service URL, token and MCP client config",
    group: "integrations",
    ...MCP_CREDS,
    // Its whole job is handing over the credential: masking its healthy output (the
    // response redaction every other successful answer now goes through) would
    // answer with "***" where the caller asked for the token. The deliberate reveal is
    // declared here, not left as an implicit hole in the dispatcher.
    exportsSecrets: true,
    details:
      "The same information `{clawwright mcp-setup}` writes to a file, printed instead —\n" +
      "useful for pasting into a client by hand or checking what {--json}/{--token} would produce.",
  },
});

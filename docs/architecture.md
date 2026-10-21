# Framework and deployments

The repository has two layers.

**The framework** (`tools/framework/`) is all of the code. It knows how to reach a target,
translate paths between coordinate systems, operate a containerised service, build a CLI
from a declaration and expose commands over MCP. Every domain command lives here too:
`bootstrap`, `backup`, `pull`/`push`, `verify`, `secrets`, `recipe`, `provision-agent`,
`deploy`, `smoke`.

**A deployment** (`apps/<name>/`) is the configuration and data of one instance. There is
no code in it beyond a short declaration and, where needed, its own commands.

Deployments are not kept in the repository: `apps/` is entirely in `.gitignore`. That
follows from the boundary rather than being a separate decision — a deployment directory
consists of one host's paths, its keys and its snapshots, which is exactly what must not be
committed. A fresh clone therefore starts with `./clawwright new-app <name>`.

That leaves the question `./clawwright lock` raises — its committed output is a promise of
reproducibility, and a promise needs somewhere to live. The answer: a deployment directory is
meant to become a git repository of its own, separate from this one — `setupProjectMcp`
already writes it a *nested* `.gitignore` (`.mcp.json`, `.codex/`), which means nothing at all
to the monorepo's own blanket ignore and only makes sense once the directory has a `.git` of
its own. `new-app` writes that `.gitignore` too (`.env`, `secrets/`) and names the `git init`
step in its own next-steps; it does not run it automatically — that decision, like the
directory's whole existence, stays the operator's.

```
tools/framework/          package metadata and shared service definition
  core/                    types, environment, paths, argument parsing (core/io/ for output)
  runtime/                 deployment; runtime/lock/ (instance lock, its heartbeat, process identity), runtime/docker/ and runtime/transport/ by concern
  service/                 archives, inspection, OpenClaw integration and secrets
  security/                private-write boundary (security/privacy/), audit, the mutation guard serializing lock-state changes
  integration/             gates, scaffolding, listing and MCP setup (integration/mcp/)
  commands/                lifecycle, orchestration, management, sets, interface, operate
    operate/                 expose, watch, incident, recover-env — run against a live instance
  set/                     artifact and ownership modules
  docker-compose.yml       the service definition, shared by every deployment
tools/clawwright.ts               the gate: picks a deployment and hands over to the framework
apps/openclaw/            git-ignored: one host's configuration
  app.ts                  which service is managed and which commands are available
  .env                    paths, port, image, token (git-ignored)
  config/desired-state.json
  secrets/<target>.env    key values (git-ignored)
  recipes/<name>/         things that live beside the instance
```

Every source directory here caps at 7 direct entries and every file at 700 lines
(`tools/checks/foundation/layout.check.ts`); hitting either means regrouping by meaning into a
subdirectory, never raising the limit or dropping a new file into whichever directory still has
room (see CONTRIBUTING.md).

`docker-compose.yml` lives inside `tools/framework/` rather than at the repository root, so
that it ends up in the npm package if the framework is ever installed as a dependency in
someone else's repository instead of being used colocated as in this checkout (see the
notes in `core/env.ts`/`runtime/deployment.ts`).

Run `npm run format:check` for the native TypeScript check and Oxlint before opening a
change. Public modules and exported functions use short TsDoc comments that describe their
contract; implementation comments are kept to the decision they explain.

## How it is put together

A command does not know where the target lives or how to reach it. It is handed a context
with three abstractions:

* **Transport** — run a command and read a file on the target: locally or through
  `wsl.exe`. Selected by `OC_TARGET_LOCATION` (`auto`: Windows → WSL, Linux → local).
* **Runtime** — Docker. The only supported value, but the contract leaves room for a native
  installation: not one command mentions `docker`.
* **Path bridge** — translation between four coordinate systems: our side (the same location
  spelled three ways — a Windows path, its WSL automount, and its Git Bash form), the target
  (`/srv/openclaw/data`), the container (`/home/node/.openclaw`) and the remote server.

Why the bridge is a separate thing:

* `docker compose` runs on the target and is handed a path to the compose file — a
  Windows-side path is meaningless there;
* arguments that end up **inside** the container have to be in container coordinates;
* the automount point is configurable in `/etc/wsl.conf`, so `/mnt` is not a constant;
* bind mounts are nested (`workspace` inside `config`), and translation has to prefer the
  longest match — otherwise a path silently lands in a different mount.

Calling `wslpath` is not an option: backslashes do not survive the trip through `wsl.exe`, so
a Windows path loses its separators and arrives as one fused segment. Translation is done in
our own code and covered by checks (see "What `./clawwright check` covers" below).

**TypeScript is executed directly** (type stripping), with no build step and no `tsx`. The
flip side: constructs that need code generation are unavailable — `constructor(private x)`,
`enum`, `namespace`, decorators. All code is asynchronous, and commands are passed as
argument arrays (no string building for a shell).

There is one runtime dependency, `json5` — OpenClaw's own configuration is JSON5, and a
second parser written here would disagree with it eventually. So `npm install` is a
prerequisite of the gate in this repository, as [Quick start](../README.md#quick-start) says;
the published package declares it as a dependency and npm installs it with the package.

The only shell file is `clawwright`: it runs before Node and only looks for a suitable Node.

### Combinations, and which of them are proven

Target location and runtime are independent axes. There is one runtime today; the contract
leaves room for a native installation, but no such setup exists.

| Combination | `OC_TARGET_LOCATION` | Status |
| --- | --- | --- |
| WSL + Docker | `auto` (from Windows) or `wsl` | **Verified live 2026-09-08**: smoke 8/8, a round trip with matching checksums, a second deployment with its own port and token |
| Local + Docker | `local` | **Unverified**: needs Node 24+ inside WSL, where there is none |
| SSH + Docker | `ssh` + `OC_SSH_HOST` | **Unverified**: needs a server. Delivery contents are checked against a recording transport (`./clawwright check`); there has been no live run |

What is unverified says so on purpose: the code is written and covered by checks, which is
not the same thing as a scenario that has run.

## Why the boundary runs here

Domain commands used to be considered part of the application. That turned out to be wrong:
they are reusable — two deployments of the same service need the same `bootstrap`. What
differs between them is not logic but configuration: the data directory, the port, the
keys, the snapshots.

So:

* **the logic moved into the framework**, knowledge about OpenClaw included — that is its
  domain;
* **a deployment became a directory**, not code.

The same boundary decides what the framework may *not* carry. Anything that belongs to one
particular business — an agent's persona, the wording of a prompt, the natural language it
speaks in, the meaning of a specific recipe — is deployment content. `provision-agent` is
the example to reason from: the framework knows how to give a recipe's MCP server an agent
of its own, and knows nothing about what any given agent is for.

## What provides isolation

Every configuration path is resolved relative to the deployment directory, not the
repository root. This is not cosmetic: if `.env` were looked up at the root, two
deployments would silently share one set of keys.

The service definition (`docker-compose.yml`) is shared; only the project directory handed
to compose differs. That is where it reads the specific deployment's `.env` from.

One identifier for everything: the deployment directory's name becomes the compose project
(`--project-name`, not a `COMPOSE_PROJECT_NAME` copied from a template), the archive prefix
and the recipe project. The container is not named in compose: it is found through the
project and the service — `docker ps --filter name=` matches substrings, and a neighbouring
deployment's container would answer for ours.

`./clawwright new-app` hands a new deployment its own directories (`/srv/<name>/…`) and the first
free port, and `up` refuses to take a port belonging to another project. Names that become
paths (`--app`, `--store`, a recipe) are validated: `--store ../../other` would read
another deployment's keys.

## Adding a second deployment

```bash
./clawwright new-app staging        # a directory with .env, config/, secrets/, recipes/
# edit apps/staging/.env: its own OC_DATA_DIR and port
./clawwright --app staging bootstrap
./clawwright --app staging status
```

## The second distribution route: the framework as an npm dependency

Everything above describes monorepo mode: the framework and `apps/` in one checkout. The
framework has a second, independent entry point — `tools/framework/entry/bin.ts` (after the build,
`dist/entry/bin.js`) — which is installed as an npm package into someone else's repository and
works with exactly one deployment at that repository's root, with no `apps/<name>`: there
is nowhere for neighbours to come from there. Both entry points share one dispatcher
(`cli.ts`), so the command set cannot drift; what differs is only what genuinely is
different: `tools/clawwright.ts` resolves `apps/<name>` from the monorepo root (`monorepoRoot`,
`core/env.ts`), `entry/bin.ts` resolves the single deployment from its own `cwd`; `new-app`
(integration/deployment/scaffold.ts) generates a declaration with a relative import into `tools/framework/`,
`init` (integration/deployment/init.ts) with a package-specifier import (`@phpcraftdream/clawwright/app`), because
outside the monorepo the relative path does not exist.

The practical flow, and why packaging raw `.ts` does not work, are in
[docs/guide/deploy-and-mcp.md](guide/deploy-and-mcp.md), under "Installing in a separate
repository". Releases publish the built package from `tools/framework`; the repository's CI
checks the generated tarball before release.

Choosing a deployment: the `--app` argument, the `OC_APP` variable, otherwise `openclaw`.

## One declaration, three surfaces

A command is declared once — summary, longer explanation, arguments — and that declaration
produces the `--help` screen, the MCP tool schema, and the argv an MCP call is turned back
into. They used to be written separately, which is how `--profile` came to be declared a
flag while the parser wanted a value: over MCP it arrived as a bare `share` and was taken
for a file name.

This is also what makes the MCP surface a *mirror* rather than a subset. Everything `./clawwright`
can do from a terminal is offered as a tool, including the commands that run before a
deployment exists (`check`, `new-app`/`init`) — those are declared as `GateCommand`s
(framework/integration/gate.ts) for exactly this reason: the gate needs dispatch and help, the server
needs a schema, and a capability that only one of them knows about is how a surface drifts.

Two shapes of the same capability are allowed where the console behaviour cannot be a tool
call — `logs` follows on a terminal and returns a bounded tail under a sink. What has no
tool at all is listed in `MCP_EXEMPTIONS` with its reason, and `mcp-mirror.check.ts` fails
on anything that is neither mirrored nor listed. The promise is checked, not asserted.

Every name the dispatcher resolves is an entry of one registry (`commandRegistry`, framework/integration/gate.ts):
the deployment's commands, the gate's, and the two the dispatcher owns, `control-mcp` and `help`.
`--help`, the unknown-command suggestion, the MCP schema's argument descriptions (each argument's declared
`summary`), shell completion and the command table in docs/guide/commands.md all read it, so none of them has
a hand-kept list of names. Completion is a data table built from the registry plus a fixed interpreter per
shell, proven equal to a reference implementation by differential checks against real bash and PowerShell;
the table in the guide is generated (`npm run docs:commands`) and compared byte for byte.

## The command spec: one body, one parser, one pipeline

Declaring arguments once was the first step; the rule it left open was *who keeps the
declaration and the parser in agreement*. Each command used to carry a hand-written parser,
a handful of predicates over raw argv (`readOnlyWhen`, `changedWhen`,
`requiresConfirmationWhen`) that told confirmation and change-reporting what the call would
do, and a second copy of its flags per action — all kept equal by call-site discipline, and
each pair drifted sooner or later. Now every command of the framework is a *body* plus a
line of prose, and what used to be separate copies is derived.

**Body and entry.** The implementation module exports a body (`commandBody` for one action,
`multiActionBody` with `defineAction` per action, in `core/command/spec.ts`): the arguments
with their value rules, the effect, optional `prepare` and `run`. The group file
(`commands/interface/groups/`) holds the prose beside it — `{ summary, group, details,
...BODY }` — and `materializeCommands` turns each entry into the ordinary `AppCommand` every
surface already reads: `arguments` is a view derived from the body, `run(ctx, argv)` parses
and runs it on a context the caller holds. The body helpers are internal; the public
`AppCommand` shape, with its three predicates, stays for the commands an application
declares itself, and those still run on a legacy path through the same pipeline.

**One parser.** `core/command/parse.ts` tokenizes and binds. The action word selects the action
(`defaultAction` when there is none or the first token is a flag; otherwise an unknown or
missing action is refused with the choices and a guess). `--opt value` and `--opt=value` (taken
literally), a repeated option, a missing value, `--flag=…` and an unknown flag are refused
in fixed words; a flag declared by another action is refused naming that action; a bare `--`
ends the options. A value is typed by its declaration: `choices` is a closed list, `parse`
is a value parser (`core/values`: counts, ports, durations, intervals, image references —
each with an `example` and an `invalidExample`), and with neither the value must be non-empty.
Values are bound in typing order, so the first bad one is the one reported, then the missing
required ones. Two additions: `refuse` on a body or an action lists exact tokens refused with
a declared reason before anything is tokenized (`expose tailscale --funnel` — a refusal, not
an argument, so absent from help and the schema); `verbatim: true` on a variadic makes the
tail literal from its first token (`host target --root ls -la`) and is declared only by `cli`,
`exec` and `host` — every other variadic keeps recognizing flags anywhere. A refusal is an
`ArgumentError` carrying the declared name of the argument, so callers read structure, not
prose; the console and MCP show the same words.

**Effect.** A body, an action or a flag declares `read`, `change` or `destroy`. A call's effect
is the action's (or the body's), raised by the effect of the flags given, and lowered to
`read` by a flag that declares it (`--dry-run`, `--check`). Everything that used to be a
predicate derives from it (`core/command/effect.ts`): MCP's confirmation (`destroy` without
`confirm: true` is refused), the `changed` flag of the result envelope, the `confirm` field and
the markers in the tool schema and the command list, the note in `--help`, and whether the
environment is prepared. A flag marked `setByConfirm` (`restore`, `push`: `--force`) is set by
an MCP `confirm: true` rather than by the caller. A `needs: "deployment"` body runs without a
`Context` (`recover-env`, which repairs the facts a context is built from).

**The pipeline.** `executeCommand` (`core/command/execute.ts`) runs a call on either surface through
fixed stages, returning — never throwing — where it stopped:

1. `parse` — tokenize and bind; nothing is read.
2. `confirm` — on MCP, a `destroy` call without `confirm: true` stops here.
3. `prepare` — the body's refusals that need only the arguments and local files, through a
   `LocalScope` that has no `Context`, transport or runtime in its type.
4. `environment` — `.env` is created for a mutating call of a `preparesEnvironment` body.
5. `context` — the context (or deployment scope) is built.
6. `run`.

So an argument error never reaches a target, a lock or a `.env` write, on any host. On the
terminal, a failure of an action that declares a `json` flag, called with `--json`, prints the
`{"error":…}` document unless the call already printed something or the error was an unknown
argument. `runApp` and the MCP dispatcher are thin callers of it.

**The property check.** `foundation/core/command/pipeline/property.check.ts` does not list
commands. For every command and action of `openclawCommands` and every argument that declares
`choices` or `parse`, it builds an argv from the declarations alone — the action word, an
example for each preceding positional, the argument with its `invalidExample` (an empty value
for an option without a parser) — and runs it through `executeCommand` with a recording
transport, once as the terminal and once as MCP (through `toArgv`). It expects the `parse`
stage, an `ArgumentError` naming that argument, no transport contact, and the `--json`
document only where the action declares `json`. A new command or value rule is covered the
moment it is declared; one that is not declared has no parser to forget.

## Problem codes are a public contract

`framework/service/inspection.ts` holds a table of codes — `CONFIG_DRIFT`, `SECRET_MISSING`,
`RESTART_REQUIRED`, `RECIPE_MIRROR_DRIFT`, `AGENT_MISSING`, `MCP_SERVER_MISSING`,
`CRON_DRIFT`, `GATEWAY_DOWN`, `GATEWAY_UNHEALTHY`, `LOCK_MISSING`, `LOCK_DRIFT` — and each
carries its severity and the command that resolves it. Six commands read that one table:
`inspect` produces the codes, `doctor` renders them, `plan` orders the remedies, `apply`
executes them and asks again, `lock` contributes two of them.

Severity and remedy are properties **of the code**, not arguments a call site passes. A
caller can add detail — what was observed, with values — and can narrow a remedy to one
named recipe, but it cannot decide that its own `CONFIG_DRIFT` is merely a warning or
suggests something else. Without that, "the same situation always produces the same code"
would be a convention, and conventions decay silently.

They are matched on by callers, which makes renaming one a breaking change on the same
footing as renaming a command. `inspection.check.ts` lists the names explicitly so a rename
shows up in a diff rather than in someone's broken automation.

A finding's severity is what "healthy" means: blocking findings say the instance is not
doing its job, warnings are differences worth naming that still work. `./clawwright doctor` fails on
the first kind and not the second — a check that objects to everything stops being consulted.

## Advice is data

Most of what a command says at the end is advice: the remedy a problem code carries, the way
out of a refusal, the scheduler line `watch install` offers. That text used to be written as
a string at each of those places and rewritten on the way out to the invocation it printed
under — `./clawwright` back to `clawwright` under a global install, `--app <name>` added for a
non-default deployment — and the rewriting did not stop at JSON documents, so a document
could describe a call the user never made and a cron line could come back spelled for a
shell it was not written for.

Advice is now a value: a clawwright command (its arguments, and the deployment when it has to
be named), a line for another shell, host or scheduler (cron, `schtasks`, a command on a
server), or an action with no command in it. One renderer (`core/io/invocation/render.ts`)
turns a value into text, and it is the only place the `--app` rule and the program spelling
live. That is the invariant worth stating: **a clawwright command reaches output only through
the renderer, from data; a line written for another shell, host or scheduler is its own
advice, and nothing rewrites it.** A `schtasks` line, a server command and a JSON document
come out exactly as built under every invocation — including one they were not built for.

What the user sees is one command in one set of words wherever it appears — an error's `→`
line, a problem code's remedy, `nextActions` in a document — spelled for the invocation that
printed it, with the remedy carried as data as well: `next` on the problems and documents
that name one, `nextSteps` in the MCP envelope. Help prose names a command by a token
(`{clawwright …}`, a flag by `{--flag}`) that only the help renderer fills in, checked against
the specification by `tools/checks/surfaces/help-prose.check.ts`, so a renamed flag breaks
the check rather than the help. An application's own `details` — its own `./clawwright`
included — is no longer rewritten either: what the declaration says is what prints.

## Structured results for the MCP surface

A tool result carries text for a person and, for commands declared `structured`, a
`structuredContent` envelope for an agent: `operationId`, `changed`, `healthy`, `problems`,
`warnings`, `nextActions`, `nextSteps` (the same remedies as tool calls), and the command's own JSON
whole under `result`. The command does
not change to produce it — it already emits that document through `emit()` when its output
is captured, which is what `--json` prints on a console.

Only what is known is filled in. A command that does not report whether the instance is
healthy leaves the field absent rather than defaulting it: a gap can be seen, a default that
looks like an answer cannot. `changed` is a fact for a command declared `readOnly` and an
assumption otherwise — a mutating command that says nothing is taken to have changed
something, because an agent that re-checks needlessly loses a call while one that skips a
check it needed loses the thread.

## Two rollbacks, kept apart — and a third, for the image

`./clawwright rollback` restores one file: the configuration a run replaced. `./clawwright push` restores the
data directory from a snapshot: configuration, workspaces, agent memory, transcripts — the
lot. They look adjacent and are not, and the moment someone reaches for the wrong one is the
moment they have already broken something.

The distinction is what makes the cheap one cheap. Because `apply` only has to copy one JSON
file aside, it can do so on every run without asking, which means the undo is always
available. If undoing a bad configuration cost an agent a week of accumulated notes, nobody
would use it, and the transaction would exist on paper only.

`./clawwright upgrade` adds a third kind, at the image layer rather than the configuration or the
data: it records the digest running before the change, and on any failure recreates on that
exact digest — never the tag, which may have moved again since. Whether the data also needs
putting back is not asked once, up front; it is answered by what actually failed. A container
that exits mid-startup for an ordinary reason gets the digest rollback alone, the same as a
plain health-check failure — nothing suggests the data changed, so nothing about it is
touched. A container that exits with the specific code OpenClaw's own migrations use when
they refuse to proceed (78) gets the pre-upgrade backup restored too, because a migration
reaching that far may already have written to the data directory before deciding it could not
finish safely. Conflating the two would either restore data unnecessarily after a failure that
never touched it, or — worse — recreate on the old digest while leaving half-migrated data in
place, silently, because nothing more disruptive seemed warranted.

## A stale lock is reported, not taken

Every mutating command holds a lock on the target for its duration, and a second one is
refused with the holder and what it is doing. A lock whose heartbeat has gone quiet for ten
minutes — or, for a record from before heartbeats existed, one simply taken more than half an
hour ago — is described as stale, with the fact that makes it so, and the flag that overrides
it, and is still refused.

Taking it automatically would be the same bug one layer down: the run that lost its lock has
no idea, and now two of them are writing again. The person reading the message can see
whether that process is really gone; this one cannot.

**The holder proves it is alive, on an interval, not just by having been taken recently.**
`recipe install` holds this same lock across a whole build, and a build routinely runs longer
than the thirty minutes a lock's age alone used to tolerate — the refusal used to call that
"longer than any operation should take" and point at `--break-lock` regardless, which was
simply wrong for a live run. The holder now rewrites its own `heartbeatAt` every thirty
seconds (`runtime/lock/heartbeat.ts`, an `unref`'d interval that never keeps the process
alive on its own, cleared on release) for as long as it holds the lock, and staleness is
judged from `heartbeatAt` once a record has one — ten minutes of silence, not thirty minutes
since acquisition. A record with no `heartbeatAt` at all (written by a framework version
before this field existed) keeps the old thirty-minute-since-taken rule, since it never
recorded anything else. The rewrite goes through the same write-temp-then-rename primitive
every holder write already uses (`transport.writeFile`), so a reader never observes a partial
record, and a refresh failure is swallowed — the lock must never crash the command over a
heartbeat write — with only the first one logged, at debug level (`OC_DEBUG=1`), since every
one after it restates the same fact. A refusal now says which of the two is true — "not
refreshed for N minutes" or "refreshed N seconds ago — the operation is still running" — and
only ever suggests `--break-lock` once the holder is actually stale or provably dead; a live,
recently-refreshed holder is told to wait, or to run `./clawwright operations <id>` to see what
it is doing, never to break its own lock.

The generation check and heartbeat publication run together under the same
`operation.mutation` guard as acquisition, takeover and release. Only one refresh can be in
flight per holder; guard contention skips that tick and retries on the next interval rather
than breaking another mutation's guard. Release cancels future ticks and drains the refresh
already started **before** acquiring the guard for removal: draining inside the guard could
deadlock a refresh waiting to acquire it. A refresh cancelled while awaiting the guard or
reading the holder does not publish; a write already started finishes before release removes
the lock. Thus an old heartbeat cannot replace the next holder's record or prevent that
holder from releasing its own lock. Controlled transport barriers in
`runtime/convergence/instance-lock/heartbeat/heartbeat-lifecycle.check.ts` cover delayed reads/writes,
queued guard acquisition, takeover, and refresh/guard-publication failures without real delays.

The lock is a **directory**, and that choice is the mechanism rather than an implementation
detail: creating a directory that already exists fails, atomically, on every POSIX filesystem,
and the same single `mkdir` works through `wsl.exe` and `ssh` alike. It must not be `mkdir -p`
— that succeeds on an existing directory, which would make the test no test at all. A holder
file is written inside once the directory is won, so a directory with no readable holder is
treated as held by someone unknown and refused: a run that won it and died before naming
itself is not a reason to proceed.

The takeover flag is `--break-lock` and deliberately not `--force`. `--force` already means
"yes, I mean it" for a destructive command. MCP confirmation supplies `--force` only to
commands that explicitly use it to skip their terminal prompt; it never grants lock takeover.
Sharing the name would collapse two permissions into one.

A lock outlives a run killed by a signal — a closed pipe will do it — because a `finally`
does not run then. That is what the staleness report and `--break-lock` are for; there is no
cleanup path that survives `SIGKILL`, and pretending otherwise would be worse than saying so.
Every pid a lock or guard records is the CLI process's own — wherever `clawwright` itself runs,
never anything living on a WSL or SSH transport's target — so liveness is always checked
locally, with the tool's own `process.kill(pid, 0)`, regardless of which transport reaches the
deployment. When the outer instance lock's holder was recorded on this same machine and its
pid is provably gone, the refusal says so plainly instead of only reporting age; and since
holder records carry a boot identity and a native process start time, that same record can
prove death on its own — a different boot id, or on the same boot a gone pid or a replaced
one — and the next operation then takes the lock over automatically through the audited
takeover, the design's single automatic exception; everything the record cannot prove still
requires `--break-lock`.

The short-lived `operation.mutation` guard records its owning process the same way: a dead
owner on the same machine is recovered automatically, and an ownerless guard can be recovered
with `--break-lock`. A live or unverifiable guard is kept until it can be checked from its
owner machine — including a guard whose recorded owner is a **different** machine, since a
remote pid's liveness cannot be probed from here at all, and neither `--break-lock` nor a
guessed PID proves it dead.

**Runbook — taking over a guard orphaned on another machine.** First, actually verify: reach
the recorded machine (`owner.json`'s `machine` field) and confirm its `clawwright` process is
gone — a crashed run, not a slow one. Only once that is certain, run any lock-taking command
with `--break-foreign-lock <hostId>` — every command that accepts `--break-lock` accepts this
too, plus `secrets --apply`, which never accepts `--break-lock` but still takes this narrower,
host-confirmed override. `<hostId>` is exactly that recorded `machine` value.
That value is the host name plus its pid space (`PC:win32`, `PC:linux-4026531836`): Windows
Node and a WSL distro's Node on one PC share a host name but not pids, so each treats the
other's records as foreign rather than probing a pid that means nothing on its side.
A mismatch refuses outright, naming what was actually recorded, so a copy-pasted wrong host id
cannot silently take over the wrong guard. A match takes it over and appends one line to
`<data>-locks/foreign-lock-takeovers.jsonl` — who did it, when, and the exact foreign owner
record it replaced — a durable audit trail beside the lock home, since the guard directory
itself is removed once the takeover completes. This is never automatic and never inferred from
age or a guessed pid: it exists only for an operator who has already confirmed the other
machine is not running that operation anymore.

A failed `mkdir` is not evidence of a lock, only of a failure. Reading every non-zero exit as
"held" turned an unwritable directory into a confident report about a lock that did not
exist, complete with a `--break-lock` suggestion that removes nothing and then fails
identically. Probing the directory afterwards separates the two, and the unexplained case
keeps its own error text rather than being given someone else's story.

Not every lock-taking command accepts `--break-lock`: `backup` and the internal round-trip
step inside `smoke` guard a single operation each time they run and take no takeover flag at
all — their own parsers reject it, by design, the same way `--force` is not accepted
everywhere either. `configure-provider` used to be in this list too, with its refusal pointing
at `up --break-lock` since it had no way out of a genuinely stuck lock of its own; it now
threads `--break-lock` like every other ordinary lock-taking command instead. `secrets --apply`
also refuses `--break-lock`, for the same
reason, but is not in that group: it still accepts `--break-foreign-lock`, since the guard an
orphaned owner on another machine leaves behind blocks it exactly like every other mutating
command, and a host-confirmed takeover is never the blunt "just take it" `--break-lock` is. A
refusal from a command with no takeover flag at all never advises one; it names a command
that does accept it instead (`up --break-lock`, the simplest one), so the advice a reader gets
is always something they can actually run.

Every crash that can leave `operation.lock`/`operation.mutation` behind can leave a Docker
runtime's own temporary compose env-file directory (`<data>-locks/compose-<uuid>/`) behind
too — it carries `OPENCLAW_GATEWAY_TOKEN` in plain text for the one `docker compose` call it
was made for. Each such directory now records its own creator (pid and machine, written before
the token-bearing file, not after) so a later call can tell a genuinely abandoned one — same
machine, pid provably gone — from one a concurrent call is still using, and sweep only the
former. An unreadable or missing owner record is left alone rather than guessed at, the same
"report, never silently act" rule as everywhere else in this file.

A failed `mkdir` is not evidence of a lock, only of a failure. Reading every non-zero exit as
"held" turned an unwritable directory into a confident report about a lock that did not
exist, complete with a `--break-lock` suggestion that removes nothing and then fails
identically. Probing the directory afterwards separates the two, and the unexplained case
keeps its own error text rather than being given someone else's story.

## Acceptance belongs to the deployment, its kinds to the framework

`smoke` proves the instance works. Whether a recipe's wiki is reachable, or its agent has the
tools it was given, is a property of one deployment and the framework has no business knowing
it. So a recipe declares its checks in `acceptance.json` and the framework runs them: the
kinds are the framework's, the declaration is the deployment's, and no code travels between
them — the same boundary `provision-agent` draws for prompts and cron messages.

Checks that call the model are declared as such and never run by default. They cost tokens,
and an agent turn has side effects of its own: it writes to that agent's workspace. A suite
that quietly did that on every run is a suite people stop running. What was skipped is always
named and counted, because a suite that silently omits what it did not run reads as coverage
it does not have.

A check asks whether the call succeeded before asking what it said — the JSON-RPC error, the
tool's own `result.isError`, and the exit code of the process that served it. Reading only the
text let a tool answering "no such page" pass whenever the expected string happened to appear
in that message, and a check that cannot fail reports success on a broken deployment.

## What counts as a change to a recipe

Two checksums per recipe, not one. The **mirror** is what the recipe serves — the files
provision-agent copies to the target. The **agent bundle** is `agent/`: the prompts, the
identifiers and the cron message, which never reach the mirror because they are written into
the agent's own workspace instead.

Excluding the bundle from the mirror is right. Letting that exclusion be the only checksum was
not: the lock, the plan's staleness check and the inspection all read one number, so editing
`AGENTS.md` changed what the agent does while every one of them reported no change, and
`apply` left the old prompt in force. They answer different questions — has the served content
changed, and has the agent's own definition changed — and both mean the recipe needs
re-provisioning, while only the first means the mirror is stale.

The cron job is part of that declaration too, and its contract is the whole of what
`provision-agent` reconciles: the agent, the schedule, the session target, the message and the
timeout. The inspection compares it by calling the same `cronJobMatches` rather than listing
those fields again — when it compared only the name and the schedule, a job carrying a
withdrawn message reported no drift while the next `provision-agent` replaced it on sight.
One thing defined twice will disagree; the only question is when someone notices.

A lock that pins less than this framework records is itself a finding. Comparing a field only
when the *locked* side already has it makes an absent one read as agreement — the gap then
reports nothing and hides itself, which is how a reproducibility claim comes to cover less
than it says while every check stays green.

## A deployment's own commands

A deployment lists the framework's commands and may add its own:

```ts
export default defineApp({
  name: "staging",
  service: { name: "gateway" },
  mounts: mountPoints,
  commands: {
    ...openclawCommands,
    seed: { summary: "Fill with test data", run: async (ctx) => { /* … */ } },
  },
});
```

A command receives the context: `ctx.transport` (access to the target), `ctx.paths` (path
translation), `ctx.runtime` (operating the service). Where the target lives and what
runtime is there is none of its business.

### `expose`: narrowest scope first

`./clawwright expose` reaches a loopback-bound gateway from outside this host without ever
publishing it: `ssh` prints (and, with `--run`, opens) the SSH tunnel for
`OC_TARGET_LOCATION=ssh` deployments; `tailscale` prints (and, with `--apply`, applies) a
tailnet-only `tailscale serve` — `tailscale funnel`, the public-internet sibling, is refused
outright, with the reason, because it is exactly what `OC_BIND_ADDRESS`'s loopback default and
`.env.example`'s own guidance exist to avoid; `status` reads the bind address and port back
from the running container rather than trusting `.env`, which can be stale the moment
`OC_BIND_ADDRESS` is edited without a recreate — the same class of drift `recover-env` exists
to catch for the other connection facts.

Its implementation lives at `tools/framework/commands/operate/expose/`, grouped with `watch/`,
`incident/` and `recover-env/` — things an operator runs against an already-deployed instance,
as distinct from `management/`'s configuration commands and `lifecycle/`'s start/stop/backup
ones. It is wired into `managementCommands` exactly like every other command's `run` — the
`--help` grouping there is by operator intent (`CommandGroup` in `core/app.ts`), independent of
which directory a command's implementation lives in — resolved through the same `#src/*` import
map every other module uses.

### `watch`: liveness only, transitions only, and one place each finding lives

`./clawwright watch check` answers a narrower question than `inspect`/`doctor`: not "does the
instance match what this repository declares", but "is it doing its job right now". It calls
the same `gatherInspection()` those two commands do — a second gatherer would eventually
answer the same question differently, which is exactly the reasoning `gather.ts`'s own header
already states for `inspect` and `doctor` sharing one — and keeps exactly these liveness
problem codes, in the order `LIVENESS_CODES` lists them: `NOT_BOOTSTRAPPED`,
`TARGET_UNREACHABLE`, `GATEWAY_DOWN`, `GATEWAY_UNHEALTHY`, `EGRESS_UNREACHABLE`,
`CHANNEL_UNKNOWN`, `CHANNEL_PROXY_DOWN`. Severity decides the bucket, read rather than re-decided: a blocking
liveness finding is `down`, a warning one is `degraded`, none at all is `ok` — so `watch` can
never disagree with `doctor` about what counts as blocking.

The state that decision is compared against lives beside the deployment's own `.env`, in
`state/watch.json` — the deployment's operator-side directory, never `<data>/config` on the
target. That split matters here more than almost anywhere else in this framework: the whole
point of watching an instance is noticing when it goes down, and a state file that lived on
the target would be exactly as unreachable as everything else the moment that happens. It is
published the way every other control file in this codebase is (`set/ownership/ledger.ts`'s
`writeFileAtomic`, `security/privacy/private-file.ts`'s `replacePrivateFile`): written to a temporary
sibling and renamed over the final name, so an interrupted write can never leave a state file
a reader mistakes for valid.

An alert (`OC_WATCH_WEBHOOK`, https unless the host is localhost/127.0.0.1) fires exactly on a
transition — never on an unchanged state, never twice for the same one, and never at all on
the very first cycle after `watch install` (there is nothing to have changed FROM yet, so it
establishes a baseline instead of paging on one). A failed delivery leaves the persisted state
at its OLD value on purpose: the next cycle still sees the same unreported transition and
retries the alert, rather than quietly accepting the new state as normal. The webhook URL is
registered with `core/io/log.ts`'s secret masking the same way `OPENCLAW_GATEWAY_TOKEN` is
(`core/context.ts`), and nothing in `watch/` ever hands it to `log()`/`info()` in the first
place — masking is the second layer, not the only one.

`watch install`/`watch uninstall` only ever install a crontab entry — never a systemd --user
timer, which needs `loginctl enable-linger` and a systemd-as-PID-1 assumption neither is
guaranteed to hold — and only where an unattended cron can be trusted to find this tooling's
own node and checkout at all: a real SSH host (`./clawwright deploy` already mirrored the checkout
there) or a POSIX `local` target (tooling and target are the same machine). A WSL target's
Docker distro is a container host, not a place this tooling is proven to also run, and Windows
itself has neither cron nor systemd — for both, the command prints the exact command an
operator-side scheduler would need to invoke (built from `Transport.clientInvocation()`, the
same "how would an external client reach this target" question `mcp-setup` already asks it)
rather than installing something that would silently never fire. Every entry is marked with a
`# clawwright-watch:<deployment>` comment so a re-run replaces only its own line and `uninstall`
removes only it, never a sibling deployment's or a foreign entry already in that crontab.

Lives at `tools/framework/commands/operate/watch/`, beside `expose/` for the same reason.

## Recipes, and agents built from them

A recipe is a `recipes/<name>/` directory in a deployment. It can be a service (its own
compose project, `recipe.json` + `compose.yml` + `Dockerfile`), an MCP server with an agent
bundle (`server.ts` + `agent/`), or both.

`provision-agent` is what turns the second kind into a working agent. The split of
responsibility follows the boundary above:

| Framework | Recipe (`agent/`) |
| --- | --- |
| create the agent, register the MCP server, add the cron job | which agent id, which server name, which schedule (`config.json`) |
| mirror the recipe's files into the data mount so the container can spawn `server.ts` | what the server serves |
| write the workspace files, rewriting them on every run | what those files say (`*.md`) |
| send the cron message on schedule | what the message asks for (`cron-message.txt`) |

Files under `agent/` are excluded from the mirror: they are host-side content, read once to
build the workspace and the job, and the container has no use for them.

Re-running the command is the same contract `apply-config` has: declared state wins.
Workspace prompt files and mirrored recipe data are rewritten to match the repository;
whatever the agent has written into its own workspace since is never touched.

### Recipe hooks are loaded fresh, not once per process

A recipe's own `prepare.ts`/`verify.ts`/`onboard.ts`/`quiesce.ts`/`resume.ts` execute from
their real location under the recipe directory — normal Node module resolution applies, so
a hook can import its own dependencies (`node_modules` in the recipe's package scope) and
relative helper files the way any other module would.

The one thing normal `import()` gets wrong here is a long-lived process: Node's module map
is keyed by URL and never invalidated, so an MCP session that imports the same hook twice
would answer the second call with the first call's module even after the file changed on
disk. The framework works around this by hashing the hook's whole local import graph —
itself, every relative import it reaches, transitively — before each load, and re-importing
under a checksum-derived query parameter whenever that hash changes; an unchanged graph
answers from the checksum-keyed cache without importing at all. Editing a helper two levels
deep is therefore visible on the very next call in the same process, the same as editing the
hook file itself.

A recipe's own package-internal `#specifier` imports (Node subpath imports, resolved through
the nearest `package.json`'s `"imports"` field inside the recipe directory) are supported the
same way: both the `package.json` and the file it resolves to join the hashed graph, so
editing the target, or repointing the import map to a different file, is picked up exactly
like a relative import. Only a target the graph can fully account for is accepted — a string
or a `{node, import, default}` conditional object resolving to a package-relative path that
stays inside the recipe directory, even through a symlink. A bare package target, an
absolute path, an escape via `..` or a symlink, a subpath pattern, or any other condition
name is refused before the hook ever executes: the checksum cannot promise freshness for an
import shape it does not fully understand, so it fails closed rather than guessing.

## Ordering on a first run

The context parses `.env` and builds a runtime around it — which means the command that
creates that file cannot run after it. Commands with `preparesEnvironment: true` (today
that is `bootstrap`) get their preparation earlier: the framework creates `.env` from a
template with this deployment's paths and port, generates a token if there is none, and
only then builds the context. The MCP server uses the same path.

Preparation only runs for a call that will actually mutate: the `environment` stage of
`executeCommand` skips a call whose effect is `read` (e.g. `bootstrap --check`) and never
reaches it with argv the parser refuses — an invalid flag creates nothing before the
parse stage reports why. Both surfaces go through that one stage.

`bootstrap` also fixes an ordering that matters for configuration: the deployment's
`desired-state.json` is applied first, and `configure-provider` runs after it. A brand-new
custom provider's `baseUrl` and model catalog come from the declaration, and OpenClaw's
schema requires `baseUrl` on any provider id it does not already know — writing just the
apiKey first leaves that entry incomplete and OpenClaw refuses the write, which used to stop
bootstrap before the declaration was ever applied.

## Where output goes

Two modes. On a terminal, output goes to the terminal and long child processes stream
through. Under the MCP server, stdout belongs to the protocol, so the log helpers, machine
output (`emit`) and child process output all go into one sink and come back as the call's
result. The mode is global, because anything down the stack can write to stdout — a helper,
the runtime, the container.

A related detail worth knowing when writing a command: a failing `runOneOff` throws, and the
thrown message truncates the child's output to a few lines — which, with `docker compose`,
is spent entirely on compose's own progress lines. A caller that needs to react to *why*
something failed passes `allowFailure` and inspects the complete result instead.

## Acceptance

Checked by grep rather than by eye:

* a deployment contains no logic — only a declaration and configuration;
* the framework does not resolve paths from the repository root (`.env`, `secrets/`,
  `recipes/`, `desired-state.json` — only from the deployment directory);
* the framework carries no business content: no application's domain vocabulary, no
  natural-language prompt text, nothing tied to one company;
* the MCP surface mirrors the console one — every command is a tool or a listed exemption,
  and every tool is a command (`mcp-mirror.check.ts`, which reads both surfaces from real
  processes rather than from the declarations they come from).

The rest is `./clawwright check` (paths, archives, arguments, delivery contents, secret masking) and
`./clawwright smoke` against a live instance.

### What `./clawwright check` covers

```bash
./clawwright check
```

A selection — `./clawwright check` runs every `*.check.ts` under `tools/checks/`, and there are
more of them than fit here:

| File | What it covers |
| --- | --- |
| `release/release/installed-consumer.check.ts` | the published tarball, installed into a directory `npm init -y` made: `init` there, then a command through the installed entry point |
| `foundation/core/paths.check.ts` | 48 translations between the four coordinate systems |
| `foundation/core/archive.check.ts` | absolute paths, `..`, links pointing outside (symlink and hard link), consistency of the `share` profile |
| `foundation/core/command/spec/parse.check.ts` | argument declarations, MCP schemas, the reverse mapping back to argv |
| `foundation/core/command/pipeline/property.check.ts` | every declared `choices`/`parse` rule, given a value it must refuse, is refused at the parse stage on the terminal and on MCP — naming the argument, with no transport contact, and a `--json` document only where `json` is declared |
| `foundation/core/command/spec/view.check.ts` | per-action slices of multi-action commands, schema descriptions as complete phrases |
| `runtime/service/deploy.check.ts` | what a server delivery contains: what travels and what stays, and that it refuses to mirror a tree that is not a checkout |
| `integration/mcp/transport-listing.check.ts` | `listFiles`: a real local tree (no separator leaks into a target path, directories are not files) and what the remote implementations make of `find` output |
| `secrets.check.ts` | masking of secrets in diagnostics, including a failing child process |
| `ssh-quoting.check.ts` | a remote script survives ssh joining its arguments into one line — checked against a real `sh` |
| `verify.check.ts` | a fatal structural finding rejects an archive before unpacking, not after |
| `state.check.ts` | a share snapshot is removed whole even when verification throws rather than returning false |
| `restore.check.ts` | a direct `restore` does not start the gateway on a config with missing secrets, does not report a corrupted config as a successful restore, and with no argument picks the newest FULL archive rather than the newest file |
| `mcp-server.check.ts` | malformed JSON-RPC (`null`, a number, an array) does not take the server down — a real stdio process, and a confirmed `recipe verify` — the one call that reaches a lock-taking command — running against a scratch app whose data directory, lock home included, stays inside the app the check removes; and `recipe import` is expressible over MCP — both forms, with and without the rename, validate clean and build the exact argv the dispatcher reads |
| `env.check.ts` | `.env` parsing (quotes, comments, `=` inside a value), `toSettings()` defaults |
| `deployment-names.check.ts` | deployment paths, `safeName` — protection against `--store ../../etc` |
| `app-mounts-output.check.ts` | `defineApp`/`mcpCommands`, the bind-mount map, nested `withOutputSink` |
| `requirements.check.ts` | collecting `SecretRef`s from the config, deduplicating provider vs explicit reference, rendering the template |
| `recipe.check.ts` | parsing `recipe.json`, `install` refusing a disabled recipe without `--force-disabled`, and the instance lock: every mutating action refused while another operation holds it — the prepare hook provably never running — the same actions riding a lock the calling chain already holds instead of refusing it, read-only actions ungated, and `--break-lock` honoured; and `import`'s exclusion contract — every name the old hardcoded blacklist excluded still excluded, the generic four with no declaration at all, the application's own names only via the source's `privateFiles` declaration, a broken source manifest stopping the import instead of reading as nothing declared, and a non-credential file copied whole |
| `security/credentials/secrets-command/*.check.ts` | `--init-store` refusing to overwrite a filled store; `--apply` aborting on a live config it could not read and naming the variables it replaces; `--apply` performing the repo-env recreate, or saying exactly why it cannot, then confirming the value in force by name and never by value; `mcp-setup` merging `.mcp.json` |
| `runtime-port.check.ts` | parsing `docker ps` through `.Label` (not `.Labels`), `preflightPort` |
| `cli-help.check.ts` | `--help` for `control-mcp`/`new-app`/`help` neither hangs nor stays silent; `help` works before any deployment exists |
| `passthrough-help.check.ts` | `cli --help` shows our own help; `requestsHelp` reaches OpenClaw's own `--help` only after a bare `--` |
| `cli-helper.check.ts` | the persistent CLI container: `startHelper`/`stopHelper`/`execInHelper`, `cli()`/`mcpServe()` falling back to `runOneOff` only on `HelperNotRunning` and not on any error; `runOneOff` forwarding `allowFailure` |
| `backup.check.ts` | rotation removes one archive per run, the oldest, counted per profile, and never a sibling deployment's |
| `runtime/service/state/backup/native.check.ts` | `--native` invokes `openclaw backup create --verify --json --output` in the sidecar and parses its result; refuses to publish on `verified: false`; the published archive keeps the ordinary full-backup name and location, so rotation needs no native-specific case; `--native` refuses any profile but full; an image without native support raises a distinct error rather than a generic failure; neither an unsupported attempt nor a failed verify ever leaves a half archive under a normal-looking name; and a live file OpenClaw's own backup left out (a session transcript) is copied into the archive, with the count reported |
| `runtime/service/restore.check.ts` (native section) | a restored archive carrying a native backup's embedded manifest is re-verified with `openclaw backup verify` before anything is unpacked, and a failing verification refuses the restore before any destructive step runs |
| `runtime/service/state/backup/inventory.check.ts` | `listBackupArchives`/`listReplacedCopies` parse names, sizes and timestamps, exclude a sibling deployment's archives and non-`.replaced-*` directories, sort newest first; `defaultRestoreArchive` picks the same archive restore's own `newestArchive` would; `parseReplacedCopyName` accepts only the exact `<dataDir>.replaced-<stamp>` shape |
| `runtime/service/state/backup/list.check.ts` | `backup list` text and `--json` both report archives and replaced copies with size/date, mark the default restore pick, and an empty backup/data directory reports "none found" rather than erroring |
| `runtime/service/state/backup/prune-replaced.check.ts` | `backup prune-replaced` previews without `--apply`; deletes only with it; deletes only exact `<dataDir>.replaced-<stamp>` siblings, refusing a symlink, a path outside the data directory's parent, or the data directory itself; `--keep <n>` retains the newest `n`; the delete path takes the instance lock and honours `--break-lock`/`--break-foreign-lock` |
| `runtime/connection-facts/upgrade.check.ts` | the target tag is resolved to a digest and pulled by digest, never the tag itself; the running digest is recorded before anything changes; a healthy upgrade takes a pre-upgrade backup, recreates on the target digest, and passes `openclaw doctor --lint`; a generic health failure recreates back on the previous digest without touching data; a container exit during migrations (code 78) additionally restores the pre-upgrade backup; a blocking `doctor --lint` finding rolls back the same way a health failure does; `--dry-run` resolves the digest to report the plan but changes nothing; and an instance already on the resolved digest is a no-op |
| `runtime/connection-facts/bootstrap-image-pin.check.ts` | a fresh pull is pinned to the digest it just proved — `.env` rewritten, the moving tag gone, the pull itself proven to run before the digest is read; `--no-pull` asks for no digest to pin and leaves `.env` byte-identical; a deployment already pinned to a digest is never asked to re-resolve and never rewritten — `./clawwright upgrade` is the only way to move it from there; and a digest the runtime cannot resolve locally leaves the tag alone rather than guessing |
| `provision-agent.check.ts` | path and argv builders, `collectRecipeFiles` excluding `agent/`, the create-vs-skip decisions, and cron reconciliation against the declaration |
| `mcp-mirror.check.ts` | the promise itself: every command `./clawwright help` lists is a tool or an explained exemption, and every tool is a command the console offers — both surfaces read from real processes |
| `gate-commands.check.ts` | the gate's own commands: dispatch, `--help` from the declaration, and the same schema/argv derivation the deployment's commands get |
| `logs-bounded.check.ts` | `logs` and `recipe logs` follow on a terminal and read a bounded tail under a sink, with `--tail` parsed rather than passed on; `--since` accepting a duration or an RFC3339/ISO date-time and refusing anything else; `--grep` compiling to a `RegExp` or refusing an invalid pattern, filtering the bounded read, and filtering a followed stream line by line under a sink |
| `deployment-list.check.ts` | `listDeployments()` against a scratch `apps/` and a stubbed context: the four configuration fields plus `pinned` read straight from `.env`; a missing `.env`, a broken `app.ts` and a failing `isRunning()` each produce their own row and reason rather than failing the whole call; `NotBootstrapped` maps to its own state; `--no-status` never builds a context at all; and the active deployment global is restored to what it was before `list` ran |
| `openclaw-cli.check.ts` | the shared wrapper around OpenClaw's CLI: capture, the scope-upgrade approve-and-retry, and that an unrelated failure is not retried into a second error |
| `restart.check.ts` | `restart` refuses a stopped instance, does not restart into a config with missing secrets, and waits for health |
| `runtime/service/image-identity/*.check.ts` | what compose is handed — a private env file, never `env VAR=…` arguments; `reconcile()` re-reading the deployment `.env` from disk rather than the process-start snapshot; and, where this machine can run a container, a synthetic rotation proven live: `restart` keeping the created environment in force, `reconcile` replacing the container, the rotated value read back from `docker inspect`; each temporary environment file's owner record (pid, machine) written before the token-bearing file itself; and a crash-abandoned `compose-<uuid>` directory — an owner recorded on this machine, its pid provably gone — swept before the next call, while one still owned by a live pid, one whose owner cannot be read at all, and one recorded on a different machine are each left alone; `health()` distinguishing `missing`/`stopped`/`starting`/`healthy`/`unhealthy` — a container stopped while healthy (or mid-failure) reports `stopped`, never Docker's stale last verdict; and the container-id lookup costing one bare `docker ps --filter label=…` exec, shared by `health()`/`startedAt()`/`runningConnectionFacts()`/`runningImageIdentity()`/`runningEnvironment()`, never a whole compose invocation each |
| `inspection.check.ts` | the problem-code table: every code has a severity and a runnable remedy, a caller cannot downgrade a blocking one, and "healthy" means serving rather than silent |
| `runtime/convergence/inspect/*.check.ts` | every finding `inspect` can report, provoked one at a time against a stubbed target and a real temp deployment; and `doctor`'s exit contract in both directions |
| `runtime/convergence/inspect/connectivity/egress.check.ts` | the outbound probe runs through the container exec and never `Runtime.probe()`, one exec on stdin for exactly the endpoints the live config names (none named — none asked), a name that does not resolve and an endpoint that does not answer are separate findings naming endpoint and config path, credentials in a proxy URL never reach the output, `doctor` still exits zero, and a stopped instance is asked nothing |
| `runtime/convergence/inspect/folder.check.ts` | the deployment folder against the instance: each of `ENV_STALE`, `DECLARATION_MISSING`, `STORE_INCOMPLETE` provoked and distinct; a folder that matches the running instance producing no finding at all; a stale fact named by variable, never by value, and the token sharing `.env` reaching no output; the stopped-instance and absent-store non-findings pinned as the limits they are; `doctor` exiting zero with all three firing; `IMAGE_UNPINNED` for a bare tag (surviving being stopped, since it is a fact about `.env` alone) and `IMAGE_TAG_MOVED` only once a running instance's own digest actually diverges from what the tag now resolves to — never paired over a tag that has not moved, never over a digest-pinned image, and never `IMAGE_TAG_MOVED` alone without `IMAGE_UNPINNED` beside it; and, against a REAL `DockerRuntime` with a stubbed transport, a deployment nobody has bootstrapped yet answering `NOT_BOOTSTRAPPED` (never a raw `mkdir` transport error, never `GATEWAY_DOWN` or `IMAGE_UNPINNED` beside it) from `inspect`/`doctor`/`status` alike, with the boundary pinned too — a data directory that DOES exist fails for its own real reason, never swallowed as `NOT_BOOTSTRAPPED` |
| `lock.check.ts` | what the lock notices: an image that moved behind an unchanged tag, a framework bump, an edited recipe, a newly required secret — and that all of it is a warning |
| `plan.check.ts` | the order, as rules: secrets before anything that needs the instance, configuration before the restart that reads it, start instead of start-then-restart, recipes after the gateway is up |
| `runtime/convergence/plan.check.ts` | the recovery half of the order: recover-env before the two dumps, the dumps before the steps that write to the target, the declaration dump executable only while the declaration is absent, and the store dump advisory because the refusal is the safeguard |
| `runtime/convergence/apply/*.check.ts` | stopping at the first failure, reporting what did not run as advisory or blocked, and never performing an advisory step; a runner asserted for every executable id the planner can emit; the recovery step reaching done and every step landing in the journal under one operation id that `./clawwright operations <id>` reads back; a dump's `--force` refusal failing the step with the file untouched; and `--dry-run` emitting the plan and writing nothing |
| `operations.check.ts` | the journal is on disk before the next step starts, an unfinished run keeps every step it managed and gains no invented outcome, and a target that cannot be written to does not fail the run it is recording |
| `rollback.check.ts` | choosing what to undo: the newest run that took a snapshot, never one that took none, and every refusal saying where to look instead |
| `apply-config.check.ts` | a dry run does not stage under the shared file name a real run writes, and two dry runs do not collide; `--dump` recovers exactly the curated paths from a stubbed JSON5 live config, refuses an existing declaration without `--force`, omits paths the live config never set rather than emitting nulls, and says plainly that recovered values are not the original declaration; flag combinations that mean nothing together are refused before the first read or write — `--dry-run` with `--dump` in both argv orders, `--break-lock`/`--break-foreign-lock` with either a dump or a dry run, `--force` without `--dump` — each refusal leaving the existing declaration byte-identical, with a plain `--dump --force` as the working control |
| `instance-lock.check.ts` (split: `claims`/`takeover`/`nesting`/`misc`/`advice`/`heartbeat.check.ts`) | a second operation is refused with the holder named, a failed run releases the lock, a stale one is described rather than stolen, and a run that lost its lock to `--break-lock` does not remove the new holder's, and a claim against an existing directory is refused; a holder's pid provably gone on this machine is named as such, never guessed at for one recorded elsewhere; `--break-foreign-lock <hostId>` refused on a mismatch, taken over on a match with who/when/which-owner recorded, and plain `--break-lock` still refusing a foreign owner; every command that reads `--break-lock` from real argv actually declares it, with the two that only ever appeared to (`bootstrap`, `pull`) fixed and the deliberately unsupported ones (`backup`, the internal `smoke` step) naming a command that does instead of the flag they reject, and `configure-provider`, which now declares and threads it like any other; every command in `openclawCommands` that declares `--break-lock` also declares `--break-foreign-lock` as a value-taking option, checked generically over the whole declaration rather than a fixed list, plus `secrets`, which declares `--break-foreign-lock` alone (`--apply` is the one action that takes the lock) without ever declaring `--break-lock`; `busy()`'s advice for a guard owned by another machine names the exact flag, host id and runbook; and the heartbeat — refreshed on an interval, read over `takenAt` once a record has one, a long-past-STALE_AFTER_MS holder with a live heartbeat never reading as stale, a legacy record with no heartbeat keeping the old rule, and a refusal naming the fact (not-refreshed-for vs refreshed-N-seconds-ago) instead of a shell's own wording |
| `accept.check.ts` | every declared check kind in both directions, and that an unknown kind fails rather than passing quietly |
| `foundation/cli/host.check.ts` | `host` end to end: the flag boundary, the root gate on target, context resolution per platform against injected environments, and the engine privilege contract — a context that arrives as root is refused without both flags before anything can spawn, and where this machine can answer, the real effective uid (`id -u` through the real resolution) rather than the argv |
| `runtime/lifecycle/smoke.check.ts` | every smoke check lands as `passed`, `failed`, `not-checked` or `could-not-check` and the four stay distinct; a check that could not obtain a verdict cannot be the reason a run reports success; the two bodies that run without an instance read a verdict-less runtime apart from a failed one; the drift check's restore failing after the verdict stays a failed check naming the drifted path and the repair; and a silent "agent answers end to end" naming `PROVIDER_MISSING`'s own remedy when the live config configures no provider, instead of inventing that cause when a differently-configured instance simply answered wrong |

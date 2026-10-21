# Operations

## Diagnose and repair through the framework

Start with the deployment's Clawwright CLI or `clawwright-control` MCP tools, not custom
scripts or direct Docker/WSL/SSH administration. This framework exists to simplify complete
OpenClaw setup and recovery; operating it is also a check that its tools cover the real task.
Use the launcher appropriate to the deployment and shell (`./clawwright` below is the checkout
or POSIX-shim spelling).

1. Run `status --json` and `inspect --json`; use `doctor --json` when a failing exit status
   is useful. Container health, gateway readiness, configured secrets and outbound
   dependencies are different facts. An absent observation is not a successful probe.
2. Follow findings with bounded `logs --tail 100` and, for an owning sidecar, `recipe status
   <name>`, `recipe logs <name> --tail 100`, `recipe diagnose <name>` or `recipe verify <name>`.
   Read `help recipe` first: diagnose/verify execute application hooks and take the instance
   lock; they are not guaranteed read-only.
3. Use `cli` for OpenClaw's own channel diagnostics. If the high-level tools cannot expose
   the cause, use a narrow `exec` probe from the gateway or `host target` probe on the target.
   Keep the operation inside the framework's selected deployment/transport. Do not dump
   secret files, tokens or conversation contents; avoid passing credentials in argv.
4. Treat a live repair as emergency recovery, not automatically a permanent fix. With the
   operator's agreement, restore only the affected component and preserve its data.
   Then correct the owning declaration or [recipe](recipes.md#durable-repair-and-verification)
   so the supported lifecycle reproduces the setup and its verification detects the fault.
5. Verify the actual consumer path after recovery. For a messaging bot, check connectivity
   from the gateway, channel state, and an authorized inbound message and outbound reply.
   A successful `getMe` proves API access/authentication, not working polling or agent replies.

Do not break a lock merely because its timestamp is old, adopt an ambiguous legacy recipe
project, remove volumes, or restart unrelated services to make diagnostics pass. Follow the
lock's ownership checks and the [recipe cutover procedure](recipes.md#existing-stack-cutover);
agree any disruptive recovery separately. If a high-level command refuses, a low-level
`host`/`exec` call is not implicit authorization to circumvent that refusal.

State what the framework could diagnose and repair, where a manual fallback was required,
and which end-to-end check remains unperformed. A missing operation is a framework gap to
improve, not a reason to silently establish a second script-based workflow.

From a native Windows shell, use the installed Windows Clawwright launcher or invoke Git Bash
explicitly. The `bash.exe` in the Windows `System32` directory is the legacy WSL launcher, not Git Bash: it can
reinterpret quoted foreign arguments and expand `$` or command substitutions before Clawwright
receives them. For WSL operation, enter the WSL shell first rather than forwarding scripts
through that legacy launcher.

## Safe channel, memory and lock observations

Normal `inspect --json` and `doctor --json` batch `channels status --json` and
`memory status --json` with registration reads. Channel output uses opaque account labels,
boolean configuration/liveness facts, timestamps and error categories, never raw provider
errors, bot/chat/user IDs, tokens or URLs. `getMe` success is authentication evidence only:
a configured enabled account with `running: false` remains `CHANNEL_UNHEALTHY`. Missing
polling telemetry is not proven disconnection. No channel probe is requested by this reader;
a probe verdict is shown only when upstream actually supplies one. Disabled accounts do not
alarm. Unknown or malformed telemetry is not healthy.

The link between a channel and its egress proxy is data, not folklore: an installed recipe
declares the configuration path it serves under `consumerEndpoints` (for example
`channels.telegram.proxy`), so when a channel account already carries a
`CHANNEL_UNHEALTHY` or `CHANNEL_UNKNOWN` finding and that path — or an account-level
`channels.<channel>.accounts.<account>.proxy` overriding it — is configured, `inspect`
reads the owning recipe's Compose service the same way install's readiness check does. A
service that is not running, or whose healthcheck reports `unhealthy` or `starting`, adds
one `CHANNEL_PROXY_DOWN` finding per recipe, naming the recipe, the health state and the
affected channel labels; the next action is `recipe diagnose <recipe>` (gated like every
mutation: confirmation plus the instance lock) beside `recipe logs <recipe>`. The proxy
URL never appears in the finding — it carries credentials. What the finding does NOT
prove: a proxy that reports `healthy` is only a green healthcheck, not working Tor or
egress — the recipe's own `recipe verify` covers the actual path — so no finding is added
when the proxy is healthy, and a proxy configured without any recipe declaring its path
(a foreign proxy) is never blamed for a channel.


Memory status is normal, not `--deep`: it does not index, reindex, fix, download a model or
spend embedding API credit. Per-agent source scans, indexed files/chunks, dirty state,
metadata identity and FTS/vector/embedding capabilities are separate observations. FTS
available does not prove an index exists. Pending provider preparation means `unchecked`,
not missing authentication. Partial failures preserve other agents' facts. Deliberate
`memorySearch.provider=none` is FTS-only: initialization creates no embedding client, and
no deep embedding-success evidence is required. Keep `query.hybrid.enabled=true` for that
mode because it controls FTS enablement. A configured non-`none` provider missing authentication
fails before keyword fallback; FTS availability alone does not make that provider operational.
An explicit per-agent failure remains unknown while retaining reported index/FTS facts;
pending preparation alone does not imply missing authentication. Disabled memory need not
enable an embedding provider. Start recovery with
`memory status --json`; prepare the selected backend/provider first, then agree any
index operation explicitly. Never blindly run `index --force` as a diagnostic remedy.
OpenClaw's normal status implementation may initialize or checkpoint SQLite metadata;
this is not a byte-for-byte database-immutability guarantee. The framework requests no
indexing, repair or provider probe.
Model observations preserve bounded HF identifiers and absolute local model paths, including
Unicode filenames. URI credentials use the same redaction policy as configuration values;
control-character or oversized identifiers remain unknown.


Normal status is not search proof. Identity `valid` normalizes to present; `missing`,
`MISMATCHED` and unknown/version-new identities remain distinct. Positive counts never make
a mismatched or unknown identity indexed-ready. Explicit provider/requested-provider `none`
disables embedding readiness even when provider preparation is pending or the upstream
search-mode label says hybrid. Text inventory names safe agent/backend/provider/requested-provider/
model values; absent values are unchecked, not an explicit `none`.

Use `memory plan --mode keyword --backend builtin` to preview a keyword-only declaration,
then `memory configure` with the same options to edit only its owned leaves. Apply and
restart explicitly when the running configuration differs; these steps are not implicit
in inspection or indexing. An existing `cli-helper` is required: start it deliberately
with `cli-start`, rather than expecting a one-off or automatic helper start.

`memory index --agent <id>` indexes an explicitly selected native agent.
`memory verify --agent <id>` creates, indexes and searches a random framework-owned witness,
then removes that exact owned file and reindexes. MCP index/verify require `confirm: true`.
Resource guards use a single validated configuration and native-agent snapshot at each
boundary; unsupported installed SDK snapshot capabilities refuse without a CLI fallback.
Cleanup has its own bounded budget, independent of an expired verification budget.
`search-proven` means the search and cleanup cycle completed; a cleanup or owned-process
quiescence failure is not success and never authorizes deleting unrelated memory files.

`status --json` and inspection expose `instanceLock`, distinct from the composition pin
managed by the `lock` command. Observation reads only; it never acquires, refreshes, deletes,
releases or kills an owner. Missing and unreadable locks are different states. Local owner
liveness reuses host/PID/start identity checks; foreign owners remain remote. Age and an old
heartbeat are not death evidence. Live/unknown local owners refuse takeover even with
`--break-lock`; an owner whose own record proves death is taken over automatically, and
explicit `--break-lock` is for everything the record cannot prove. Foreign takeover additionally
requires exact host confirmation. Observation advice is not authorization to repair.
Normal text inspect/doctor also show bounded channel/account, memory-agent and instance-lock
inventories. Unknown polling emits `CHANNEL_UNKNOWN` while retaining valid configuration and
credential booleans; malformed accounts do not erase valid siblings. Doctor does not claim
"doing its job" when channel telemetry makes the JSON verdict unhealthy.

Normal observation JSON retains lock facts and structured advice even when another target
read fails. Unknown lock reads never mean absent. Top-level `next`/`nextActions` include
non-absent lock advice for inspection, doctor and status; manual takeover decisions do not
invent an executable mutation command.

To unlock metadata without running an application operation, use
`operations --takeover-lock --break-lock --json`, not `up` or `restart` as an unlock
workaround. Terminal callers must type `yes`; MCP requires `confirm: true`. Foreign
owners additionally require the exact `--break-foreign-lock <host>` after verification
in the original PID namespace. This command changes lock metadata only, not runtime,
application files or operation history. Failed verification emits available observed
before/claimed/after facts and conservative flags, then still fails non-zero; an
unconfirmed release is not a successful unlock.

## Changing something

Edit the declaration, look at what that implies, apply it, get an answer about the
instance:

```bash
./clawwright inspect            # what is declared, what is running, where they disagree
./clawwright plan               # the ordered steps that would fix it, and why each one is there
./clawwright apply              # run exactly those, then inspect again and report the result
```

This exists because the dependencies used to live in whoever had learned them: configuration
is read at startup, so it has to be applied before the restart that reads it; provisioning
talks to the gateway, so the gateway has to be up first; a missing secret stops the instance
from starting at all, so it comes before either. Getting that order wrong is not a crash —
it is a run that reports success and leaves the instance on the old settings.

Every finding carries a code (`CONFIG_DRIFT`, `SECRET_MISSING`, `RESTART_REQUIRED`,
`RECIPE_MIRROR_DRIFT`, …) and the command that resolves it, so an agent branches on the code
instead of reading prose. `./clawwright doctor` is the same inspection as a verdict, exiting non-zero
when something blocking was found. `OC_AUDIT_BLOCK` defaults to `critical`; set it to `warn`
to also block warnings. Existing `config/security-suppressions.json` exceptions apply. Over MCP these four return `structuredContent` —
`{operationId, changed, healthy, problems, warnings, nextActions, nextSteps, result}` — beside the usual
text.

`inspect` also asks the running container, from inside it, whether it can reach the
outbound endpoints its own live configuration names — each model provider's `baseUrl` and
each channel's `proxy`. That is the one vantage the other probes lack: they are taken from
this machine, and on 2026-09-20 the gateway spent a day unable to resolve its model
provider while every one of them stayed green. A name that does not resolve and an
endpoint that resolves but does not answer are reported as the different facts they are
(`EGRESS_UNREACHABLE`, naming the endpoint and the config path that names it). The finding
is a warning, deliberately: the instance is doing its job and the outside world is not
something the deployment controls, so a DNS blip must not fail `doctor` or a CI run. Its
limits are the probe's own: it asks only what the live configuration names — not the
internet at large — and only of a running gateway, through a runtime that can exec into
one; when the probe cannot run, `observed.egress` is absent, which is a gap and not a
claim that everything is reachable.

The probe receives the original live URL, including credentials, but its public endpoint
and diagnostic detail use one URL-redaction policy: userinfo and credential query values
(including repeated or percent-encoded parameter names) are masked, and fragments are
masked because they can hold opaque tokens. Host, port, path and ordinary query values
remain useful. This applies to successful observations as well as `EGRESS_UNREACHABLE`,
in text/JSON `inspect`, `doctor`, `plan` and captured MCP output; inline credentials do not
need to have been registered in the secret store to be protected.

Parseable endpoints are sanitized structurally with the same WHATWG URL semantics the
probe uses: spaces or encoded spaces in userinfo, actual TAB/LF/CR, and HTTP-family
backslash or missing-slash forms cannot bypass masking. Public spelling may therefore
be normalized; the private probe input remains byte-for-byte unchanged. Malformed
authorities use conservative masking instead of publishing raw credentials on a parse
error. Embedded diagnostic URLs follow the same policy, even when they are not the
original configured endpoint and credentials cross whitespace boundaries.
An `error:`/diagnostic prefix is not itself a URI and cannot swallow the following
credential URL. Nested literal URL authorities and query names containing parser-ignored
controls are masked too; malformed standalone config URLs do not escape query masking.

The deployment folder itself — the operator side — is part of the same comparison. Three
findings cover it, each naming the command that reads that part back from the instance: a
connection fact in `.env` that no longer matches the running container (`ENV_STALE`, naming the
variable and never a value — the file mixes a real secret with the plumbing),
`config/desired-state.json` missing while an instance is running (`DECLARATION_MISSING`, a
warning on `LOCK_MISSING`'s precedent: the instance works and survives a restart, what it
cannot do is be re-declared), and a value the target still holds that the default local store
does not (`STORE_INCOMPLETE`). All three are warnings: the instance is doing its job, and what
is at risk is reproducing it, not running it. The limits are the detector's own:
`DECLARATION_MISSING` is only raised while something is running, so a fresh clone is told
nothing is wrong; and the store check watches the default store (`secrets/local.env`, the one
`secrets --dump` writes without a `--store`) and only when that file exists — `bootstrap` puts
values on the target without ever creating a store, so an absent store is how healthy
deployments look, and a store under another name is not watched at all, because `inspect` is
not given a store name.

One finding answers a question that comes before any of the above: whether the target was
ever reached at all. `TARGET_UNREACHABLE` fires when `wsl.exe` or `ssh` itself fails — a
wrong `OC_WSL_DISTRO`, a stopped WSL, `ssh` never connecting — as opposed to a command that
ran on the target and exited non-zero. `wsl.exe` writes its own errors ("There is no
distribution with the supplied name.") in UTF-16LE, which used to leave `doctor`/`plan`/
`status`/`backup list` printing a bare `could not check whether … exists (exit
4294967295):` with nothing after the colon and no other finding to explain it; the
transport now recognizes its own failure (an exit code outside 0-255, or one of `ssh`'s own
connection-error lines) and reports it as this one blocking, readable finding instead,
naming which environment variable to check and how to test the connection by hand:
`wsl.exe -l -q` (lists the real distribution names) or `ssh -o BatchMode=yes <host> true`
(fails fast instead of prompting). This is the first thing to check on a fresh Windows
setup, since a typo in `OC_WSL_DISTRO` is the single most common first failure there.

Two more findings answer questions the ones above cannot. `NOT_BOOTSTRAPPED` replaces
`GATEWAY_DOWN` on a deployment nobody has bootstrapped yet — its data directory does not
exist on the target, so `status`/`doctor`/`inspect` answer that plainly instead of asking the
runtime at all: every runtime call shells out to compose, which needs somewhere to write its
own private environment file beside the data directory, and creating that place is exactly
the `mkdir` a still-root-owned parent refuses pre-bootstrap. `./clawwright up` is not the
remedy here (compose would bind-mount a data directory that does not exist yet, creating it
root-owned), so the finding points at `./clawwright bootstrap` instead, and `GATEWAY_DOWN`
does not also fire beside it. `./clawwright bootstrap --check` answers the same question
read-only, before that first bootstrap ever runs: docker present and its daemon answering,
compose v2, whether the data/backup/snapshot directories can be prepared without a sudo
password (and the exact `sudo install -d` line to run if not), whether the gateway port is
free, and free disk space — one `ok`/`WARN`/`FAIL` line per prerequisite, no lock taken and
nothing created either way. `PROVIDER_MISSING` catches the opposite kind of quiet failure:
a bootstrap that finishes with no model provider key ends "OpenClaw is up" and every HTTP
probe green, yet an agent cannot answer a single prompt. Read from the live configuration
the same way `collectConfiguredProviders` already does (`models.providers`, `auth.profiles`),
never guessed from which environment variables happen to be set. It is a warning, not
blocking: a built-in provider keyed from the environment, a subscription login or a CLI
backend need not appear in either place, and a false blocking finding would fail `doctor`
and every `apply` on an instance that answers fine. `bootstrap`'s own final summary names the same gap, and
`smoke`'s "agent answers end to end" check names it as the cause of a silent agent when it
applies, instead of only reporting the symptom.

Two findings watch `OPENCLAW_IMAGE` itself, because it names something a shared Docker daemon
can move out from under a deployment that never asked for it: another deployment on the same
machine, naming the same tag, pulling it for its own reasons. `IMAGE_UNPINNED` fires whenever
`OPENCLAW_IMAGE` is still a tag rather than a digest — a warning, since the tag still resolves
to something and the instance is doing its job, but the next recreate this deployment runs
(`up`, `restart` after a compose change, `apply`) is one pull elsewhere away from switching what
it gets, with nobody here having decided so. `IMAGE_TAG_MOVED` is its present-tense sibling: the
local tag has ALREADY moved since this container was created, caught before that next recreate
is the first place anyone notices. Both point at `./clawwright upgrade`, which resolves and pins
by digest deliberately. `./clawwright bootstrap` prevents most of this before it starts: since
task #32, the moment a fresh pull proves what a shared tag holds, bootstrap pins `OPENCLAW_IMAGE`
to that exact digest in `.env` — the same write `upgrade` makes on success — so this deployment's
own next recreate can no longer be moved by somebody else's pull. A deployment already pinned to
a digest is left alone by a bootstrap re-run; `./clawwright upgrade` is the only way to move it
from there.

Two things `apply` will not do. It never reconnects an MCP client, because the client owns
the server processes it started; and it never rewrites `config/deployment.lock.json`, because
re-pinning whatever just drifted turns a reproducibility claim into a rubber stamp. Both are
listed in the plan as advisory steps, addressed to you.

### When it goes wrong

```bash
./clawwright operations           # what recent runs did, step by step
./clawwright operations <id>      # one run in full, including what never started
./clawwright rollback             # put back the configuration the last run replaced
```

`apply` copies the live configuration aside before its first mutating step, writes each step
to a journal on the target as it finishes, and stops at the first failure — so what it did
and where it stopped survive the run itself. `rollback` restores that one file and restarts.

It is not `./clawwright push`, and the difference matters at the worst possible moment: push replaces
the whole data directory from a snapshot, taking every workspace, every agent's memory and
every transcript written since. Undoing a bad configuration should not cost an agent its
notes, so they are separate operations.

One instance changes at a time. Every mutating command — `apply`, `rollback`,
`provision-agent`, `restart`, `apply-config`, `up`, `down`, `push`, `restore`, and every
`recipe` action that can change the instance — `install`, `remove`, and the hook-running
`verify`, `onboard`, `diagnose` — takes a lock on the target holding who has it and what they
are doing, and a second one is refused with that named rather than failing in an interesting
way halfway through. The lock is a directory, because creating one that already exists fails
atomically on every POSIX filesystem and through `wsl.exe` and `ssh` alike; read-then-write
would let two runs starting together both conclude it was free. A recipe action holds the
lock for its whole run — `install` across the from-source build, which is minutes,
deliberately, because a build finishing while `restore` is moving the tree is the
interleaving the lock exists to prevent. `recipe import` takes none, since it writes the
repository's `recipes/` directory and not the instance, so it works before bootstrap has
prepared the lock home.

It lives *beside* the data directory, in `<data>-locks/`, not inside it: `restore` replaces
that whole directory, and a lock within it left with the old tree while a second run happily
created its own in the new one. That home is made on demand and owned by whoever runs the
tooling — beside the data directory alone was not enough, since the parent can be root-owned
and then nothing next to it is creatable at all.

A `mkdir` that fails is not automatically a lock that is held: if the directory is not there
afterwards, the failure was something else — a permission, most likely — and it is reported
as that, with the real error and without offering a `--break-lock` that could not help.

The holder proves it is still alive on its own, rather than being trusted just for having
taken the lock recently: it rewrites a `heartbeatAt` field every 30 seconds for as long as it
holds the lock, and a lock is reported as stale once that heartbeat has gone quiet for 10
minutes — not simply because it was taken more than half an hour ago, which `recipe install`'s
own from-source build routinely runs past on its own. A record from before this field existed
keeps the old rule (stale past 30 minutes since taken). Either way it is described, never
silently taken: silently taking it is the same bug one layer down, the run that lost it has no
idea. The refusal says which is true — "not refreshed for N minutes" or "refreshed N seconds
ago — owner liveness must be checked". Age alone never permits takeover. A local live or
unknown owner must be waited out; only a proven dead owner permits explicit `--break-lock`.
Use `status --json` for host/PID/birth evidence and `operations <id>` for the operation.
`--break-lock` requests an ownership-checked takeover, deliberately not `--force`: `--force` means
"yes, I mean it" for a destructive command and is set automatically from an MCP caller's
`confirm`, so sharing the name would have made every confirmed tool call seize whatever lock
someone else was holding. Every pid a lock records is this tool's own — wherever `clawwright`
itself runs, never anything on a WSL or SSH transport's target — so when the holder was
recorded on this same machine and its pid is provably gone, the refusal says so plainly. A
record that also carries a boot identity and a native process start time proves death by
itself, and the next operation takes the lock over automatically — the exception described
next. It proves death by itself: a different boot id (the machine rebooted since the claim;
boot identities are compared only within the same source — Linux, Windows or macOS — never
across sources, and a record whose boot id or start fields are malformed is not proof), or on
the same boot a pid that is gone or whose native start time has
changed. In that case the next operation takes the lock over automatically, through the same
audited takeover as `--break-lock`, printing one notice naming the replaced operation id.
Anything less — records from before these fields existed, a foreign host, an unknown PID
namespace, a failed probe — still refuses exactly as before and still asks for explicit
`--break-lock`. The framework never kills anything; `kill(pid, 0)` is a liveness question,
not a signal. Not every lock-taking command accepts `--break-lock`
(`backup` and `secrets` do not); their refusals require choosing an intended operation that
supports takeover, never an arbitrary mutation just to remove the lock.

An operation lock or its shorter-lived bookkeeping guard may belong to a different machine.
A remote PID cannot be checked locally: first verify that the recorded owner's Clawwright
process is gone on that machine. The intended command must support both `--break-lock` and
`--break-foreign-lock <hostId>` with the exact recorded identity. A wrong identity refuses.
Bookkeeping-guard takeovers retain their existing audit in
`<data>-locks/foreign-lock-takeovers.jsonl`; confirmation is never automatic or guessed.

Historical by-only owners expose safe host/PID and `identitySource: legacy-by`, never the
username or raw `by`. Their original PID namespace is unknown, even on the same physical
host; no local liveness or birth probe runs. Verify the original namespace and owner manually
before an intended takeover with `--break-lock` and exact `--break-foreign-lock 'PC'` (for
recorded host `PC`). Candidate metadata and age prove neither death nor authorization.
Only exact bounded `user@HOST pid POSITIVEDECIMAL` records with all structured identity fields
absent qualify; partial, malformed or contradictory identities refuse, without migration.
Historical takeover rechecks the exact raw `by`, operation ID, acquisition time and operation;
structured legacy identity equality and modern generation checks remain separate.

Takeover revalidates the observed generation, or the immutable acquisition identity of a
legacy record without a generation. Missing or changed ownership refuses. A restoration
collision preserves the current lock and parks the displaced directory without nesting or
deletion; inspect the reported parked path before any separately authorized repair.

### Does this deployment's own work work

`./clawwright smoke` proves the instance is healthy. It cannot know whether the wiki one of your
recipes serves is reachable or whether the agent built from it has the tools it was given —
those are properties of a deployment. So a recipe declares them:

```json
{ "checks": [
  { "kind": "mcp_responds", "tools": ["confluence_search"] },
  { "kind": "cron_matches", "job": "refresh", "schedule": "17 3 * * *" },
  { "kind": "agent_answers", "usesModel": true, "agent": "onboarding", "message": "…" }
]}
```

in `recipes/<name>/acceptance.json`, and `./clawwright accept` runs them. The kinds are the
framework's, so no code travels from a deployment into it. A check marked `usesModel` costs
tokens and takes an agent turn — which writes to that agent's workspace — so it never runs
without `--with-model`, and is always reported as `not-checked` and counted rather than
quietly left out.

Every check lands as `passed`, `failed`, `not-checked` or `could-not-check`: a verdict was
obtained and is good or bad, the check deliberately did not run, or it was attempted and no
verdict came out of it — which is how an instance that could not be reached reports, instead
of pretending to pass. `smoke` speaks the same words. Plan steps under `apply` keep their own
four — `done`, `failed`, `advisory`, `blocked` — because a step is an action a journal
records, not a question awaiting a verdict.

Some read and reconciliation checks use OpenClaw's CLI. If the Gateway requests a wider
scope, Clawwright never starts a model turn implicitly. `accept --with-model` and
`set try --with-model` explicitly opt into approving that exact request through the `main`
agent; without the flag the check is reported as `could-not-check` and the request can be
approved manually.

## Removing a deployment

`new-app` has an inverse. Two commands, because a deployment is two things — an instance
somewhere, and a directory of configuration describing it — and undoing them is not one
action:

```bash
./clawwright --app <name> destroy                          # dry run: what would go
./clawwright --app <name> destroy --yes --confirm-name <name>   # actually remove it
./clawwright remove-app <name>                              # dry run: apps/<name>/ itself
./clawwright remove-app <name> --yes                        # actually delete it
```

`destroy` is the inverse of `bootstrap`. It always stops and removes the compose project's
containers, network and volumes — `down` plus `-v`, reusing `down`'s own runtime call rather
than a second implementation. Nothing else goes without its own flag: `--data` removes the
data directory (`OC_DATA_DIR`), `--backups` the backup directory (`OC_BACKUP_DIR`),
`--snapshots` the snapshot directory (`OC_SNAPSHOT_DIR`). It never touches the deployment
directory itself (`.env`, `config/`, `recipes/`, `secrets/`) — that is `remove-app`'s job.

The default is a dry run: it prints exactly what would be removed — the containers/network/
volumes plan, and each requested directory's path and size (`du -sk`) — and exits 0, nothing
touched, no lock taken. A real run needs both `--yes` and `--confirm-name <name>` matching
this deployment's own name; a typo in the name, not the flag, is what a wrong `--confirm-name`
refuses. It then takes the instance lock exactly like `up`/`restart`/`down`
(`--break-lock`/`--break-foreign-lock`), and escalates through sudo on the target the same
way `bootstrap`'s own `ensureDataDirs` does.

Each requested directory is checked before anything is removed, not just accepted from
`.env`: an absolute-path check, a depth floor (refusing `/` and single-segment paths, the
same floor `OC_DATA_DIR` itself is held to — extended here to `OC_BACKUP_DIR`/
`OC_SNAPSHOT_DIR`, which `toSettings` never validates), a refusal of anything shaped like a
home directory, and a refusal of a path that is itself a symlink. These are the deployment's
own declared directories, never a path typed on the command line — the check is a sanity
check on the deployment's `.env`, not on user input.

`remove-app` is the inverse of `new-app`: it deletes `apps/<name>/` — the repository-side
directory (`.env`, `config/`, `recipes/`, `secrets/`, `app.ts`, client MCP configs). It is a
gate command, so it needs no deployment resolved to run, and exists only in the monorepo
gate — an installed, single-deployment checkout has nothing under `apps/` to remove.
The default is again a dry run: the directory's top-level entries and total size, plus a
warning when it carries its own `.git` history (`apps/` is gitignored at the monorepo root,
but nothing stops an operator from `git init`-ing one deployment directory on its own, per
`new-app`'s own advice — that history is not otherwise visible from outside it). It refuses
while the deployment still has a bootstrapped instance — `running` or
`stopped`-but-bootstrapped, read the exact same way `./clawwright list` reads it — naming
`destroy` as the next step. It refuses a name that is not a plain deployment name (the same
alphabet `new-app` enforces) and a directory that is itself a symlink.

Neither command touches an operation record: `destroy --data` would remove
`clawwright-operations/` along with everything else in the tree it lives in, so a record
written moments before answers nothing a later reader could use; `remove-app` never reaches
the target at all.

## Instance settings as code

Everything we decide about an instance — the model, the reasoning level, the gateway
binding, trusted plugins, the model provider's catalogue — lives in
`apps/<name>/config/desired-state.json` rather than being edited by hand on the host. It is
an ordered array of `{path,value}` declarations, applied by computing a JSON Merge Patch
against live config and invoking OpenClaw's `config patch --file`. A patch `null` deletes a
value, so a newly stored null cannot be represented; unchanged SecretRefs are preserved.

Paths support dot properties, numeric indexes, quoted bracket keys and selectors such as
`plugins.entries[name=weather]`. A field name must match `/^[A-Za-z_$][A-Za-z0-9_$-]*$/`. A
bare selector value must be nonempty and contain no whitespace, `.`, `]`, `=`, `[`, quotes,
or backslash; surrounding spaces are trimmed. A JSON double-quoted selector value may be any
string, including the empty string. Properties named `__proto__`, `constructor`, or
`prototype` are unsafe. A middle selector traverses only when exactly one object matches;
no match creates `{field:value}`, while multiple matches refuse. A terminal single-object selector appends the declared object when there are no matches, and replaces the matching object at its existing index when exactly one matches; multiple matches refuse. A terminal array selector removes all matches and appends each declared object, forcing its selector fields to the requested values. Selector keys conflicting with declared values refuse. OpenClaw validates the resulting configuration against its own schema; the framework does not hardcode a config schema. JSON Merge Patch null deletes a property, so a patch cannot newly store a null property; null values inside arrays remain possible because arrays are atomic.

Before applying declarations, previously declared paths removed from the file are pruned
using the target data directory's `clawwright-declared.json` ownership record. The record is
written atomically only after a successful real apply; dry-run never writes it. A corrupt
present record refuses a real apply and is treated as empty by dry-run. Pruning numeric-index paths is refused; remove those values by hand or migrate to keyed selectors. Paths overlapping recipe-owned paths are
refused for writes and pruning. The conservative recipe check uses the list prefix before the first selector; any ancestor/descendant overlap refuses. `--dump` remains limited to its fixed recovery paths.

```bash
./clawwright apply-config              # apply
./clawwright apply-config --dry-run    # validate without writing anything
./clawwright apply-config --dump       # lost the file? recover the commonly declared paths from the live instance
./clawwright restart                   # the instance reads this file only at startup
```

`bootstrap` calls this itself, so `deploy` rolls the same settings out to a server. Hand
edits to `openclaw.json` are overwritten on the next apply — that is the point. Ordering
matters and is deliberate: the declaration is applied *before* `configure-provider`, because
a provider the declaration introduces needs its `baseUrl` in place before a key can be
written to it — OpenClaw refuses an incomplete provider entry.

The restart is not optional and not `up`: the instance loads this configuration once, at
startup, and `up` converges on "running" — which an already-healthy container satisfies, so
it reports success while the old settings stay live.

Worth declaring explicitly, beyond the obvious gateway settings:

* **the provider's model catalogue** (`models.providers.<id>.models`), with `contextWindow`
  and `maxTokens` per model. A model with no entry resolves through an implicit default,
  which is how a session can silently budget a fraction of the context the model actually
  has;
* **the provider's base URL and API adapter** (`models.providers.<id>.baseUrl` / `.api`);
* **allowed Control UI origins** (`gateway.controlUi.allowedOrigins`) — the gateway rejects
  a browser whose origin it was never told about, which is what a dashboard opened on the
  published port hits.

The API key is deliberately *not* declared: it stays a `SecretRef` and never enters the
repository.

Pinning the reasoning level per model is not possible in OpenClaw — it comes from
`agents.defaults.thinkingDefault`; a declaration can also carry the provider parameter
`params.reasoning_effort`, when the selected provider accepts it.

### Any OpenClaw setting, without changing the framework

The framework does not know OpenClaw's configuration schema: a declaration is a path and a
value, OpenClaw validates the result, and keyed selectors reach into lists. So a new OpenClaw
feature is used by declaring it — not by waiting for a framework release. Files OpenClaw reads
from its data directory (agent prompts, skills, data) are declared the same way, in
`config/files.json` (see [files](files.md)). Two worked examples:

**A model preset** — one name for provider + model + key, so agents and sessions say
`public-cheap` instead of repeating model ids. A preset that needs its own key (for example a
separate, spend-capped key for a public bot) is its own provider id:

```json
[
  { "path": "models.providers.zai-public", "value": {
      "baseUrl": "https://api.z.ai/api/coding/paas/v4", "api": "openai-completions",
      "models": [ { "id": "glm-5.3-flash", "name": "GLM-5.3-Flash (public)", "contextWindow": 1000000, "maxTokens": 131072 } ] } },
  { "path": "agents.defaults.models[\"zai-public/glm-5.3-flash\"]", "value": { "alias": "public-cheap" } }
]
```

The key itself stays out of the repository: put `ZAI_PUBLIC_API_KEY` in the target's
`config/.env` and run `./clawwright configure-provider --provider zai-public --env ZAI_PUBLIC_API_KEY`.

**A public chat agent that can only read one MCP server** — its own agent, every built-in
tool denied, only the tools of the `confluence-mock` MCP server allowed, reachable from one
channel account that anyone may message, with one session per sender:

```json
[
  { "path": "agents.list[id=public]", "value": {
      "workspace": "/home/node/.openclaw/workspace/public",
      "model": { "primary": "public-cheap" },
      "tools": { "allow": ["confluence-mock__*"], "deny": ["group:openclaw"] } } },
  { "path": "bindings[agentId=public]", "value": [ { "match": { "channel": "telegram", "accountId": "public" } } ] },
  { "path": "channels.telegram.accounts.public", "value": {
      "botToken": "${PUBLIC_BOT_TOKEN}", "dmPolicy": "open", "allowFrom": ["*"], "groupPolicy": "disabled" } },
  { "path": "session.dmScope", "value": "per-channel-peer" }
]
```

`agents.list[id=public]` replaces only the element whose `id` is `public`;
`bindings[agentId=public]` replaces only the bindings of that agent — everything else in both
lists is left as it is. Remove an entry from the file and the next apply removes it from the
instance. Before opening any agent to strangers, run `./clawwright doctor`: OpenClaw's own
security audit flags open channels that reach command or file tools, and `OC_AUDIT_BLOCK=warn`
makes its warnings block `accept` too.

### Privacy: update checks

OpenClaw checks daily for a new release (`update.checkOnStart`, default `true`). A fresh
deployment leaves that as it is — whether an instance reaches out once a day is the
operator's call. To turn it off, declare it in `config/desired-state.json`:

```json
{ "path": "update.checkOnStart", "value": false }
```

The anonymous feature statistics described in the upstream documentation
(`openclaw telemetry`, `telemetry.*`) do not exist in the published image this framework
pins by default (2026.6.x): it has no such command and rejects a `telemetry` config key,
failing the whole write. Do not declare it until the image you run accepts it.

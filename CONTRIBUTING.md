# Contributing to Clawwright

Clawwright is a framework and CLI for operating self-hosted OpenClaw deployments. Changes
should keep the framework independent from any one deployment's business content.

## Development setup

Use Node.js 24 or newer. From the repository root:

```bash
npm install
npm test
npm run format:check
npm run build
npm run pack:check
```

The check suite uses recording transports and disposable directories. It does not contact an
OpenClaw gateway or call a model. Live Docker/WSL and SSH scenarios are separate and must be
clearly identified in a change description.

`npm test` runs every check; while iterating on one, narrow it with `./clawwright check
<substring>...` (or `npm run check -- <substring>...`), which only runs checks whose relative
path under `tools/checks/` contains at least one substring — e.g. `./clawwright check gate` or
`./clawwright check foundation runtime`. `./clawwright check --list` prints the matching paths
without running them; a filter that matches nothing is refused rather than silently falling
back to the whole suite.

`./clawwright check --related` selects only the checks affected by the changes between `--base`
(default: the merge-base with the upstream branch, else `HEAD~1`) and the working tree — both
committed and uncommitted files count. Selection uses the static import graph plus a data rule
table for dependencies the graph cannot see: checks that spawn CLIs or servers, docs, goldens,
packaging, and whole-surface families. Substring filters still work and narrow (intersect) the
related set. An always-run fast tier (layout, architecture, static hygiene, needs) is included.

`npm run check:fast` is a shortcut for typecheck + lint + the fast tier + `--related`; use it
while iterating instead of the whole suite.

The related mode is a convenience, not a guarantee: invisible dependencies are only covered by
the rule table, so a change can still escape it. The full suite (`npm test`) stays the gate
before a release.

### CI tiers

CI runs two tiers. Feature pushes, pull requests and manual runs without `full` use the
fast tier: typecheck, lint, mandatory license audit and `check --related`, including its
always-run checks. The exact base is the PR base SHA or the push's previous SHA. A manual
feature run can supply `base_ref`; only a missing/zero base falls back to the merge-base
with `origin/main`. Full-depth checkout and commit validation are mandatory. Unknown or
unresolvable revisions fail instead of silently skipping checks. Pull-request checks cover
the complete integration delta, while push checks cover the new feature delta.

At sprint completion, put `[ci:full]` in the pushed HEAD commit message, in its subject
or body, to request the full tier instead of scoped checks. GitHub's `contains` comparison
is case-insensitive; use the lowercase spelling consistently. For example, add a separate
paragraph with `git commit -m "feat: complete the sprint" -m "[ci:full]"`. Do not mention
the token incidentally in an ordinary feature commit. Only push events evaluate this
commit token; PR checks stay diff-scoped. Branch names alone never select full verification.

Manual full verification remains available through **Actions -> CI -> Run workflow**,
selecting the branch and `full=true`, or `gh workflow run ci.yml --ref <branch> -f full=true`.
Watch its result with background `gh run watch <run-id> --exit-status`. There is no nightly
full run and a green feature run does not establish full readiness. Full still includes
SSH/Docker/WSL capability provisioning, controls shards, package/system-install checks and
candidate artifacts; publishing retains its separate full verification. Do not remove
required branch checks or treat scoped results as proof that the full suite passed.

Newer runs cancel older runs only within the same event, ref and tier. Ordinary scoped
pushes cannot cancel marked or manual full verification. Each job prints `check --timings`
at the end, including failures. Do not request full runs for each feature.

## Writing a check

A check is any `tools/checks/**/*.check.ts` file. `tools/checks/kit/run.ts` finds every one of
them, spawns each as its own `node --experimental-strip-types <file>` child process — bounded
by `--jobs <n>` / `OC_CHECK_JOBS` (default `min(4, cores/2)`, at least 1) — and prints each
file's full output as one block, in stable file order, as it completes. Run one file directly
the same way it runs in the suite: `node --experimental-strip-types tools/checks/foundation/core/paths.check.ts`.

Run checks with node itself (`npm run check`, the kit runner, or the direct
counted command above) — not under `npx tsx`. tsx rewrites the module URL query, which
breaks hook-loading checks; that is a runner artifact, not a product failure.

Import the shared harness rather than writing another local `check()`/`failed` counter:

```ts
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

check("a plain KEY=VALUE line is captured", parseEnv("KEY=value"), { KEY: "value" });
checkTrue("recipe is destructive", openclawCommands.recipe.destructive);
finish("env"); // prints "all env checks passed" or "N failed", sets process.exitCode
```

`check(name, actual, expected)` compares with `node:assert`'s `deepStrictEqual` — never
`JSON.stringify(a) === JSON.stringify(b)`, which silently treats a key holding `undefined` the
same as a missing key, ignores `Set`/`Map` contents, and can't tell `NaN` from itself.
`checkTrue(name, condition)` is sugar for `check(name, condition, true)`. Both print
`  ok   name` on success and `  FAIL name` plus `expected …`/`got …` (via `node:util`'s
`inspect`) on failure. A file-local helper built on top of `check`/`checkTrue` (a `checkThrows`,
a `skip`) is fine when a file's own shape genuinely needs one — the harness stays to the three
primitives every check needs.

Isolation is by file, not by check: two check files never share a module registry, so
`useDeployment()`'s module-level state, an env mutation, or a stray `process.exit()` in one
file cannot affect another. A fixture that stands in for the host
(`useLinuxHost()`, `tools/checks/foundation/hygiene/linux-host.ts`) still works — it sets
`process.env.NODE_OPTIONS` on the check's own process, which that process's own children (not
its sibling check files) inherit normally. `npm run check:linux` runs the same suite, filtered
the same way, inside a Linux container — see "Reproducing Linux CI locally" below.

Sweeps that drive every command through the real pipeline (`executeCommand`) share one
deployment fixture: `createDeploymentFixture()` (`tools/checks/kit/deployment-fixture.ts`)
lays out a valid deployment in a temporary root — the `.env` a context builds from, `app.ts`,
`config/`, a probe recipe — selects it with `useDeployment()`, and hands out a recording
transport (`fixture.transport()` once per case, contacts read back with `fixture.contacts()`):
every contact is recorded and none is ever answered, so one sweep can assert both "refused
before any contact" and "reached run". Selecting the deployment is what lets a case that
passes `prepare` reach the guarded `run` phase instead of stopping at the context's
"no deployment selected" refusal. Pass `{ root }` to place the root yourself; `dispose()`
removes it either way and restores the previous selection. Each case reports the stage it
reached to a `stageTally()`: a valid control that stops before `run` fails the check, a
fixture setup error fails it too (never silently counted as a refusal), and the sweep prints
its stage histogram so a reviewer can read which phases its cases actually reached.

### Host capability labels

Most checks use a recording transport without a real Docker daemon, WSL distro or shell.
When one case needs an actual host capability, gate that case with the registered
`requires(capability, caseName, body)` helper below. Missing prerequisites produce named,
counted skips; `--require` turns a missing expected prerequisite into failure. Do not invent
file-local skip conventions, infer availability from production output, or replace native
evidence with a stubbed process/platform identity.

A file that cannot run AT ALL without a host capability — real docker, a real WSL distro, a
real `sh`, `rsync`, or a Linux host — says so instead, in its header (first 2KB, same budget
as `// check:exclusive`):

```ts
// check:requires docker
```

or several, comma-separated: `// check:requires docker, wsl`. Recognized capabilities live in
`tools/checks/kit/capabilities/capabilities.ts`: `docker` (`docker info` succeeds), `wsl`
(`wsl.exe -l -q` lists at least one distro), `posix-sh` (a `sh` that runs a trivial command —
never via wsl.exe), `rsync` (a real rsync binary), `linux-host` (`process.platform ===
"linux"`), `local-posix` (a POSIX filesystem this process drives directly — the Linux host itself, or a usable WSL distribution on it from Windows; macOS answers "absent" — what the real-tar archive/verify and symlink-boundary groups target), `posix-host` (`process.platform !== "win32"`: Linux and macOS alike, for a case that needs only a non-Windows host), `windows-host` (`process.platform === "win32"`), `ssh-loopback` (`ssh -o
BatchMode=yes -o ConnectTimeout=5 ${OC_CHECK_SSH_HOST:-localhost} true` succeeds — key-based,
non-interactive; BatchMode refuses instead of prompting, so a host with no key set up answers
"absent" instead of hanging), `gnu-userland` (this process's own `mkdir`, `mv` and `tar` are GNU-compatible
— macOS ships BSD ones, a stock Windows runner has no `mkdir`), `posix-modes` (chmod 0o600 on a
temp file reads back 0o600 — POSIX permission bits are meaningful on this host's own filesystem;
Windows filesystems, where ACLs are authoritative, answer "absent"), `auto-target` (the target
`OC_TARGET_LOCATION=auto` picks on this host answers docker: `docker info` on Linux,
`wsl -d ${OC_WSL_DISTRO:-Ubuntu-24.04} docker info` on Windows — a WSL distro without docker
answers "absent", so a case that needs the target to answer, not merely wsl.exe, gates on this
one), `bash` (a `bash` that runs a trivial command — `bash -c "exit 0"`; the shell that
sources the generated completion script for real), `pwsh` (a PowerShell that runs
`pwsh -NoProfile -NonInteractive -Command exit 0`, falling back on Windows alone to
`powershell.exe` — the other shell the completion differential executes), `docker-desktop-wsl`
(Docker Desktop's own WSL distro answers `sh -c true` on a Windows host — the engine context's
real half) and `symlink` (a file symlink round-trips in a temp dir — what the link-boundary
groups need; Windows without developer mode or elevation answers "absent"). Each is probed at most
once per run, only when some selected file actually requires it, and a probe failure (missing
tool, timeout, anything) reads as "absent" rather than crashing the run.

The recipe native boundaries use `recipe-helper-boundary` (`OC_RECIPE_HELPER_BOUNDARY=1`),
`recipe-staging-boundary` (`OC_RECIPE_STAGING_BOUNDARY=1`) and `recipe-private-parent-boundary`
(`OC_RECIPE_PRIVATE_PARENT_BOUNDARY=1`). Each nonmutating gate requires this process to run
on actual Linux with UID and GID both 0, plus explicit parent authorization through its exact
opt-in value. Missing prerequisites produce honest named skips; forcing an absent capability
via `--require`/`OC_CHECK_REQUIRE` fails through the existing file/case gates. Native tool
prerequisites are checked inside authorized bodies and fail rather than skip.

A single case inside an otherwise runnable file can gate the same way: `await requires("docker", "<case name>", body)`
(`kit/harness.ts`) runs `body` when the capability is present, prints `  SKIP <case name> — needs <cap>`
(counted in the closing summary) when absent, and fails the case instead when the capability is
in `--require`/`OC_CHECK_REQUIRE`. Prefer it over ad-hoc output sniffing for host-dependent
assertions.

A check run must also leave the checkout as it found it (no leftover apps/<name>, no modified or
newly untracked tracked files): the runner snapshots `apps/` and `git status --porcelain` before
and after a run and fails it, listing the differences, if either changed. Ignored output (dist/)
never shows; when git is unavailable the comparison is skipped with a note.

`tools/checks/runtime/transport/scenarios/contract.ts` defines the transport contract once
(`runTransportScenarios`) and three thin files — `local.check.ts` (`requires linux-host`),
`wsl.check.ts` (`requires wsl, windows-host`), `ssh.check.ts` (`requires ssh-loopback`) — each
run the same suite against a real `LocalTransport`/`WslTransport`/`SshTransport`. Its own
commands are POSIX-sh only, so the ssh cell runs against any Linux/macOS sshd with a GNU
userland, not only the CI-provisioned loopback one.

The runner (`tools/checks/kit/run.ts`) never starts a file whose requirement is unmet: it
prints `SKIP <label> — needs <cap>` and counts it separately from passed/failed files in the
closing summary (`N check file(s) passed, M skipped (needs docker: 3, wsl: 2)`). `--list`
shows each file's requirements too. To run only what THIS host can actually satisfy, do
nothing special — `npm run check` already skips what it lacks. To instead demand a capability
this host is supposed to have (CI on a runner that is meant to carry Docker, or the
WSL+Docker self-hosted job), pass `--require docker,wsl` or set `OC_CHECK_REQUIRE=docker,wsl`:
an unmet requirement in that set fails the run instead of skipping it.

Adding a check that genuinely cannot run without one of these: add the header, not a scattered
`if (process.platform === "win32") return` — the runner's skip line and summary count already
say exactly what a check file printing its own "skip" line to stderr would otherwise have to
repeat by hand, and a moved or renamed file keeps working everywhere without anyone updating a
### Which run, when

Pick the run by the moment, not by habit:

| Moment | Run | Why |
| --- | --- | --- |
| Editing, a few minutes in | the one check file you changed: `node --experimental-strip-types tools/checks/<path>.check.ts` | seconds |
| A task is done, before committing | `npm run check:fast` | type check, lint, the always-run structural checks (layout, architecture ratchets, static hygiene, needs) and the checks related to the diff |
| A change touches a command declaration, the MCP surface, goldens, docs or packaging | add the family explicitly: `./clawwright check mcp golden completion flags property binder help docs packaging` | whole-surface checks are reached by rules, not by imports |
| A stage or sprint ends, before a push to `main` or a release | the full suite: `npm test` | the gate; invisible dependencies are only covered here |
| A push to a feature branch | CI runs the fast tier against the previous push SHA; a PR also checks the integration delta | see "CI tiers" |

Read the exit code of the run itself, not the tail of its output: a pipeline reports the last
command's status, and the summary line of a long log hides a failed file above it.

A ratchet or layout failure after a "narrow" run is the usual sign that a family was skipped:
`check:fast` includes them for exactly that reason. If a flaky file fails once under the full
suite's own parallelism, treat it as a bug to fix, not noise to rerun.

#### For task prompts given to agents

Copy this into a task description so the agent verifies at the right level:

```text
Verification: run your own check files directly while you work. Before you report, run
`npm run check:fast` and, if you touched commands, the MCP surface, goldens, docs or packaging,
the matching families from CONTRIBUTING.md ("Which run, when"). Do not run the full suite; the
orchestrator runs it at the end of the stage. Report each command with its real exit code.
```

### Run timings

Every run records each check file's wall-clock duration — skipped and failed files at 0 — in
`.check-timings.json` at the repository root (gitignored, per-host, the last 5 samples per
file). A filtered run merges into the existing data instead of replacing it; the file is
rewritten atomically (temp file + rename), and a corrupt or unknown-version file is ignored
with one warning, then rewritten. At the end of a run the runner prints where the time went:
wall time, the serial sum of per-file times, the parallel efficiency (serial sum ÷ wall ×
jobs) and the ten slowest files with their share. `./clawwright check --timings` prints the
stored ranking (median per file; `--top <n>` for more or fewer) without running anything.
CI can set `OC_CHECK_TIMINGS_OUT=<path>` to additionally write the run's per-file durations
as JSON for upload as an artifact; `OC_CHECK_TIMINGS=off` disables the repository-root file.

## CI jobs and the host × target matrix

`.github/workflows/ci.yml` runs four native-host jobs on feature pushes, pull requests and manual runs (see "CI tiers" above), one per named cell of the
host × target matrix in `docs/guide/requirements.md` ("Windows, `local`" is refused by the
framework itself, so it has no job); `.github/workflows/windows-full.yml` is a fifth,
manual (`workflow_dispatch`) job on a self-hosted runner with a real WSL2 distro and Docker.
Each job's `OC_CHECK_REQUIRE` (see "Host capability labels" above) turns a missing capability
this runner is supposed to have into a hard failure instead of a silent skip:

| Job | Matrix cell | `OC_CHECK_REQUIRE` | Provisions before checks |
| --- | --- | --- | --- |
| `checks` — "Linux (local + ssh)" | Linux host, `local` + host-side `ssh` | `docker,ssh-loopback,posix-sh,rsync,linux-host,gnu-userland,bash,pwsh` | loopback `sshd` + key auth |
| `macos-checks` — "macOS (ssh target only)" | macOS host, `ssh` (no `local`, by design) | `ssh-loopback,bash,pwsh` | loopback `sshd` + key auth (`systemsetup -setremotelogin`) |
| `windows-checks` — "Windows (no WSL)" | Windows host, no WSL distro (the negative case) | `bash,pwsh` | nothing — both shells come with the runner image |
| `windows-wsl` — "Windows (WSL2)" | Windows host, `wsl`, hosted-runner best effort | `wsl` | `wsl --install -d Ubuntu-24.04` (see the job's own header comment for the nested-virtualization caveat) |
| `windows-full.yml`'s `checks` | Windows host, `wsl`, self-hosted, real WSL2 + Docker | `docker,wsl` | nothing — the self-hosted runner already has both |

`docs/guide/requirements.md`'s "How to test each cell" has the same table with more detail
on what `ssh-loopback` does and does not prove. **Not verified by an actual Actions run**
(authored without network/CI access): whether `systemsetup -setremotelogin` enables sshd
synchronously on hosted `macos-latest`, and whether hosted `windows-latest` can start a real
WSL2 distro at all — nested virtualization has historically been unavailable there, which is
exactly why `windows-full.yml` needs a self-hosted runner; `windows-wsl` is deliberately
best-effort and fails with a named reason rather than a bare exit code if it can't.

## Reproducing Linux CI locally

The `checks` job's `npm run check` plus typecheck/lint, build, pack:check — the "host
capability labels" section above is what keeps every job green without a hand-maintained path
list: a file that genuinely cannot run somewhere names the capability it is missing, is
skipped (not failed), and the closing summary says so. A change to transport, shell
invocation, or path handling can still pass on Windows and fail on Linux — a
dash-vs-bash wording difference or a check that assumes `wsl.exe` is absent are two real
examples this slipped through before. Run `npm run check:linux` before pushing any such
change; it needs Docker (Desktop on Windows/macOS, Engine on Linux) and otherwise refuses with
the next step rather than failing unhelpfully. It reproduces the ubuntu job's checks and
typecheck/lint steps inside the official `node:24` image, from a clean `git
ls-files -co --exclude-standard` snapshot (never the host's own `node_modules/` or
`tools/framework/dist/`) — never the whole working tree. Filter it exactly like `check`:
`npm run check:linux -- backup`. It does not install Docker inside the container or mount the
host's Docker socket, so the handful of checks that specifically probe for a local Docker
daemon skip their tool-dependent assertions here, the same as they do on a bare runner with no
Docker — see `tools/dev/check-linux.ts`'s own header comment for the exact tradeoff.

## Source layout

`tools/checks/foundation/layout.check.ts` caps every source directory at 7 direct entries
(files or subdirectories) and every file at 700 lines. The limits are not raised to fit a new
module — hitting either one means the directory has stopped mapping onto a single idea, and
the fix is to regroup by meaning: pull the files that share a real topic into a named
subdirectory (`runtime/docker/` for the Docker runtime and its diagnostics, `security/privacy/`
for what must never leave a deployment, and so on), not to drop a new file into whichever
directory still has a free slot. `tools/checks/` mirrors `tools/framework/` by meaning, not by
identical paths: a check lives next to the concept it tests, not necessarily inside a
directory of the same name as the module it happens to import. `tools/framework/` itself has
no source files of its own directly under it, so the cap does not apply at that root — new
top-level groupings still need a name that describes what belongs there, not "wherever fits".

A command a message, an error or a `details` text tells the user to run goes through the advice model and its one
renderer (`tools/framework/core/io/invocation/` — `command`/`shellLine`/`manual` as data, `renderAdvice`/`commandLine`
as text); a hand-written program spelling freezes one invocation into every other one. A line for another shell, host
or scheduler is `shellLine` and nothing rewrites it — cron, `schtasks` and a remote `deploy` line reach the output layer
exactly as built. Help prose names a command as a `{clawwright …}` token and its own flags as `{--flag}`, so one text
reads right under every invocation. The ratchets in `tools/checks/architecture/` enforce this: a literal program
spelling outside the renderer fails `check architecture` (`dotClawwrightLiterals`), and
`tools/framework/core/io/invocation/render.ts` is the only exemption that table names.

The command table in `docs/guide/commands.md`, between its `<!-- commands:begin … -->` and
`<!-- commands:end -->` markers, and the command list in `README.md`, between its
`<!-- command-list:begin … -->` and `<!-- command-list:end -->` markers, are generated from the
command declarations — `npm run docs:commands` rewrites both, and `docs-commands.check.ts` fails
on a hand-edited block. The narrative around them stays manual.

See `docs/internal/new-command-checklist.md` for the full list of registries, matrices, goldens and ratchets a new command or module touches.

## Worktrees

Development worktrees live in `worktrees/<name>/` and share the primary checkout's
`node_modules` through a directory link. On Windows a plain `git worktree remove` has followed
that junction and emptied the primary `node_modules`, so use the wrappers:
`npm run worktree -- add <name> [base]` creates a worktree and links its `node_modules`;
`npm run worktree -- remove <name>` unlinks the link first, refuses a real (non-link)
`node_modules` directory, and only then runs git. `--force` relaxes only git's dirty-worktree
guard, never the link check; `--delete-branch` also deletes the branch. Logic: `tools/dev/worktree.ts`.

## Negative controls

Every evidence-bearing check — one that asserts an observable behavior, not a product table
against itself — ships with a negative control (invariant I11): a declaration in
`tools/checks/controls/controls.ts` naming the product file, a textual edit (a search/replace
that must match exactly once) that would reintroduce the defect, the check file that MUST
fail with the edit applied, and a stable fragment of the failing assertion's name.
`npm run check:controls` copies the repository once into the OS temp directory, applies each
edit to the copy, and demands: the unedited copy passes the check, the edited copy fails
naming the declared assertion, and the copy is restored (proven by hash). The gate fails if
any control fails. A control whose edit no longer matches the product is itself a failure of
`check:controls` — a stale control is a finding, never a skip. CI runs it in the full tier on
a Windows job with WSL, split into three parallel shards (`npm run check:controls -- --shard 1/3`): several controls guard Windows-only behaviour. A control whose target
check declares a `check:requires` header — or that names host-specific capabilities itself in
`requires` — is reported as `skipped (needs <cap>)` and counted separately in the summary,
never held and never a failure. To add a control: append a
declaration to `CONTROLS`, run the command, and land it only once it holds against the
unchanged product.

### Independent expectations — the ownProductExpectations ratchet

A check's expectation must not be computed by the same product function or table the check
guards. When the EXPECTED operand and the ACTUAL operand of a `check()`/`assert.*` call share
a symbol imported from `tools/framework`, one product mutation moves both sides and the
assertion can no longer fail — it restates the product instead of guarding it (review rounds
18-19: `CRONTAB_FAILURES[28] ?? SCHEDULER_TRANSACTION_FAILED`, `engineDistroNote(...)`,
`crontabUpdateFailure(...)` used as expectations). Prefer an independent expectation: a
literal, or a check-local table of literals (see `UPDATE_REFUSALS` in
runtime/schedule/schedule.check.ts).

The ratchet `ownProductExpectations` (tools/checks/architecture/, tokenizer-based, like
proseHeld) counts the remaining assertions whose expected operand — or an
`.includes(...)`/`.startsWith(...)`/`.endsWith(...)`/`.match(...)` argument nested in the
actual operand — and the actual operand use the same framework symbol. The total and the
per-file counts are recorded in `baseline.json`: growth in ANY single file fails the build
(including a file absent from the baseline), the aggregate total must equal the recorded
total, and a decrease must be recorded by lowering `baseline.json` in the same commit. The
expected operand may be product-derived through one level of local derivation — a
`const`/`let` initialized from product code counts as product — template-literal
interpolations count, and markers are recognized only in real comments. Exemptions, both
printed in the check output: the file is named by a registered
negative control's `check` field (the control proves the file's assertions fail when the
product is mutated), or the assertion's line carries `// control: <id>` for an existing
control id (single-assertion exemption). A marker naming an unknown control id fails the
architecture check.

### Prose measurement decision

The prose measurement stays on the tokenizer (tools/checks/architecture/prose-held.ts,
merged as the proseHeld ratchet): it reads the token stream — string literals, regexes,
calls, argument positions — so a const-held pin, an `assert.match` regex, an
`includes(<spaced const>)` and an array expectation are all counted by one implementation
instead of four regexes that each covered one spelling. The older regex ratchets (prosePins,
proseMatchers, proseEquality) retain their original shapes, categories and per-line budgets,
but count only matches owned by an assertion operand. This excludes fixture initializers
and prevents a greedy match from swallowing a later assertion on the same line. They remain
conservative undercounts; the broader tokenizer and held-value flow measurements stay
separate. Widening the legacy shapes would renumber recorded state rather than preserve the
ratchet. New prose ratchets are written against the tokenizer.

## Pull requests

Explain the user-visible behavior, security implications, and validation performed. Keep
generated `tools/framework/dist/` output out of commits. Do not include `.env`, secret stores,
archives, snapshots, MCP client settings, or deployment data.

Changes to archive extraction, remote commands, MCP dispatch, credentials, ownership, or
confirmation behavior need a focused regression check and a security review.

`tsgo` provides the fast native TypeScript check and Oxlint keeps the source consistent.
Run `npm run format:check` before sending a change; generated `dist/` files stay ignored.

A change is handed over only with a green `npm run gate` (`npm run typecheck && npm run lint
&& npm run check && npm run check:controls`). The architecture ratchets (`tools/checks/architecture/`) pin the counts of
known duplication patterns: a number may go down only together with the code change that
lowers it — edit `baseline.json` in the same commit, since the check fails on both growth and
an unrecorded decrease.

## Licensing contributions

Unless a separate written agreement says otherwise, contributions are accepted under the
same dual MIT or Apache-2.0 terms as the project. Contributors must have the right to submit
the work and must identify third-party code instead of copying it without its notices.

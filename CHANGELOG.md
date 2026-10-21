# Changelog

All notable changes to `@phpcraftdream/clawwright` will be documented here.

## Unreleased

## 0.1.2

Operator experience: logs that are in time order, data handed to a container command without
quoting layers, security suppressions that can be scoped to one account, an MCP bridge that waits
for a booting gateway, and a finding that names the proxy behind a silent channel.

### Added
* `cli` and `exec` take `--stdin` (this process's standard input, at most 8 MiB, becomes the command's stdin)
  and `--file <local>` (the file is staged into the data directory under a unique private name, owned by the
  runtime user; the exact argument `@file` becomes its container path; the copy is removed afterwards, also when
  the command fails). Every refusal — a terminal or MCP standard input, no `@file` argument, a symlink, a
  directory, a file over 8 MiB — happens before any contact with the target. No more documents embedded in a
  heredoc inside `exec sh -c`.
* `match` on an entry of `config/security-suppressions.json`: a plain substring the finding's title and message
  must contain (for example `channels.telegram.accounts.public`) before the entry applies, so accepting one
  public bot account's open DMs no longer silences the same checks for every account and agent. Entries
  without `match` behave as before; several entries may share a `checkId`.
* `mcp-serve --wait <seconds>` (default 90, `0` restores fail-fast): the bridge waits for the gateway to be
  running and answer its health probe before it hands over stdio, so an MCP client started right after a reboot
  no longer reports "failed to connect" and gives up. The wait is bounded as stated and writes to stderr only.
* `CHANNEL_PROXY_DOWN` in `inspect` and `doctor`: a channel account that is unhealthy or of unknown health and
  whose effective proxy belongs to a recipe (through `consumerEndpoints`) gets one finding naming the recipe, its
  proxy service's state and the channels routed through it, with `recipe diagnose` as the next step and
  `recipe logs` beside it. A failed read blames nothing; the proxy URL, which carries credentials, never appears.
* `logs` and `recipe logs` take `--no-color` (also removes colour the application embeds, when following too)
  and `--json` (one record per line: `ts`, `service`, `stream`, `text`).
* For contributors: `npm run worktree -- add|remove <name>` and `docs/internal/new-command-checklist.md`.

### Fixed
* Logs are one chronological sequence. Not on a terminal, `docker compose logs` prints a container's stdout and
  stderr as two blocks and the framework concatenated them, so "the last N lines" was neither the last N by time
  nor free of days-old output (`recipe logs --tail 400` returned a previous run, `--tail 3000` nothing from today).
  Lines are now ordered by instant and the tail applies after the merge; `recipe diagnose` and incident
  snapshots read logs the same way.
* With a finite input, `cli` and `exec` no longer capture the command's output; stdout and stderr stay on the
  terminal while stdin is piped, and docker is not asked for a TTY next to a piped stdin.

## 0.1.1

The framework becomes a bridge to OpenClaw's own capabilities: a new OpenClaw setting, list
entry or workspace file is now declared as data, without waiting for a framework change.

### Added
* Keyed selectors in `config/desired-state.json` paths: `agents.list[id=public].tools` addresses the one
  list element whose `id` is `public` (created when absent, refused when ambiguous);
  `bindings[agentId=public]` as the last segment with an array value replaces exactly the elements
  whose `agentId` is `public`, leaving the rest of the list alone. Values may be JSON-quoted
  (`[name="a.b"]`). Numeric indexes keep working.
* Removed declarations are removed from the instance: a successful `apply-config` records what it applied
  in `clawwright-declared.json` in the data directory, and the next apply prunes every recorded path that is
  no longer declared (numeric-index paths are refused for pruning — use a keyed selector). The record follows
  the ownership ledger into full and migrate archives and is left out of share archives.
* `config/files.json` and the `files` command: declarative placement of directories into the data directory —
  `mirror` (the target becomes exactly the source) or `overlay` (only files this declaration wrote are ever
  removed, so an agent workspace keeps its own memory). `files` previews, `files --apply` applies under the
  instance lock; ownership is recorded per target in `clawwright-files.json`. An enclosing recipe's
  `privateFiles` still hold its private files back, and case-only renames are safe on case-insensitive targets.
* `OC_AUDIT_BLOCK=warn` makes OpenClaw security-audit warnings block `doctor` and `accept` as well (the default,
  `critical`, is unchanged); deliberate exceptions stay in `config/security-suppressions.json`. `accept` prints
  each finding's title and remediation.
* Guide: "Any OpenClaw setting, without changing the framework", with two worked examples — a model preset with
  its own key, and a public chat agent restricted to one MCP server.

### Changed
* `apply-config` writes through `openclaw config patch` instead of `config set --batch-file`: the framework computes
  the desired configuration (prune, then apply the declarations in order) against the live `openclaw.json` and sends
  only the difference, which OpenClaw validates against its own schema. Nothing changed means OpenClaw is not called.
  `inspect`, drift and `smoke` use the same computation, so they report exactly what an apply would change. Recipe-owned
  paths can be neither written nor pruned by the declaration, including their descendants.
* `provision-agent` mirrors recipe files through the same machinery as `files`.
* Releases publish through npm Trusted Publishing by default (`publish_mode: trusted-publisher`); the README
  installs with `npm install -g @phpcraftdream/clawwright`.

## 0.1.0

The initial development release, under the dual MIT or Apache-2.0 license. It provides
transport-aware lifecycle commands, reproducible set artifacts, archive verification, and
project-local MCP configuration for Claude Code and Codex. SSH deployment and model-backed
acceptance remain explicitly experimental.

Known limitations of this release:

* The SSH transport and the native local (non-WSL) transport are covered by checks but have
  not been exercised against a live server.
* `set try` supports local Linux and Windows-to-WSL targets only; over SSH it refuses.

### Renamed
* The project is now **Clawwright** (was ClawForge): the npm scope `@clawforge` belongs to an unrelated package,
  so the framework could never be published under it, and npm refuses the bare name `clawwright` as too close to
  `playwright`. Everything follows the new name, with no compatibility layer:
  the package is `@phpcraftdream/clawwright` (`npm install -g @phpcraftdream/clawwright`; exports
  `@phpcraftdream/clawwright/app`, `/mounts`, `/commands`, `/recipe-kit`, `/private-config`), the command and
  the checkout launcher are `clawwright` / `./clawwright` (`tools/clawwright.ts`), the MCP servers are `clawwright`
  and `clawwright-control`, environment variables are `CLAWWRIGHT_*`, and the names the framework writes on a target
  (markers, cron entries, trial and recovery files) use the new name too. An existing deployment is moved over once by
  hand: change its app.ts imports and dependency to `@phpcraftdream/clawwright`, rerun `mcp-setup` (it rewrites the previous
  launcher), and reinstall the `watch`/`backup` schedules.

### Added
* `recipe retire-legacy <name> [--apply] [--helper-image <sha256>] [--shutdown-timeout <seconds>]` retires a recipe's
  legacy-namespace stack: it previews by default the proven-owned inventory (containers with their provenance, mounts
  and planned operations) and, with `--apply`, stops the legacy containers (no kill or force; an unsupported stop
  signal refuses before anything is stopped), re-checks writer isolation, takes a cold backup of their writable binds
  and named volumes into a private recovery directory with a trusted local helper image (never built or pulled), records
  the removed containers' full `docker inspect` JSON and a restore manifest, then removes the containers only — no
  volume or image is ever removed.
* An instance lock whose owner is provably dead on this host is taken over automatically — the acquiring command
  reports `taking over the lock held by … — owner proven dead (…); no --break-lock required`. A live or unknown local
  owner still refuses takeover regardless of the lock's age; only a human with `--break-lock` decides about what the
  process record cannot prove. A claim records the machine's boot identity and the owner's native process start
  identity; death is proven only on the same host and PID namespace, by a changed boot identity, a vanished pid, or a
  differing native start key (two explicitly approximate start times keep a 15 s tolerance). Legacy records, foreign
  hosts and probe failures are never proof.
* A `.env` line that has no `=` (a typo like `OC_DATA_DIR /srv/x`) is refused by `parseEnv` with a structured
  `EnvSyntaxError` (`ENV_LINE_WITHOUT_EQUALS`) naming the file and the 1-based line; the message never quotes the line,
  which may hold a secret. `./clawwright list` parses each deployment's `.env` strictly and reports a broken one as that
  deployment's error row (with the code and line) instead of failing the whole listing.
* `recipe pin <name> --version <v> [--artifact <file>] [--apply]` refreshes a recipe's pinned release artifact: it reads the
  published `.sha256` (or `SHA256SUMS`) of the release asset over bounded HTTPS from GitHub hosts only, previews the two build-arg
  changes with the checksum's source, and with `--apply` rewrites exactly those two `ARG` lines under the instance lock. It
  refuses anything it cannot attribute to one artifact, including artifacts that share a version or checksum `ARG`.
* `recipe trial <name> [--dry-run]` builds and starts a recipe against a throwaway copy of its declared `privatePaths` data in a
  separate compose project: every published port is removed, build images get trial-only tags, the merged configuration is
  proven to publish nothing and to reference no live volume, network, bind mount or image before anything starts, and the
  scratch home and trial resources are removed in reverse order afterwards. Anything it cannot prove is refused; after a
  signal or a failed call over SSH it waits for the remote command to expire before cleaning up, and lists leftovers by name.
* `@phpcraftdream/clawwright/recipe-kit` adds a reconcile primitive for config an application's recipe owns: a pure planner, a guarded
  single-batch apply that re-reads and verifies, redacted plan views (keyed pseudonyms, no raw values), intent/result journalling
  with two-phase provenance so a crash never loses ownership, operator entries are never removed, removals above a fixed bound need
  a dedicated consent token, and protected path segments (`owners`, `approvers`, `credentials`) are refused at any depth.
* Recipes can publish operator-facing actions: `recipe.json` `actions` declares each action's hook file, effect
  (`read`, `change` or `destroy`) and typed arguments; `recipe run <recipe> <action> key=value [--dry-run] [--json]` runs
  it through one entry on the CLI and the MCP `recipe` tool. The declared effect drives confirmation and locking
  per call, results are size-bounded and secret-masked, and `recipe inspect` lists the declared actions.
* `@phpcraftdream/clawwright/private-config` adds keyed pseudonyms (`privatePseudonym`, `privatePseudonymLookup`: HMAC-SHA-256 over
  length-prefixed recipe, namespace and value, with a per-deployment key created once, exclusively, under a declared
  `privatePaths` directory and registered for redaction) and intent/result journal records with crash-gap detection
  (`appendPrivateIntent`, `appendPrivateResult`, `readPendingPrivateIntents`).
* `check --related [--base <rev>]` runs only the checks affected by the changed files (an inverted static import graph of
  the check tree plus a table of rules for dependencies the graph cannot see); `npm run check:fast` runs type check,
  lint, the always-run structural checks and the related set. `tools/dev/related-audit.ts` reports the selection per commit.
* The check runner records each file's run time in a local `.check-timings.json`, prints the wall time, serial sum,
  parallel efficiency and the ten slowest files after every run, and `check --timings` shows the stored ranking.
  `OC_CHECK_TIMINGS_OUT=<path>` also writes the run's durations for CI artifacts; `OC_CHECK_TIMINGS=off` disables the file.
* Recipe hooks get schema-versioned private state (`readPrivateState` / `writePrivateState`) and a bounded,
  secret-refusing private journal (`appendPrivateJournal` / `readPrivateJournal`) in
  `@phpcraftdream/clawwright/private-config`. New ancestor directories are created owner-only from the start.
* Recipes can own application-config paths: `recipe.json` accepts an optional `owns` array (`value` or
  `list-member` mode, optional segment-wise prefixes). Owned paths are refused in `desired-state.json`, skipped
  by `apply-config` and never reported as drift, and `inspect` / `recipe inspect` show the owner; overlapping
  owners are refused.
* `recipe check` also lints a recipe's Dockerfiles and Compose build contexts for unpinned remote artifacts
  (`ADD` without a checksum, `curl | sh`, unverified downloads, floating base tags, unpinned git clones). Findings
  carry a code, severity and file:line; errors make the command exit non-zero, and a single rule can be waived
  with a `# recipe-check: allow <code> <reason>` comment above the line.
* `recipe.json` may declare `ephemeralPaths`: absolute container paths whose writable-layer contents are
  disposable. `recipe migrate` ignores changes at or under them, reports the ignored counts, and names the
  unsupported writable-layer paths (and this field) when it still refuses.
* A public `@phpcraftdream/clawwright/recipe-kit` entry for recipe hooks: `appCli` and `appConfigPatch` call the
  application CLI with stdin-only input and guarded JSON results (`redacted` reports whether a registered
  secret was masked in the parsed output); `consumerFetch` makes one bounded HTTP
  request from the gateway container (its DNS and proxy), with the request on stdin and secrets redacted.
* `recipe check <name>` runs a recipe's own `*.check.ts` files, each in its own Node process, with a
  per-file timeout, bounded output and a non-zero exit on failure. It needs no instance, Docker or lock;
  `--dry-run` lists the files without executing code.

### Fixed
* `recipe trial` refuses a writable bind mount of the live recipe directory (it must be `read_only`), and recipe action hooks run
  with a context that carries `dryRun` on `recipe run --dry-run`, so `appConfigPatch` and `reconcileApply` preview instead of writing.
* The discovery self-check no longer creates the checkout's `apps/`, and the deployment-fixture self-check compares the
  repository root and the contents of the checkout's `apps/`, so concurrent checks no longer make it fail intermittently.
* A release racing a concurrent claim of the instance-lock mutation guard no longer leaves its own stale lock behind:
  the vanished-guard race is retried with the same atomic claim, the guarded cleanup is retried a bounded number of
  times when a live competitor holds the guard, and a cleanup that still fails is reported as blocking instead of
  being swallowed.

### Changed
* `--help` of a multi-action command (`recipe`, `watch`, `backup`, `memory`, `set`, `expose`) now lists its
  actions with a one-line summary each, and a flag that several actions describe differently no longer repeats the
  "With <action>:" prefix inside its composed text. `memory`'s help is rewritten in plain words, `watch`'s channel
  findings read in order, and `control-mcp --help` works before any deployment exists, like every other command.
* MCP argument summaries say what they mean: `--break-lock` is "Take over the lock" and `--break-foreign-lock`
  "Lock owner's host id" (were "Take lock"/"Orphan host"; `recipe`'s recover/migrate/retire-legacy keep the longer
  "Take over the instance lock"/"Remote lock owner's host id"); `backup`'s `--json` is no longer described as
  "Diff JSON", and `--native` reads "Live consistent snapshot (full only)".
* README's command list is generated by `npm run docs:commands` from the command declarations, like the table in
  docs/guide/commands.md, and `docs-commands.check.ts` fails on drift; it had fallen behind (`memory` was missing).
* The negative controls (`npm run check:controls`) skip host-aware: a control's target check can name the host
  capabilities it needs with a `// check:requires <cap>[, <cap>...]` header, and a control can declare its own
  `requires`, so on a host lacking a capability the control is reported as skipped — never silently. `--shard <i>/<n>`
  selects the i-th of n disjoint round-robin slices of the declared controls, and CI runs the controls as three
  parallel Windows shards (`1/3`, `2/3`, `3/3`), which together hold every control exactly once.
* Advice names the deployment's own launcher when the framework reaches it through an npm `file:` linked package
  (a `node_modules/@phpcraftdream/clawwright` symlink/junction into a framework checkout): the hint spells the app's local
  package, not the checkout path the link resolves to.
* `ci.yml` runs two tiers: a push fires only for `main`, and a push to `main` runs the fast tier (type check, lint,
  `check --related --base` against the merge-base with `origin/main`) — the full suite already gated its pull request;
  the full tier gates pull requests, the nightly schedule and `workflow_dispatch` with `full: true`. Concurrency is one
  group per event and ref (`ci-<workflow>-<event>-<ref>`), so a newer run supersedes an older one of the same kind and
  a push never cancels the nightly run; every job's `setup-node` step caches npm.
* MCP `tools/list` wording is shorter (command and argument summaries, the help pointer, the confirmation marker,
  repeated dry-run clauses): 35190 to 31556 bytes against the 35840 budget. Safety-relevant phrases and the full
  CLI help text are unchanged.
* A checkout deployment warns on stderr when the framework sources are newer than `dist` (run `npm run build`
  from the checkout root); stdout and `--json` are untouched, `OC_NO_STALE_DIST_WARNING=1` silences it.
* The bash completion install line is `eval "$(clawwright completion bash)"`: macOS ships bash 3.2,
  whose `source <(...)` does not run. zsh and PowerShell lines are unchanged.
* Memory setup validates the model source, revision, SHA256 and plugin version when the arguments
  are parsed, and plan/configure refuse `--env` together with local model options before any read;
  the declared package types no longer require `@types/node` in a consuming project.
* Held-value prose analysis preserves callable scopes, conditional returns and property/getter
  flows, while treating array length as metadata rather than prose.
* Own-product assertions follow lexical bindings, transitive writes and closure captures;
  property labels, shadows and literal keywords do not invent product provenance.
  Generator self-names stay function-local; the measured shrink-only baseline is 305.
* Prose assertion ownership follows selected record fields, snapshots and callable aliases.
  Bound predicate methods, identity assignments and conditional writes retain real operands.
  Reviewed recipe/privacy/native fixtures are explicitly recorded in the operator-approved
  baseline; held/opaque-input analysis, zero ad-hoc skips and existing safety predicates remain intact.
* Recipe readiness regressions assert structured service degradation, unknown probes and
  manifest preservation rather than error wording. Public effect/argument checks cover
  memory, recovery, migration and explicit lock takeover; obsolete renderer/probe pins are removed.
* Native Tor acceptance documents gateway-sharing CLI execution, captured hook output and
  explicit reload of changed bind configuration. Isolated selective recovery, consumer
  reconciliation and credential preservation were exercised without restarting live Telegram.
* Windows checks select local Git Bash and GNU tar through executable identity and real
  filesystem/argv roundtrips; a successful WSL-alias exit never proves a native tool.
* Write-isolation checks preserve regex boundaries and native promisify capabilities while
  distinguishing TypeScript-only metadata and readonly filesystem descriptors/constants.
  Fixture writers allocate and clean their own roots; the unknown-target budget is unchanged.
* Write-isolation path provenance follows proven filesystem aliases through native realpath
  calls; foreign receivers and shadowed bindings remain unknown, and checkout roots stay anchored.
* Metadata-only lock takeover requires explicit consent and exact owner revalidation.
  Dangling lock or mutation-guard entries no longer certify absence or quiescence.
* Recipe inspect/recover/migrate expose readonly diagnostics, explicit endpoint ownership and
  selective recovery, with proven namespaces, consent and bounded application-owned cold
  migration contracts. Native staging and PAX archives retain independently checked metadata.
* Native recipe planning no longer reopens `/dev/stdin` for Compose environment values.
  Quoted stdin preserves credentials without changing target Docker connection settings;
  safe root-owned sticky staging ancestors support standard selective recovery.
* Cold recipe migration distinguishes exact Docker-added mountpoint metadata from unmounted
  application data, including post-stop revalidation. An isolated standard-CLI named-volume
  cutover verified cold archives, healthy target state and retained source recovery artifacts.
* Memory plan/configure declares embeddings, keyword-only or disabled search while preserving
  unrelated configuration. Setup requires explicit resource consent and pinned local-model
  provenance; index/verify scopes agents and uses an isolated owned search witness.
* Memory resource guards read a coherent native snapshot without repeatedly bootstrapping
  separate config/inventory CLIs. Verification cleanup and reindex use an independent
  bounded budget after a primary deadline; successful verification proves owned-witness search.
* Retired the refactor-only frozen CLI argument count; new arguments remain covered by
  typed binding, effect/confirmation and refusal-boundary contract checks.
* Legacy prose ratchets retain their original shapes and budgets while excluding fixture
  initializers.
* Operator guidance prioritizes Clawwright CLI/MCP diagnostics and recovery, distinguishes
  emergency live repairs from reproducible declaration/recipe fixes, and requires consumer
  verification rather than treating container health or API authentication as a working bot.
* Normal inspection and doctor expose safe channel polling, memory index/provider capabilities,
  and operation-lock ownership independently; API authentication never proves a working poller.
* Lock takeover refuses live or unknown local owners regardless of age, revalidates legacy
  acquisition identity, and preserves both directories on restoration collisions.
* Windows owner birth checks honor WMIC UTC offsets; memory model observations preserve
  native HF identifiers and local paths while redacting URI credentials.
* Rendered advice quotes arguments for each shell and preserves native PowerShell handoff through Windows npm wrappers.
* Advice naming another deployment keeps `--project-root` when needed, or re-roots to the checkout's runnable shim instead of assuming a system-wide command exists.
* Value arguments containing control characters are refused at parse, before target contact.
* Outgoing MCP `nextSteps` bind through the strict command binder; a remedy that cannot bind no longer produces a machine step.
* `recover-env` reports an unreadable target as typed unknown with a remedy, not as no container.
* The gate commands (`check`, `new-app`, `remove-app`, `list`, `version`, `completion`, `init`) run through the same pipeline as every other command, declared once: the argument kinds, rules, effect and confirm come from their spec bodies. `remove-app` over MCP removes with one `confirm: true` (without it the call stays the dry run and needs no confirmation), its tool schema no longer requires `confirm`, and its list marker is `*` (destructive for some flags) instead of `!`. A gate argument refusal under `--json` prints the same `{"error": …}` document every other command prints. `help <gate-command>` and `--help` show the effect note.
* `mcp-setup` works when the target location is unsupported or unreachable.
* MCP no longer asks for confirm on `recipe import`/`recipe new`, which only add files.

* Deploy prints the server's own `./clawwright` command lines whatever local launcher ran it.
* Running the checkout gate from inside `apps/<name>` (or below it) now selects that deployment, as `--app <name>` does — previously it always ran the default `openclaw`. `--app` and `OC_APP` still win.
* Gate-command prose (e.g. `check --help`) no longer names the default or `OC_APP` deployment; it carries the typed `--app`, or the flag-selected deployment an MCP-serving process was started with, so the console and the served process render hints over the same deployment.
* Completion Install: lines are spelled from the target shell's own frame: a script generated from a checkout subdirectory stores `./clawwright`, never `../clawwright`, and the bash/zsh Install lines spell npm's wrapper with forward slashes even when the command ran under the Windows wrapper.
* The checkout-subfolder refusal prints a `cd` line each shell accepts.
* Advice naming another deployment, printed inside a deployment by the system-wide command, runs there instead of being refused as an `--app` conflict.
* Local facts of arguments — a missing artifact or recipe, an import source's derived name — are refused before the deployment's target is read.
* An MCP call of a mutating command refused before it ran reports changed: false.
* MCP tool calls bind arguments by name with the console's own binder: an unknown action is refused as such, a positional never lands in another action's slot (`<name> applies to ...`), and the first refusal is reported in the console's words instead of a list.
* MCP gate and help tool calls report the first refusal only, where they used to join every problem into one sentence.
* An empty OC_APP no longer breaks commands that need no deployment; commands that need one refuse it by name instead of reporting an invalid deployment name.
* `restore`, `push`, `verify` and `deploy` refuse a positional that begins with `-` even after `--` on the console, like the MCP surface already did.
* `deploy` refuses a target that starts with `-` (it reached ssh as an option).
* `configure-provider --provider` and `--env` are refused at parse in the argument kind's own words instead of after the settings are read.
* `set forget --name` is held to the reader grammar for owned objects — the refusal names the object kind (`invalid owned-object name ...`) where it used to say `object`.
* `--break-foreign-lock` accepts any recorded host id and refuses only an empty value or control characters, so a foreign lock is never unsolvable because of its spelling.
* `deploy --path` must be an absolute path, refused at parse (the remote-root boundary still applies in full).

* Checkout refusals printed by npm's Windows bin wrapper no longer name `node_modules\.bin\clawwright` at the checkout root, where it does not exist — they spell the checkout's committed `./clawwright` shim, with an `(in bash)` note where only bash can run it.
* Hints printed from a subfolder of the launch spell the entry relative to that folder (`../clawwright status` from `docs/`, `./clawwright status` at the checkout root); every production hint path renders against the frame's known launch root.
* An MCP tool call that names an unknown action is refused as an unknown action, in the console's own words and ahead of any argument problem — the console's own order — instead of reporting an argument problem first or silently running the default action.
* A target that cannot be reached is reported as such instead of as empty (S3.4 target-read contract): reading and enumerating on the target distinguish present, absent and unknown (`readIfExists`/`probeExists`/`listIfExists` in runtime/transport — unknown answers always carry a runnable next step as Advice), and the operation history (list/read/latest) plus the configuration-snapshot read refuse an unknown target instead of answering an empty history or skipping the recovery point. A tokenizer-based hygiene ratchet fails a catch around a transport read (readFile/exists/listFiles, the read-contract helpers, or an allowFailure exec whose failure would become the answer) in service/ or commands/ unless the handler rethrows or ends the command; documented deliberate sites sit on a counted, shrink-only allow-list.
* Unreachable-target failures retain structured remedies across console, JSON and MCP; operation history and rollback refuse unreachable targets rather than answering empty. Checkout-root advice uses a runnable shim, checkout refusals include shell-specific pasteable rows, and bootstrap reports the tag-preserving pinned image reference.
* Gate help keeps effect notes, gate decisions preserve the selected deployment for advice, blank OC_APP is unset, and deploy spells the server-side bootstrap hint with the server shim.
* Set artifact tar paths are normalized for Windows GNU tar; the check runner enumerates files inside ignored directories. The prose-ratchet widening measures const-held, regex, and array-held pins (162 measured, 162 recorded); this is a measurement widening, not product prose growth.
* Recipe import checks the source directory for `recipe.json` during prepare, before any target contact; the derived destination basename is separately checked against the creator-name grammar during prepare. `set try` and `set diff` reject missing artifacts during prepare, and `accept` rejects missing recipe acceptance files locally.
* Names use separate reader and creator grammars: existing Windows device-name deployments remain readable, while new recipes, sets, stores and agents refuse reserved device names at creation. `new-app` and `init` (the deployment creators) refuse them too, with the same reserved-name reason.
* `set try` registers locally stored secret values before attempting the live target-secret read, so a transport failure that echoes a value is masked even on the first run. With `--keep` it names the retained directory and compose project in a plain sentence (no runnable teardown line is printed).
* Local facts (missing artifacts, recipes, recipe sources, agent bundles, and acceptance files) are refused during prepare, consistently for console and MCP, before target access. Recipe source existence is not a parse-time check; a malformed derived creator name remains a separate prepare-time refusal.
* Parser declarations validate operation ids, checksums and `set forget` names; image references beginning with `-` are rejected. MCP refuses unknown actions and reports unchanged state as `changed: false`; conflicting option help identifies any-of alternatives.

* A recipe folder whose name is not a recipe name is refused where the set is read, not
  after it ships: `set validate` and `set build` answer the shared `SET_RECIPE_INVALID`
  finding the artifact path already reported, instead of packing a tree that `set validate
  --set`, `set diff`, `apply --set` and `set try` then refuse as an integrity error. The
  grammar is the recipe-name rule itself, so `recipe list`'s broken mark and the refusal
  agree.
* An acceptance file that is valid JSON but fails the acceptance-check rules is a content
  finding (`SET_RECIPE_INVALID`) on both the tree and the artifact path. It used to be judged
  in the integrity phase for artifacts — an integrity error about bytes the archive agrees
  with itself about — while the same bytes on the tree got the content finding.
* `set build` and artifact loading keep tar's real error: the second, unflagged tar attempt
  runs only when the first failed because the tar rejected `--force-local` (bsdtar). Any
  other first-attempt failure is reported as the first attempt saw it — under Git Bash's GNU
  tar a corrupt archive no longer surfaces as `Cannot connect to D: resolve failed`.
* `lock --check` and `inspect` compare the pinned digest as content, like set requirement
  matching already did: the same digest under a mirror registry spelling (`ghcr.io/…` locked,
  `mirror.example.com/…` running) is no longer `LOCK_DRIFT`; a different digest still is.
* `upgrade --dry-run --json` carries `pinnedImage` — the pin string the text plan names and
  the run would recreate on and write to `OPENCLAW_IMAGE` — instead of only the tagless
  `target` digest.

* Arguments are grammar-checked before anything is contacted: `deploy --path` is held to the remote-root
  boundary in the prepare stage, `set receipts --set-id` and `--receipt` and the `set`/`recipe`/app
  names are held to the id grammar at parse (`recipe install <name>` and `recipe import`'s explicit
  `new-name`; import's source `recipe.json` and derived destination basename creator grammar are
  checked during prepare), and `apply`/`plan`/`accept` refuse a `--set` artifact the local filesystem does not have
  in the prepare stage — an unreachable target can no longer report instead of the argument refusal.

* `set try` unpacks and verifies the artifact before it reads the target's live secrets: a typo'd
  `--set` path or a corrupt artifact is refused before the target is contacted, a failed secrets read
  still removes its staging and reports masked, and `--keep` retains only a try that took on target
  resources — a failure before the instance exists leaves nothing behind. The retained-instance note is
  plain text: no runnable teardown line is available because its private compose env file is removed
  after each call.

* An MCP call that passes a positional of another action of a multi-action command (`recipe`'s
  `<name>` for `recipe new`) is refused with the console's applies-to sentence, a call that leaves the
  chosen action's first required positional unbound is refused like a missing argument, and the argv MCP
  runs is built from the chosen action's own declaration slice — a foreign positional can no longer land
  in the run.

* The missing-required-argument refusal is one text on every surface: the console parser, MCP validate
  and the gate's argument enforcement share one builder, and MCP validate now names the command it
  validates, so its sentences match the console's byte for byte.

* The gate's commands carry their effect markers on every surface: the help list marks destructive
  commands, a command's `--help` notes when and why it writes (the same `effectNote` the framework's
  own help renders), and the `docs/guide/commands.md` rows carry the same marker.

* `apply-config --dump --force` is declared destructive and confirms over MCP like other destructive
  calls, and `--force` conflicts with `--dry-run` — a dry run writes nothing. `secrets --store` and
  `secrets --force` are refused at parse outside the actions that use them (the report reads no store;
  only an action that creates or overwrites a store can replace one) instead of being silently ignored.

* Names Windows refuses on any directory — `con`, `prn`, `aux`, `nul`, `com1`-`com9`, `lpt1`-`lpt9` — are refused
  when creating recipes, sets, stores and apps; readers accept existing names (previously valid names, now refused on creation).

* Argument summaries are bounded to 60 characters for the MCP schema line, the full text staying in the
  description: `recipe import`'s `new-name`, `upgrade --image`, `rollback --previous-set`,
  `apply-config --dump` and `expose tailscale --apply` carried their whole help text as the summary and are
  shortened, with the bound enforced by a spec check.

* Refusals whose sentence names a place now spell every advice row from that place: the
  not-initialised refusal inside a checkout and the `--app` conflict refusal a checkout's
  `apps/<name>` deployment answers both carry rows that paste from the checkout root
  (`./clawwright`), whatever spelling of the command the run started under. Lines that echo
  a command for the operator to paste back — `expose ssh`'s tunnel line, `expose tailscale`'s
  serve and undo lines, `incident`'s route-off lines, the `sudo install -d` preparation
  advice, the transport probe-failure refusal, and OpenClaw CLI failure lines — quote each
  argument, so an argument or path carrying spaces stays one element; plain words still
  echo bare. A `set try` that fails before its throwaway instance exists (the target's
  context cannot be created) reports that problem as is, and `--keep` no longer leaves the
  empty throwaway deployment directory behind for an instance that never came up.

* The init-in-checkout refusal's advice rows both spell the gate from the checkout root —
  the frame its sentence directs to — instead of the first row being re-spelled relative to
  whatever directory the run refused from. A gate command's `choices` refusal over MCP
  (`completion`, `help`) is worded exactly as the console parser words it — one message
  builder owns the text. A wrapped command's failure headline (`exec`, `host`, `cli`) quotes
  each echoed argument, so a command line whose arguments carry spaces or newlines can be
  read back as argv; plain words still echo bare.

* The checkout's own entry run directly (`node tools/framework/entry/bin.ts …`, or an
  npm-linked bin) hints the checkout's shim where it really is — `./clawwright` from the
  checkout root, `../../clawwright` from `apps/<name>`, in checkout mode — instead of the
  local-package spelling (`node_modules\.bin\clawwright` on Windows), which does not exist
  in a checkout. `host -- <command>` (and the captured `cli`/`exec`) print a successful
  command's stderr too: diagnostics live there, and a captured run used to drop them unless
  the command failed. `pull` on a never-bootstrapped deployment refuses up front with the
  `bootstrap` remedy, like the other mutating commands, instead of failing on the instance
  lock it cannot take. A deployment whose `app.ts` declares a command named `help` or
  `control-mcp` is refused at declaration — it would otherwise pass and make every command
  of that deployment unreachable at dispatch.
* A new deployment's committed shim (`init`) hands over a `CLAWWRIGHT_INVOCATION` the strict
  reader accepts (`"mode":"checkout"`, was the incoherent `"installed"`, which the reader
  discarded); hints no longer rely on the legacy variable fallback on Windows installed
  deployments. `lock` on a never-bootstrapped deployment refuses up front with the `bootstrap`
  remedy instead of running the full inventory and failing with a bare `lock not written: …`
  error (`lock --check` still reports the target state). `help --bogus` and
  `control-mcp --bogus` advice no longer pins a deployment: the suggested command carries no
  `--app`. `upgrade`'s refusal of a malformed `OPENCLAW_IMAGE` is now phrased
  `OPENCLAW_IMAGE: "<value>" is not a valid image reference — expected
  [registry[:port]/]repo[:tag][@sha256:<64 hex characters>].`
* An MCP call that gives a variadic (`host`'s `args`, `set diff`'s `artifacts`) but omits a required
  positional (`host`'s `context`, the `action`) is refused like a missing argument instead of
  running with the variadic's first word in its place. `help` and `control-mcp` refuse extra or
  unknown tokens (`help status --bogus extra`, `control-mcp --bogus`) instead of ignoring them.
  Completion offers nothing after a bare `--` whether or not the parser would refuse what
  follows it, nothing at the value of an option with no declared choices (`logs --grep`), the
  choices for the default action (`backup --profile`), and nothing after an undeclared dash
  word of a pass-through command (`host --bogus`). `set try --app x` is refused with the
  "`--app` must come before the command" advice again; a refused word that is an option's value
  (`expose tailscale --break-foreign-lock funnel`) is accepted as the value.
* `init -- --local` no longer acts as `init --local`: the flag after a bare `--` is init's own
  data, so the init-nesting refusal applies again. An `--app` that a command's declared option
  consumes as its value (`accept p --set --app`) is no longer refused as misplaced. Completion
  offers nothing after a bare `--` for any command (e.g. `logs --since 1h --`), while a `--`
  that a pending option swallows as its value (`check --grep --`) no longer ends the options.
* The docker-compose `OPENCLAW_GATEWAY_TOKEN` guard message no longer names a program: a missing
  token now says `run bootstrap to generate .env`.
* A failing command no longer prints a `--json` error document when `--json` was an option's
  value (e.g. `--interval --json`).
* `-h` placed after a bare `--` is passed through to the command instead of printing help.
* The `--json` error-document decision on a parse failure now reads the real parser's tokens
  instead of a raw argv scan, so a failing command no longer prints the document in shapes
  where the parser would not bind `--json` (e.g. `pull --opt a --opt --json`); `--app` after
  a bare `--` (e.g. `verify -- --app`) is no longer refused as misplaced and `init -- --help`
  no longer skips the init-nesting refusal; `expose tailscale --funnel=1` reports the declared
  never-funnel reason instead of `unknown argument: --funnel=1`.
* Completion no longer offers a command's flags after a bare `--` for variadic commands (`check`,
  `set diff`), matching what the parser accepts there.
* `remove-app` over MCP now needs `confirm: true`: the gate command declares its effect, the
  tool schema derives `confirm` from it (required, the command having no read form), and a
  call without it is refused — with the same message the destructive deployment commands use —
  before anything is deleted. The terminal command is unchanged (the `--yes` dry-run flow).
* Gate command help (`check`, `new-app`, `remove-app`, `list`, `init`, `version`, `completion`)
  stops scanning for `--help` at a bare `--`, like the deployment commands: in
  `check -- --help` the `--help` is now the command's own data, not a request for check's help screen.
* `apply-config --dry-run` declares its effect as read, like every other `--dry-run` flag.
* A gate command's unknown-argument refusal (`version extra`, `check --bogus`) carries the same
  `run <program> <cmd> --help for its full argument list` pointer as the deployment commands'.
  `mcp-serve` on a never-bootstrapped deployment is refused with the `run <program> bootstrap`
  remedy — like `cli`, `exec`, `cli-start` and `set forget`, whose preflights no longer surface
  the raw "has never been bootstrapped" error without one; the bootstrap refusal's next step
  travels as structured advice, so MCP envelopes list it in `nextSteps`.
* Gate commands (`new-app`, `remove-app`, `completion`) refuse a missing required argument or
  an unsupported shell in the parser's own words, from their declarations, instead of
  hand-written `usage:` lines; `destroy --yes` without `--confirm-name` is refused at the
  parse stage with the declared rule's wording (previously a prepare-stage message), so the
  `--help` rules section and the MCP refusal carry it too.
* A set whose image reference the image grammar rejects is no longer accepted when it merely
  contains `@sha256:`: `set validate` reports it as the finding `SET_IMAGE_INVALID` (on a working
  tree and on an artifact alike), `set build` and `set try` refuse it, and `set try`'s throwaway
  `.env` carries the canonical form of the parsed reference.
* When an `init` run through the package's own entry (npx or `node_modules/.bin`) is refused —
  inside a Clawwright checkout, or nesting inside an existing deployment — the advice names the
  invocation it runs as (`./clawwright`, on Windows npm's bin wrapper) instead of a global
  `clawwright` command that does not exist.
* `secrets --print-template` is refused together with `--template`, `--init-store`, `--apply` and
  `--dump`: over MCP the read flag used to lower the call to read, skipping the confirmation of
  the destructive action that still ran. A command declaration that lets a read-effect flag meet a
  flag of another effect without a refusing rule is rejected when the framework loads. A
  deployment command (or a gate command) named like another command or like `help` or
  `control-mcp` is refused with an error naming both claimants, instead of two entries sharing
  one name. `recipe <action>` without a name is refused as a missing argument before the target
  is contacted. An MCP positional value that begins with a dash (`accept`'s `recipe`,
  `restore`'s `archive`, `operations`' `id`) is refused instead of being read as a flag.
  `help -- status` shows the help of `status`. Completion offers a command's declared default
  action's flags (`recipe --json`), compares words case-sensitively in PowerShell like the CLI
  does (`Backup`, `--TAIL`), and offers flags after an empty word in bash; `completion` states
  that a deployment's own commands are not completed.
* Shell completion offers `--version` and `-v` as the first word (they were accepted but never
  offered), and after the first argument of a pass-through command (`host`, `cli`, `exec`) it
  offers nothing more: what follows is the child's own text. After a bare `--` it offers nothing
  more either: everything from it on is the child's own text (previously the command's own flags
  were still offered). Regenerate a completion script saved to a
  file. On Windows, `clawwright` run in a deployment folder whose directory name differs in case
  from the name it is known by no longer fails with `invalid deployment name`.
* On Windows, a deployment that depends on its own `@phpcraftdream/clawwright` copy gets advice
  lines prefixed with npm's `node_modules\.bin\clawwright` instead of the bash-only committed
  `./clawwright` shim, which cmd.exe and PowerShell cannot run.
* `deploy`'s printed bootstrap lines quote the remote path (`cd '/srv/my app' && …`), so a
  path with a space pastes as one line instead of splitting; the `--app <name>` in advice
  lines and the `--app`-conflict refusal quote a deployment name the same way.
* `check --jobs` refuses a value that is not a whole number instead of silently falling back to
  the default; `set try` without `--set` is refused in the parser's words at the parse stage;
  completion offers the commands after a leading `--app=<name>` like after `--app <name>`
  (bash, zsh and pwsh alike); and the MCP `help` tool answers an unknown command as an error
  result, matching the console's exit 1.
* All 41 commands of the framework are declared once — arguments with their value rules, actions,
  effect and phases — and every command runs through one pipeline on the console and on MCP
  (parse, confirm, prepare, environment, context, run). What changes for users:
  * An argument error — a bad value (`--local-port`, `--interval`, `--tail`, `--profile`), an
    empty option value, a missing required argument, an unknown or missing action, a flag of
    another action, a cross-flag conflict such as `apply-config --dry-run --dump`,
    `rollback --previous-set --operation …`, `destroy --yes` without the right `--confirm-name`,
    `backup create --native` with a non-full profile, secrets' cross-flag rules, host's
    `--root`/`--confirm-root` consent, configure-provider's id/variable grammars, `set diff`'s
    artifact rules, `set receipts --receipt` without `--set-id`, `set try` without `--set` — is
    refused before any contact with the target, the instance lock or a .env write, on every
    host (previously the refusal could come after the bootstrappability check or the lock, or be
    answered by a target error such as LOCAL_TARGET_UNSUPPORTED where the transport could not
    be built). The same holds for recover-env.
  * The parser's own words are used on the console and on MCP alike: `--tail takes a number of
    lines, not "abc"`, `--profile takes one of full, migrate, share, not "…"`, `verify needs
    <archive>`, `set forget needs --kind <kind>` (and `--name`; a `--kind` outside agent,
    mcp-server, cron-job lists the choices). MCP `choices`/required errors and recover-env's
    argument refusals read exactly like the console's instead of schema-side ones. `recipe <action>`
    without its <name> answers `usage: ./clawwright recipe <action> <name>`; host's unknown or
    missing context and a missing command are named argument errors (`<context>` takes one of
    target, engine, local …); a missing deploy target, provision-agent recipe, or cli/exec
    command is reported as such instead of a usage line; `verify` without an archive is refused
    in the parser's words too, and so is `recipe verify --dry-run` (verify takes no --dry-run).
  * An empty option value (`--store ""`, `--set`, `--expect`, `--operation`, `--limit`, `--name`) is
    refused uniformly as needing a value.
  * The five multi-action commands (backup, recipe, watch, expose, set) answer an unknown or
    missing action in the same words (`needs an action: …`, `unknown action: x (expected …)`, with
    a guess), and a flag that belongs to another action says which action it belongs to
    (also for `set diff`). `set`'s action is required — bare `set` is refused, and the usage line
    and the MCP schema mark `action` required (it already was at run time). `recipe` lists its
    actions in its grammar's order in help and the MCP schema; `recipe --json` still lists.
  * `backup create --dry-run` reports itself as a read on every surface. `mcp-serve` refuses
    arguments instead of forwarding them to the gateway's `mcp serve` (it never declared any).
    `expose tailscale --funnel` (or `funnel`) is still refused with the same explanation, now by
    the parser, before any contact.
  * The MCP descriptions that were cut off with an ellipsis (`upgrade --image`, `rollback
    --previous-set`, `apply-config --dump`, `expose --apply`, `recipe <new-name>`) are the full
    phrases.
  * The effect of each command and action is declared once, and confirmation, the `changed`
    flag, the markers in the command list and the `--help` note derive from it; effects are
    unchanged (the `secrets` default report and `--print-template` read, `--template` changes,
    `--init-store`, `--apply` and `--dump` destroy; `recipe` reads for list/status/logs and
    install/remove --dry-run and destroys otherwise; `lock --check` and `deploy --dry-run` read;
    cli, exec and host remain always-destroying; `set` validate, diff and receipts read, build
    changes, try and forget destroy). A deployment command that is destructive and declares
    `requiresConfirmationWhen` without `readOnlyWhen` — confirmation is owed only for some
    calls — reads as "destructive for some actions" on every surface (` *` in the command list,
    the tool description, the `--help` note, and an optional "Confirm a destructive action"
    `confirm` in the MCP schema) instead of the flat always-destroys wording; the framework's
    own commands, which refine destruction with `readOnlyWhen`, are unaffected.
* `./clawwright list` answers an unknown argument the standard way — the refusal plus a
  pointer to `list --help` — instead of its own bare "unknown argument" line.
* A set is loaded and validated by one pipeline for the working tree and an artifact alike
  (`set validate` with and without `--set`, `set build`'s collection): an artifact is verified
  and unpacked, then answered by the same validator the tree gets, so both paths report
  identical findings for identical content.
* Deployments hand the invocation between processes as versioned JSON in `CLAWWRIGHT_INVOCATION`:
  the committed `./clawwright` shim `init` and `new-app` write, and the monorepo MCP launcher,
  now set it — alongside `CLAWWRIGHT_INVOKED_AS`, which they keep exporting so the shim and
  launcher keep spelling the hints right for older frameworks (pinned local or older global
  installs) that read only the old variable; a framework that reads both prefers the JSON
  and clears both. Shims and launchers already committed in your repository keep working, and
  `mcp-setup` rewrites a launcher carrying the old spelling as it rewrites its other retired
  texts. No command output changes.
* Advice is data — a suggested command, a line for another shell or host and an action with no
  command at all are values, and one renderer turns them into text for every surface. What
  changes for users:
  * Advice for a gate command (`new-app`, `list`, `check` …) carries no `--app <name>`:
    those commands run before a deployment is resolved, so the suggested command is now runnable
    as printed under every invocation. The same holds for the `--app must come before the
    command` refusal, whose suggested command line now uses the program as typed (`clawwright`,
    not the checkout spelling that does not run in cmd.exe or PowerShell).
  * Entry refusals print their advice as an indented `→` line under the message instead of an
    `error:` line per sentence, and the bash spelling of a suggested command is offered as a
    separate line marked `(in bash)` instead of a parenthetical inside the sentence.
  * Problems and JSON documents that carry `nextActions` (inspect/doctor/lock --check/apply/set
    validate --json) now also carry a structural `next` — the remedies as data instead of
    rendered strings — and the MCP structured envelope carries `nextSteps` (`{tool, arguments}`)
    beside the unchanged `nextActions`. Notes that used to name a second command with the
    program now name it bare (`` `up` ``, `` `expose` ``, `` `lock` ``) in the note.
  * Nothing on the way out rewrites a line: the cron line of `backup install`/`watch install`,
    the Task Scheduler command lines, the server bring-up hints of `deploy` and JSON documents
    come out exactly as built — under a non-default invocation they no longer gain or lose
    `--app <name>`.
  * `watch test`'s notification names this deployment's command.
  * The help text of the framework's own commands renders a command from the invocation, the
    same for humans wherever it is printed, and an application's own `./clawwright` written in
    its `details` is no longer rewritten — what the declaration says is what prints.
  * The `exec` entry in the command list and its MCP tool description names `cli` without the
    program.
* Command surfaces are read from one registry of declarations instead of hand-kept lists:
  * MCP tool schemas describe each argument with its declared summary — no heuristic shortening;
    the `(value: <…>)` suffix is gone; `break-lock`/`break-foreign-lock` name the actions they apply
    to on backup, expose, watch, recipe and set.
  * Shell completion scripts are now a fixed interpreter plus a table generated from the command
    declarations, identical in behaviour for bash, zsh and PowerShell; after `help <command>`
    only `--help` is offered. A script saved to a file (`> "${fpath[1]}/_clawwright"`) needs to be
    generated again; the `source <(…)` and `| Invoke-Expression` forms update themselves.
* Cross-field refusals of `apply-config`, `rollback`, `host`, `set diff` and `set receipts` now
  happen at the parse stage, before any contact with the target, in the parser's wording (an
  `ArgumentError` naming the argument); several texts changed accordingly (`--force requires
  --dump`, and `set diff` speaks the parser's voice).
* `set diff`'s two positional artifacts reach the MCP schema (`artifacts`, an array of strings),
  `set --help` and MCP validation: calling `set` over MCP with `artifacts` is accepted instead of
  answered `unknown argument: artifacts`.
* `secrets`' cross-flag refusals use the parser's one voice: `--break-foreign-lock requires
  --apply — no other action takes the instance lock` and `--json cannot be combined with
  --<flag> — only the default report is structured` (the old `--json only supports the default
  report — not with …` wording is gone).
* A set recipe that keeps `acceptance.json` private (`recipe.json` `privateFiles`) now builds an
  artifact that loads: the acceptance checks no longer travel for a file the portable-content
  policy holds back, so loading the artifact is not an integrity error. The same rule now applies
  to a recipe that keeps `agent/config.json` private: the set declares no agent, and `set validate`
  reports the acceptance checks naming that agent as a dangling reference (`SET_REFERENCE_BROKEN`)
  on a working tree and an artifact alike. A deployment (or gate) command named `--version` or `-v`
  is refused when the framework loads: the gate rewrites those spellings to `version` before
  dispatch, so the command would be unreachable while still listed by help, completion and MCP.
  `check` runs no longer leave `apps/cli-help-check-*` fixtures behind: the check is declared
  exclusive and its cleanup retries and fails loudly instead of leaking into the checkout.
* A refusal whose sentence names the checkout root answers with a row that runs in the reader's
  own shell: the command is spelled from the checkout root for the invocation that got the
  refusal (the system-wide `clawwright` for an installed run, the checkout's `./clawwright` for a
  checkout copy), with the bash-shim row beside it only where it says something different — a
  cmd or PowerShell user of the installed command gets a row they can run again. The gate's
  sibling sentences about the checkout root (`help` at the root, the not-initialised and
  `--app`-conflict rows, the inline notes beside them) spell it the same way, and the
  `cd '<checkout>'` they hand over is quoted with the shared shell quoter, so a path carrying
  `$` or a backtick pastes as a path. An invalid `--app` value is refused with the gate's own
  deployment-name error before the conflict decision, instead of being echoed back as advice
  that the root would refuse itself.

* new-app's git-init note spells the lock line for the deployment it just created
  (`--app <name>`), one frame for the whole sentence: pasted, it locks the new deployment
  instead of the default one.

* The completion scripts' `Install:` headers and `completion --help`'s prose spell each install
  line for its own shell through the shared renderer, independent of the invocation's host: a
  bin-wrapper spelling carries forward slashes bash does not strip, so the bash and zsh lines
  source and the PowerShell line resolves.

* A `--json` failure document and an MCP failure envelope carry the refusal's structured
  advice — `next` and `nextActions` beside the message, `nextSteps` as the tool calls, each
  with the advice's note — so the remedy no longer lives only in the failure text.

* recover-env answers an unreachable target with the standard TARGET_UNREACHABLE refusal and
  the transport's own next step, not "docker is not running".

* deploy-to-remote's printed remote lines paste from a fresh ssh session: the provider-keys
  hint carries the `cd '<remote>' &&` its sibling lines have, and the ssh tunnel line is the
  shared construction that quotes its arguments, so a host carrying `$` survives the paste.
* Local tar runs (set build/pack and artifact load) go through the single owner module `set/artifacts/tar.ts` with a 10-minute default timeout, the flag-refusal retry normalizes its paths like the first attempt, and a retry that fails again is reported through the build's own refusal sentence (tar's first-attempt cause) instead of a thrown command failure.

### Fixed

* Advice printed after a hand-over from the MCP launcher keeps `--app`: the launcher's program is the
  checkout gate, which reads `--app` and `OC_APP` and never the working directory, so the pasted
  `../../clawwright bootstrap` no longer targets the default deployment. A flagged `--app openclaw` is
  kept too while `OC_APP` may be set, because `OC_APP=staging` makes `openclaw` the exception. `set
  validate` judges a recipe's required files (`server.ts`, `agent/config.json`) by the files the set
  carries, so a file listed under `privateFiles` is reported missing on the tree as it is on the
  artifact, instead of passing `set build` and failing at `plan`/`apply`/`accept`. `accept` reads
  `acceptance.json` with the reader `set validate` uses (a file holding `null` no longer throws). A
  digest the registry answers that is not a `sha256:` digest is not pinned by `bootstrap` or `upgrade`.
  `restore` prints the two commands that re-point a sidecar recipe on separate lines instead of
  joining them with `&&`, which Windows PowerShell 5.1 does not accept.
* An agent recipe without `server.ts` (or without `agent/config.json`) no longer dies as
  "<artifact> is not a valid set artifact: … incomplete agent bundle" on `set validate --set`
  — it is reported as the `SET_RECIPE_INCOMPLETE` finding the working-tree validation gives
  for the same content; only a corrupt archive or an artifact disagreeing with its own
  manifest is refused as an integrity error.
* `set validate` on a working tree whose `config/desired-state.json` is missing, empty, not
  valid JSON, or not a valid declaration reports the `SET_DECLARATION_INVALID` finding instead
  of refusing before anything was printed or — for a missing or empty file — reading as a
  coherent set that declares nothing: the same answer an artifact carrying the same bytes
  gets. `set build` still refuses to pack such a tree.
* The `--json` failure contract fires only for a command's own declared `--json` flag:
  `cli`/`exec`/`host` pass their whole tail to a child, so a failing `clawwright cli … --json`
  no longer appends a second `{"error":…}` document after the child's own streamed output
  (streamed stdout counts as already-printed output). `help control-mcp` (and the MCP `help`
  tool) now prints control-mcp's help from the same declaration `control-mcp --help` uses,
  instead of failing with "unknown command: control-mcp / did you mean: control-mcp", and an
  exact name is never offered as its own did-you-mean suggestion.
* `upgrade` recreates the gateway on the exact reference it pins into `.env` — on success
  with an explicit `--image` digest of the tracked repository and on rollback over a bare-tag
  pin — so the next `up`/`apply` no longer recreates the gateway again over a spelling
  difference; `--json`'s `pinnedImage` and the `--dry-run` plan name that same string.
  An explicit `--image repo@sha256:…` is now format-checked (64 hex) and verified at the
  registry before `--dry-run` reports it and before a real run takes its pre-upgrade backup.
* `upgrade` refuses a malformed image reference before contacting anything: a bad `--image`
  (malformed digest or tag) fails locally with the reference grammar's own refusal naming the
  input, and a malformed `OPENCLAW_IMAGE` in `.env` is refused the same way instead of being
  sent to the registry as given.
* `set validate` and `set build` give one image-pin advice decided from the lock's content
  (lock for another image, lock without digest, no lock) instead of disagreeing — `lock` no
  longer claims to record what the running gateway serves (it records the local image's
  digest), and a committed lock without an instance is no longer read as "deployed".
* `set diff` no longer blames the good artifact when the second one is corrupt, and
  `set validate --set` with blocking findings ends in the findings' summary again instead of
  "<artifact> is not a valid set artifact: N blocking finding(s)": the read-only unpack gate
  wraps only the artifact's own integrity failures, and a caller's error propagates unwrapped.
* `set validate` parses each recipe's recipe.json with the same loader `recipe list` and
  `recipe install` use, so a recipe the listing calls broken is a blocking finding (new
  SET_RECIPE_INVALID code) in the tree and in a built artifact instead of failing only
  mid-apply on the target — and each completeness gap carries the advice that closes that
  gap (add server.ts, add agent/config.json, fix the tree and rebuild) rather than one
  recipe.json-or-server.ts line for all of them.
* The `hook-framework-import` check no longer sweeps every `apps/gateprobe-*` directory before
  its run — `gateprobe-prod` is a legal deployment name and the sweep deleted it whole
  (`.env`, `secrets/`, lock and all). The check now marks its own fixture with a token file
  and sweeps only directories carrying that mark; any other `gateprobe-*` directory survives,
  and a name collision fails the check instead of deleting.
* Shell completion: `--app` after a command offers that command's flags in the model and the
  pwsh script, matching bash (`--app` must come before the command), and option choices are
  scoped by the typed action — `set forget --kind <Tab>` offers the kind values, `set try
  --kind <Tab>` does not. The pwsh completer body is executed by a PowerShell-subset
  evaluator in the check and compared scenario-by-scenario against the model and a real
  sourced bash script, so a body mutation like the R32-02 regression fails the check instead
  of passing substring pins.
* PowerShell completion answers again with a typed prefix (`clawwright sta<Tab>`, `--ap<Tab>`,
  `backup l<Tab>`, `watch in<Tab>`), which the previous script lost by scanning the word being
  completed as a typed command; `--app <name> backup <Tab>` offers the default action's flags
  again, and `backup --hot <Tab>` no longer offers action words backup would reject. The
  completer's candidate decision now lives in one function the checks drive through
  words-and-cursor scenarios — against the emitted tables of the pwsh script and a real
  sourced bash script, not script substrings.
* Completion covers `help <command>` (command names), `completion <shell>` (the shell names),
  `host <context>` and every option declared with fixed choices (`--profile`, `--kind`,
  `--client`) at its value position instead of offering flags a command would refuse there.
  `<deployment command> --help` and `help <deployment command>` answer from the built-in
  declarations outside an app folder and in a checkout subfolder — with a note naming where
  the command runs — instead of refusing with "needs an app folder".
* The action-argument drift check now drives every action command's real dispatcher (watch,
  expose, set, backup, recipe) per action and flag — declared means accepted — so a table
  drift like `watch status` gaining `--install` flags fails it. The MCP description oracle
  states structural properties (prefix of the declaration's text, clause-boundary or
  ellipsis-marked cut, no dangling word, budget) instead of repeating the implementation's
  cut algorithm, and the gate probe writes a uniquely named scratch deployment (own prefix,
  refuses to adopt an existing directory, sweeps its stale fixtures) and asserts the app
  actually loaded. The module-load check lists the two import cycles the graph shows, not
  the broken `set` one.
* Failure paths run their checks in the right order: `logs`, `smoke` and `configure-provider`
  parse (and refuse) their arguments before contacting the target or taking the instance lock,
  `recover-env`'s unknown-flag refusal points at `--help` like every other command's,
  `expose ssh --local-port` is bounded to 1–65535, and `incident --dry-run` exits non-zero when
  its contain phase could not reach the target instead of printing a plan built from failure
  notes (a real run still rotates over a noted contain failure). One `--json` failure contract,
  documented in the command reference: a command invoked with `--json` that fails after its
  arguments parsed prints `{ "error": { "message": … } }` on stdout and exits non-zero, so a
  script's `jq` never receives empty input.
* More purely local refusals before any trip to the target: `recipe install|verify|onboard|diagnose`
  with a misspelled or missing recipe, `provision-agent <typo>` and `secrets --apply` with an
  invalid or missing `--store` name now die on the local check instead of taking the instance
  lock or answering with a transport error — the same typo `--dry-run` already answered locally.
* Re-running `bootstrap` on a live instance no longer suppresses apply-config's "restart to pick
  it up" advice: `compose up --detach` leaves an already-running container untouched, so newly
  written desired state reaches the gateway only on the next restart, which the help, the README
  and the command reference now say plainly (a fresh instance keeps the advice suppressed — that
  run starts the gateway itself).
* Text and hygiene: the `--json` failure-contract paragraph in the command reference names the
  real failure documents per command (no more `upgrade --dry-run` as a counterexample); the
  incident guide says `--dry-run` exits non-zero when contain cannot reach the target, and the
  dry-run's own contain note no longer claims "rotate proceeds regardless"; the sets guide states
  which `set` actions run over MCP without a confirmation; `plan --set`/`accept --set` print
  "checking …" instead of "installing from …" (only installers — `apply --set`, `rollback
  --previous-set` — claim to install, and `apply --set --dry-run` checks); the "depending on the
  action given" help line appears only on commands that have actions; and the target-side
  `readlink -f` helper is one shared `physicalPath`, not three copies.
* The checks now distinguish the fixes they cover: a scratch checkout deployment's `app.ts` importing
  `@phpcraftdream/clawwright/app` must load through the gate, the watch cycle lock's start-time tolerance
  is asserted at absolute 14 s/16 s offsets, the upgrade `health-fail` scenario reaches the health
  gate (the stub's post-backup restart succeeds and the failure names health after recreation), and
  each module of the two known import cycles loads as a first import. Hygiene: the package-export
  map moved from the recipe-hook module to `core/env.ts` (with a both-directions check against
  `package.json`), the `regexEscape` copy in a check is gone and the single-definition audit covers
  `tools/checks` too, and the identity `actionLabel` indirection was removed.
* A failed `upgrade`'s rollback recreates the gateway on the same reference it writes back to
  `OPENCLAW_IMAGE` — the exact pre-upgrade pin (tag and digest), not the tagless `repo@sha256:…`
  form Docker reports, so container and `.env` agree and inspect/doctor see no divergence after
  a rollback; when `.env` named a bare tag, the rollback runs the digest that was proven and
  pins that tag alongside it. The connection-fact comparison reads the image by digest, so the
  two spellings of one digest no longer read as stale, `plan` offers no spurious
  `recover-env --adopt-runtime`, and the next plain `upgrade` (or `--dry-run`) re-resolves the
  channel instead of refusing on a pin it blames on "older versions". A genuinely tagless pin
  is still refused, with the `--image <repo:tag>` remedy and no blame.
* `upgrade --image repo@sha256:…` keeps the deployment's tag when the digest names the same
  repository, so the success pin stays a channel a plain `upgrade` can re-resolve; a digest of
  a different repository still pins as-is, and the help and guide say so instead of claiming
  every digest is "used as-is".
* `backup install --interval <bare number>` suggests only spellings the command itself accepts:
  `1440` reads as `1d`, `90` as `1h, 2h`, `0` as `1m` (previously `1440m`/`1440h`, which backup
  then refuses), and its general refusal no longer opens with "a number of minutes" — backup
  requires an explicit unit. `watch install` still accepts bare minutes.
* `set build`'s no-digest refusal names the remedy for both states — `./clawwright bootstrap`
  before the first bootstrap, `./clawwright lock` on a running instance — instead of always
  advising `bootstrap`, which on a live instance re-resolves the tag and recreates the gateway
  with no backup, lint gate or rollback; the lock-mismatch refusal (which only exists on a
  deployed instance) advises `upgrade --image`/`lock` and never `bootstrap`. `SET_IMAGE_UNPINNED`
  picks its remedy the same way: `./clawwright lock` once a lock is recorded, `./clawwright
  bootstrap` before. Artifact validation now runs the same recipe-completeness checks
  the working-tree validation runs (the artifact is unpacked when verified), so a tree with
  blocking findings can no longer build into an artifact that `set validate --set` calls coherent —
  the install-time unpack gate (behind `apply --set`, `rollback --previous-set`, `set try` and
  `accept --set`) refuses it, while read-only `set diff` still accepts such artifacts.
* `backup --help` (and MCP `help backup`) no longer promises "30m, 6h, 1d or a bare number of
  minutes" for `--interval` — an explicit unit is required, as the argument's own line already
  said.
* Checkout help leftovers: `<command> <action> --help` at the checkout root answers with the
  command's help instead of "several deployments" (so does `--help` after the command's own
  flags); `help <checkout command>` in a checkout subfolder points to the checkout root instead of
  "unknown command"; the `cd` hint quotes the path; and `init` in a checkout refuses with what is
  actually true — it writes an installed-style deployment, not one the checkout cannot load.
* MCP argument descriptions are cut only at clause boundaries and marked with an ellipsis when
  nothing whole fits, so no schema line ends mid-phrase or flips meaning (`secrets --json` no
  longer reads as refused by itself, `recover-env --adopt-runtime` no longer stops at "merge
  its"); `backup`'s `action` positional now says that omitting it creates a backup. Five long
  declarations were reworded so their short forms are complete phrases.
* `set`'s merged declaration describes a shared flag per action instead of letting the first
  action's text stand for all (`set --name` says the set for build/validate and the object for
  forget), `watch --json` lost its stale "With check/status:" lead-in, and `set try`, `set diff`
  and `set receipts` parse with the same action scope as the other actions, so a flag of another
  action is refused naming that action, not as unknown.
* Shell completion offers a default-action command's own flags on the first position too, in
  bash/zsh (`clawwright backup --h` completes `--hot`, not only `--help`) and in PowerShell,
  where a trailing space is now treated as starting a new token instead of extending the last.
* MCP schema descriptions are shortened per action: a composed description keeps each part's
  own action list (`set --json` in `tools/list` names all five actions' texts, `set --name`
  stays bound to its actions), boundary characters inside brackets or quotes no longer end a
  clause (the `cli.args`/`exec.args` JSON examples survive whole), nested parentheticals are
  stripped to a fixed point (`check.jobs` keeps no unclosed bracket), and `cli.args`,
  `exec.args`, `host.args`, `host.root`, `check.jobs` and `restore.json` carry short explicit
  schema lines. `--help` no longer appends the whole-command action list when every part of a
  composed description already carries its own.
* `set validate --set` on an artifact with blocking findings reports them instead of dying
  inside the unpack gate: `blocking:` lines with the recipes named, the `--json` document,
  and non-empty `problems` for an MCP client. `set diff` (read-only) accepts such artifacts
  too; the artifact answers exactly as its tree (a recipe with no portable content is
  reported, not skipped). Install-time callers (`apply --set`, `rollback --previous-set`,
  `set try`, `accept --set`) stay strict, with each failing code once (counted) and the
  recipes named in the refusal. `SET_RECIPE_INCOMPLETE` advice names the concrete edit; the
  unreachable second validation in `set try` is gone.
* Hygiene: the data-directory ancestry walk lives once (`runtime/datadir.ts`, with the
  `sudo` prefix as a parameter) for both `restore` and `datadir`, keeping the stricter
  checks; the pointless `unpackForTry` alias is gone; five CHANGELOG claims were corrected
  to what the code does, and the upgrade rollback check no longer calls a parsed-value
  comparison "byte-for-byte".
* `set validate` on a working tree whose image is not pinned yet builds the manifest with the
  tag in `requires.image` and reports `SET_IMAGE_UNPINNED` as a blocking finding together with
  everything else it found — in `--json` too — instead of dying inside the manifest build with
  no findings at all. Its advice follows the deployment's state — `./clawwright lock` once a
  lock is recorded, `./clawwright bootstrap` before (where `lock` refuses). The hard
  refusal stays on `set build`.
* Recipe hooks and a checkout deployment's `app.ts` can import `@phpcraftdream/clawwright/private-config`
  (and the package's other public exports) the way the guide and the `--with-hooks` stub say: in a
  checkout there is no dist build and no install to resolve the specifier against, so the hook
  loader and the checkout gate map the exports onto the checkout's own framework sources, while an
  installed deployment still resolves the recipe's own package first. The guide's example hook no
  longer uses the unloadable `#framework/...` spelling.
* Checkout commands answer clearly outside a deployment again: `list`/`new-app`/`remove-app`/`check`
  from a checkout subfolder say to run them from the checkout root instead of "unknown command"
  (a regression of the R29-01 fix); at the checkout root `<command> --help` works with several or
  no deployments, the same way `help <command>` always has; `version` answers in a folder holding
  a stray checkout-style `app.ts`; the "new-app takes over this empty directory" advice only
  names folders new-app accepts, and an existing empty `apps/<name>` is offered to `new-app`
  rather than told to gain an `app.ts` by hand.
* `set`'s actions each parse their own argument slice, so completion, `--help` and the MCP schema
  no longer offer a flag the chosen action refuses (`set build --set`, `set validate --kind`,
  `set forget --json`); a flag of another action is refused naming that action, and the drift
  check drives the real dispatcher, not the registry against itself.
* `backup create` is the explicit word for the default action the help already called "create":
  it parses like a bare `backup`, a mistyped action word (`backup lst`) gets the usual
  did-you-mean instead of "unknown argument", a create flag under another action names `create`,
  and completion offers the create flags when no action word was typed (the pwsh fallback is no
  longer just `--help`).
* No MCP `tools/list` argument description ends mid-phrase: the "With x:" lead-in is stripped
  before the 60-character shortening and a cut that would land on a dangling word ("a bare number
  is", "instead of") drops it, so `--interval`'s bare-number unit survives.
* A live lock/compose-env owner is no longer called dead under load: its recorded start comes
  from `process.uptime()` (counted after Node's own boot) while the OS probe has 1 s resolution,
  so the same process could differ by more than the 2 s reuse tolerance. The tolerance is now
  15 s — Windows reuses pids within seconds of the original, and calling a live owner dead loses its
  state; no tolerance separates reuse from jitter perfectly, so 15 s keeps the common live case safe
  at the cost of holding a stale lock a little longer. Seen as a flake in `compose-sweep.check.ts`.
* The global command refuses an `app.ts` inside a checkout by what it imports, not where it sits:
  only a relative import of the checkout's `tools/framework/` (the `new-app` declaration) outside
  `apps/<name>` is refused; an installed-style `app.ts` (`@phpcraftdream/clawwright`) under a checkout
  path runs as before, including `version` and `--project-root`.
* Checkout advice: the `(in bash also ./clawwright new-app <name>)` form is printed literally instead
  of being localized away; "new-app <name> takes over this empty directory" is said only for an
  empty `apps/<name>`; `help <typo>` in a checkout never suggests `init`; a mistyped command
  outside an app is `unknown command` with a did-you-mean, not "no app.ts"; `--app <name>` on an
  `apps/<name>` without `app.ts` says the directory exists and holds no `app.ts`.
* `init --local` in a checkout deployment (`apps/<name>` or a subfolder) prints that the editor types
  already resolve through the checkout and exits 0, instead of "unknown command: init" or an
  `npm install` line for the global package.
* `watch install --interval` names nearest valid values in the same spelling it accepts
  (`6h, 8h`), never an empty list (`watch install --interval 10m` used to print `nearest valid:`
  with nothing) and never a value the command itself rejects.
* `expose tailscale` no longer advises `tailscale serve reset` (it drops other services' routes on
  the node): the printed undo is `tailscale serve --https=443 off`, and the `incident` fallback note
  no longer offers `reset` either. A check scans the framework sources and the guide so no text
  recommends it again.
* Removed the unreachable "framework running natively on Windows, node invoked directly" scheduler
  branch (`local` is refused on Windows, so only a WSL or SSH target exists there); the WSL
  `schtasks` line and `--apply` are unchanged. `schtasks` rejects a `/tr` over 261 characters, so
  `watch install`/`backup install` on WSL under Windows now refuse such an action with a message
  (shorten the deployment path or app name) instead of printing a line or failing in `--apply`.
* Completion, `--help` and the MCP schema of `backup`, `recipe`, `watch`, `expose` and `set` show
  under each action only the flags that action accepts (`backup list --hot`, `watch status
  --interval`, `expose status --local-port`, `set receipts --to` were offered and then refused).
  Each action's flags are declared once, from its own parser's argument list (`backup`'s bare
  create counts as an action), and a check compares each action's declared argument slice with
  what its own parser accepts, so a new flag cannot drift. A `backup` create flag under another
  action is refused naming the create parser ("--hot applies to `create`, not `list`"), not as
  "unknown argument".
* System-wide `clawwright` hands over to the checkout's gate from `APPS/<name>` on Windows too (the
  `apps` directory is matched by its real spelling), so the global package no longer loads the
  checkout's `app.ts` next to its own framework. An `app.ts` inside a checkout that the gate cannot
  take over is refused with the checkout entry named, instead of loading a second framework copy.
* Help without an app: a bare `clawwright` lists the gate commands (exit 0); `help <unknown>` says
  `unknown command: <x>` with a did-you-mean over the deployment and gate commands, while a real
  deployment command keeps "needs an app folder"; inside a checkout the list no longer offers
  `init` and says `./clawwright help` at the checkout root lists the commands. `init --local` from a
  subfolder of an initialised app prints the editor-types line instead of refusing (it writes
  nothing); plain `init` there still refuses.
* `init` help no longer breaks a sentence mid-line. A dry-run `destroy` shows an absent directory as
  `absent — nothing to remove` rather than `would remove … (absent)`.
* Text accuracy and hygiene: `init`/`new-app` say snapshots go to the snapshot directory
  (`OC_SNAPSHOT_DIR`), not the data directory; a text `lock --check` names a missing lock only in
  its summary, never under `differences:`; a dry-run `destroy` sizes targets through the shared
  `humanSize` (a 5 GiB directory reads `5.0 GiB`, not a seven-digit KiB count); the scheduler
  module reuses `regexEscape` instead of a private copy, and the single-definition audit matches
  the escape body so an arrow-function copy can no longer slip past; an unused `defaultRecipesDir`
  export is gone; the guide no longer calls `1d` "daily at midnight" for the start-time-less WSL
  `schtasks` fallback.
* `backup install` / `watch install` on a WSL target under Windows print a `schtasks /create` line
  that cmd.exe now runs as a whole: the WSL command inside `/tr` is `set -e; cd -- '…'; exec …`
  instead of `cd … && …` (cmd.exe split the old line at `&&` and created a task that only did
  `cd`). The line is labelled for cmd.exe (other shells: `--apply`) and withheld when a path has
  `%` or `& | < > ^`; `--apply` passes the same `/tr` as before. Checks now parse the printed
  line by cmd.exe and `CommandLineToArgvW` rules and compare it with the `--apply` argv, run the
  install and deploy hints under a non-default invocation, and count `sudoFor`'s three probe
  attempts on an unenterable parent.
* Only a subdirectory of `apps/` with `app.ts` and a valid name is a deployment, for the gate, the
  sole-deployment fallback, `list` and completion: an empty `apps/<name>` (left by a refused `init`)
  no longer breaks `./clawwright help`/`status`, and a hidden `apps/.x` is ignored. `list` shows
  other visible folders as `not a deployment: no app.ts`. `new-app` accepts an existing empty
  directory (a non-empty one is still refused).
* The MCP launcher of a checkout deployment (`apps/<name>/mcp-launch.mjs`) sets the invocation to
  `../../clawwright --app <name>`, so hints resolve from `apps/<name>`; `mcp-setup` rewrites the
  previous launcher.
* `init` refused inside a checkout advises `clawwright new-app <name>` from the checkout root
  (`./clawwright` as the bash form) instead of a quoted `'./clawwright'` that fails in cmd and
  PowerShell, and says an empty folder can be reused by `new-app`.
* A privileged command (backup, restore, secrets …) no longer asks for sudo on a path it can write
  when the target's existence probe fails once: `sudoFor` asks the probe up to three times before
  treating a refusal as a directory this user cannot enter. Seen as "needs root and sudo asks for
  a password" on a `/tmp` backup under load.
* System-wide `clawwright` in `apps/<name>` of a checkout no longer doubles `--app`: the same name is
  passed on once, another one is a clear error. On a hand-over, hints for a non-default deployment
  now read `<invoked-as> --app <name>` (`clawwright --app foo bootstrap` from the checkout root),
  plain only when the cwd is inside that deployment.
* System-wide `clawwright` inside a checkout no longer advises `init` in a non-app subfolder (it
  says `./clawwright` in the checkout root is the entry), and `init` there is refused with
  `./clawwright new-app <name>` instead of writing an `app.ts` the checkout gate cannot load.
* Without `CLAWWRIGHT_INVOKED_AS` (MCP launcher, `npx`, `node_modules/.bin`) hints say `./clawwright`
  for the app's own package copy and `clawwright` only for the system-wide one.
* `destroy` without `--yes` no longer asks for sudo for directories that do not exist: an absent
  target is reported absent (present ones are verified as before), `du` uses read access instead
  of write access, and when nothing exists to remove it says so instead of inviting `--yes`.
* `lock --check` on an instance that is not running separates "could not compare" (inventories not
  read) from real differences, and ends with a single summary line instead of printing it twice.
  The exit code and the `--json` output are unchanged.
* `lock --check` (and the MCP `lock` tool, and `--json`) uses the same summary everywhere: unread
  inventories are "could not compare", not "N difference(s)", and the text output opens with a `==>`
  headline again. On a never-bootstrapped instance they are reported as `NOT_BOOTSTRAPPED` (not
  `GATEWAY_DOWN`) with `bootstrap` as the next action, since `up` refuses there. The exit code and the
  JSON document shape are unchanged.
* Shell completion of `--app` values calls the command as typed (`clawwright` or `./clawwright`, from
  any folder) with `list --json --no-status` — no per-Tab polling of every deployment's target — and
  skips hidden directories; PowerShell completes `--app` values too.
* Lines copied into another shell or host are printed verbatim, not rewritten to this terminal's
  invocation: the cron line of `backup install` / `watch install` (what is shown is what `--apply`
  installs), the Task Scheduler command lines, and the server bring-up hints of `deploy` (the
  server's mirrored checkout runs `./clawwright`). Fixed the cut-off sentence in the `init`
  next-steps text ("…if one is needed"); the `Install:` comments of the generated completion
  scripts name the real invocation, script bodies unchanged.
* `clawwright init --local` in an already initialised directory now prints the
  `npm install --no-save "<package directory>"` line and exits 0 without writing anything, so the
  editor-types advice `init` gives is reachable; plain `init` there still refuses, and a fresh
  `init --local` is unchanged.
* Outside a deployment, `clawwright help`, `--help` and `-h` list the gate commands (`init`,
  `version`, `completion`) and say the full list appears inside an initialised app folder, exit 0;
  `help <gate command>` prints its help. `help <app command>` says it needs an app folder. Every
  other command keeps the `no app.ts … run: clawwright init` error.
* `clawwright init` writes the directory's name into `app.ts` (`name:`), as `new-app` does, instead of
  a hardcoded `openclaw`: the help heading and the MCP `serverInfo` (`<name>-control`) now differ
  per deployment.
* System-wide `clawwright` in a subfolder of an app (e.g. `<app>/recipes`) now finds the deployment
  by walking up to the nearest `app.ts` instead of reporting `no app.ts` and advising `init`; the
  found root is what delegation uses. `init` still initialises the current directory only and
  refuses, naming the ancestor, when an ancestor already holds `app.ts`. Outside any app the
  `run: clawwright init` advice is unchanged; `--project-root <abs>` never walks.
* The hand-over flag (`CLAWWRIGHT_DELEGATED`) now covers only the immediate hand-over: the receiving
  entry clears it at startup, and a checkout gate is never given it, so a `clawwright` run by a hook
  or `host` command in another app delegates to that app's own framework. A hand-over target that
  cannot be started now prints the error instead of exiting silently.
* Stale texts: `docs/guide/commands.md` now lists `backup install|uninstall` and `--interval`,
  `mcp-setup --rewrite-launcher`, `check --jobs/--require`, `init --local` and `version`, and the
  completion section names the real `list --json --no-status` call; the WSL scheduler line reads
  `wsl.exe -d <distro> --exec bash -lc "set -e; cd -- …; exec …"` in docs and `watch` help;
  `new-app` help says an empty existing directory is accepted; `init`/`new-app` no longer claim
  snapshots stay inside the deployment directory (they go to the data directory on the target).
  A new check keeps the command table in step with the declarations (every command, action and
  flag, with an explicit allowlist).
* `lock --check` with no lock file says `no lock file to compare against` instead of counting it as
  a difference from the lock (exit code and JSON unchanged). `backup list` labels sizes KiB/MiB like
  `remove-app`, from one shared helper; the recipe-name listing is one helper shared by `lock` and
  `set`; the system-install check no longer writes into the tracked `docs/` folder; the entry's
  re-exports that only the gate used are gone.
* `rollback --previous-set` with `--operation` or `--no-restart` now names the current invocation
  (`clawwright --app prod apply` for an installed or named app) instead of always `./clawwright apply`;
  `list` and `inspect` treat a malformed image digest (`repo@sha256:zz`, an uppercase digest) as
  unpinned; `set validate` and `set build` name the recipe and file for a malformed `agent/config.json`
  or `acceptance.json` instead of printing a bare JSON error, and a self-consistent artifact carrying
  one is reported as a finding rather than an integrity failure.

### Added

* `version --verbose` prints which copy runs and where; `version --json` gains `source`
  (`global` | `local` | `checkout`) and `path` (package directory, checkout root for a checkout).
  Plain `clawwright <version>` is unchanged. `npm run install:system` (npm's global prefix) now
  warns, with both paths, when the `clawwright` PATH resolves to is not the shim it just installed.

* System-wide install: `npm run install:system` packs `tools/framework` and installs it with
  `npm install -g` (`-- --prefix <dir>` for another prefix), then runs the installed command and
  says when its directory is not on PATH. The global `clawwright` works in any app folder: a local
  `@phpcraftdream/clawwright` dependency still wins (the global command hands over to it), `apps/<name>`
  and the root of a Clawwright checkout go to that checkout's gate, and a folder with neither runs on
  the global package, whose `@phpcraftdream/clawwright` imports then resolve to it. The `./clawwright`
  script and the MCP launcher `init` writes fall back to the global command; an unchanged launcher
  from before is still rewritten, not reported as a local edit. Covered by `system-install.check.ts`
  on every CI platform, plus a real global install used from PATH (bash, and PowerShell on Windows).
* `doctor`/`inspect`: `BACKUP_MISSING` (no full backup archive in `OC_BACKUP_DIR`) and
  `BACKUP_STALE` (the newest one older than `OC_BACKUP_MAX_AGE`, default 2d) so a silently
  stopped backup schedule is a warning, not a surprise at restore time; `DISK_LOW` (free
  space at the data or backup directory below `OC_DISK_MIN_FREE_MB`, default 1024 MB) — a
  separate, warning-only sibling of `watch`'s own `DISK_LOW`, not wired into it. All three are
  warnings and never fail `doctor`'s exit code.
* `recipe new <name> [--with-hooks]`: scaffolds `recipes/<name>/` with a minimal valid
  `recipe.json` and a `compose.yml` skeleton, no hooks by default; `--with-hooks` adds
  commented `prepare.ts`/`verify.ts` stubs. Repository-side, like `import`: no target, no
  instance lock, refuses an existing directory.
* `completion <bash|zsh|pwsh>`: prints a shell-completion script, generated from the live
  command declarations — command names, per-command flags, and a multi-action command's own
  flags placed under the right action.
* `destroy` / `remove-app`: the inverse of `bootstrap`/`new-app`. `destroy` always stops and
  removes the compose project's containers, network and volumes; `--data`/`--backups`/
  `--snapshots` each remove their own declared directory, never the deployment directory
  itself. `remove-app <name>` deletes `apps/<name>/` and refuses while the instance is still
  bootstrapped. Both default to a dry run; a real run needs explicit confirmation
  (`--yes` for `remove-app`, `--yes --confirm-name <name>` for `destroy`).
* `upgrade`: digest-pinned image updates, with a pre-upgrade backup and automatic rollback
  on failure (restoring that backup too when the container exited during migrations).
* `backup --native`: a consistent snapshot via OpenClaw's own `backup create --verify`,
  without stopping the gateway.
* `expose`: reach a loopback-bound gateway from outside its host — an SSH tunnel, a
  tailnet-only `tailscale serve`, or a status report.
* `watch`: health monitoring with a webhook alert on state transitions; `check` also covers
  disconnected channels (`CHANNEL_UNHEALTHY`) and a filling data disk (`DISK_LOW`/
  `DISK_UNKNOWN`); `install`/`uninstall` manage a crontab entry — on an actual Windows host
  it now prints (and, with `--apply`, can run) the equivalent `schtasks /create` command
  instead of only pointing at Task Scheduler by hand.
* `backup install [--interval <30m|6h|1d>] [--apply]` / `backup uninstall [--apply]`: the
  schedule `OC_BACKUP_KEEP` presumes but nothing installed before now — mirrors `watch
  install`/`uninstall` exactly (crontab where trusted, the same Windows `schtasks` fallback),
  built on a shared scheduling module so the two commands cannot drift apart.
* `incident`: contain exposure → preserve evidence → rotate the gateway token → audit →
  collect, into a private, owner-only evidence directory.
* A security gate — upstream `security audit`/`secrets audit`, plus host-side exposure and
  secret-file-permission checks — wired into `doctor` and `accept`, with suppressions read
  from `config/security-suppressions.json`.
* `lock` pins third-party plugins and skills alongside the framework, image and recipes;
  `inspect` reports drift against them.
* `--help` grouped by operator intent (start & stop, check, change, save & move, security &
  access, integrations & recovery, low-level) instead of one flat alphabetical list.
* `backup list`: every archive in the backup directory and every `<data>.replaced-*` copy
  restore left behind, with size/date/profile, text and `--json`; marks which archive a bare
  `restore` would pick by default. `backup prune-replaced [--apply] [--keep <n>]`: deletes
  those `.replaced-*` copies, which otherwise accumulate forever — previews by default,
  takes the instance lock and refuses anything that is not exactly one of those siblings.
* `restore --dry-run`: runs the same archive selection and validation as a real restore,
  takes no lock, and reports the archive (name, size, date), whether it carries identity,
  the `<data>.replaced-<stamp>` it would move the current data to, and the ordered steps a
  real restore would run — nothing is stopped, moved, written or extracted; the same refusal
  a real restore gives when the archive is missing or fails validation.
* `list`: one line per deployment under `apps/`, across the whole checkout.
* `logs --since`/`--grep`: bounded reads and follows filtered by time and by pattern.
* Typo-aware command dispatch (did-you-mean instead of the full help), `--app` recognised
  only before the command name, and the lone deployment under `apps/` picked automatically
  when neither `--app` nor `OC_APP` names one.
* `--json` on `status`, `secrets`, `verify`, `expose status` and `recipe list` — the reads an
  agent asks before acting, structured like `inspect`/`doctor`/`plan` already are.
  `secrets --json` and `verify --json` carry names/locations/kinds only, never a credential
  value; a captured MCP call answers in JSON on all five even without the flag.
* `control-mcp` — the entry point agents use — is now listed in `./clawwright help` alongside
  `check`/`new-app`/`list`, with a one-line summary.
* `CommandArgument.valueName`: every declared option now names its value (`--tail <n>`,
  `--break-foreign-lock <hostId>`, `--since <duration|timestamp>`, …) instead of the generic
  `--name <value>` every option rendered as before; shown in `--help` and folded into the
  MCP tool description. A check fails the build if a declared option omits it.
* `check [<filter…>] [--list]`: one or more substrings narrow the suite to checks whose
  relative path contains at least one of them (`./clawwright check gate`, `npm run check --
  foundation runtime`); `--list` prints the matching paths without running them. An unknown
  flag is refused, and a filter matching nothing exits non-zero instead of silently running
  the whole suite.
* `--version`/`-v`/`version` (also `--json`): `clawwright <version>`, read from the framework's
  own `package.json` the same way `inspect`/`set build` already do. Answers with no deployment
  resolved, no `.env` read and no lock touched, in both installed and monorepo mode — where
  before it answered `unknown command`.
* `npm run check:linux [-- <filter…>]`: reproduces ci.yml's ubuntu "checks" job (install, the
  check suite, typecheck/lint) inside the official `node:24` image via Docker, from a clean
  `git ls-files` snapshot — never the host's own `node_modules/`. Refuses with the next step
  when Docker is not installed or its daemon is not answering, instead of failing unhelpfully.
* A `local` target (explicit `OC_TARGET_LOCATION=local`, or `auto` resolving to it) is now
  refused with a named error (`LOCAL_TARGET_UNSUPPORTED`) on a host that is not Linux —
  `local` only ever runs the target-side commands this framework issues, and those are
  GNU/Linux-specific. Windows and macOS were previously able to select `local` (macOS also
  via `auto`) and fail on the first target command instead; the refusal now fires before
  `createTransport()` builds anything, names the host OS and the next step
  (`OC_TARGET_LOCATION=ssh`, or on Windows also `OC_TARGET_LOCATION=wsl`). `auto` on Windows
  still resolves to `wsl`, and commands needing no target (`check`, `new-app`, `version`,
  `help`, `list`) are unaffected. See docs/guide/requirements.md for the supported host ×
  target matrix.
* `bootstrap --check`: a read-only prerequisite report for a fresh deployment — docker present
  and its daemon answering, compose v2, whether the data/backup/snapshot directories can be
  prepared without a sudo password (naming the exact `sudo install -d` line if not), whether
  the gateway port is free, free disk space, and now whether the target's own userland is GNU
  (`find -printf`, `stat -c`, `readlink -f`, `sha256sum`, `tar --numeric-owner`, `/proc`) — a
  BusyBox (Alpine without coreutils) or BSD/macOS target answers every other check and then
  fails mid-mutation on the first GNU-only flag; this catches it first and names the exact
  tool(s) missing and how to fix it (`TARGET_NOT_GNU`, `service/inspection.ts`). One
  `ok`/`WARN`/`FAIL` line per prerequisite, exit 0 only when nothing failed; no lock is taken
  and nothing is created either way.
* `--json` on `smoke`, `upgrade`, `restore`, `deploy`, `bootstrap`, `apply-config`, `push`,
  `pull`, `configure-provider`, `provision-agent` and `recover-env` — the same emit-on-stdout
  mechanism `status`/`lock`/`verify`/`rollback` already use, a minimal `{ok, changed, ...}`
  outcome per command, documented on each command's own `--json`/`--help`. `--dry-run` on
  `push` (reuses restore's own planner: what would be replaced, what the archive holds,
  whether a secrets sidecar would be installed), `rollback` (which snapshot/operation or
  previous-set artifact, whether a restart would follow), `deploy` (the same read-only
  reachability check a real deploy runs first, then what would sync and whether it would
  bootstrap — never prepares/marks the remote root, since that is itself a write),
  `recipe install`/`remove` (refusals, ports and stack state) and `backup` (the archive name,
  excludes, and whether the gateway/recipe stacks would stop). A new
  `tools/checks/completeness/flags-matrix.check.ts` pins every command's `--json`/`--dry-run`
  position (yes, or no with a one-line reason) against its live declaration.

### Changed

* Command hints (log lines, errors, `Usage:`, the `help` footer, `nextActions` in JSON and MCP
  envelopes) now name the command the way it was invoked: `./clawwright` from the monorepo gate
  (plus `--app <name>` for a non-default deployment) and from the committed shim, `clawwright` from
  the system-wide command, where `./clawwright` does not run in cmd.exe or PowerShell. The shim
  exports `CLAWWRIGHT_INVOKED_AS=./clawwright`; the entry reads and removes it, and a hand-over to
  another copy passes it on explicitly. An already committed older shim does not set it, so hints
  from the installed entry say `clawwright` until it is regenerated.
* `help`: the per-line "(destructive for some actions)" suffix is replaced by a short marker
  (`*` for some actions, `!` for always) with one legend line; the gate and built-in commands
  sit under a "Framework:" heading and share the command column; long summaries (`recipe`,
  `expose`, `incident`, `set`, `host`, `backup`, `plan`, `provision-agent`, `cli-start`) are
  shortened so no line exceeds 100 characters. `help <command>` and `--help` keep the full text.
* Internal refactor, no behavior change: `instance-mutation-guard.ts`'s `claim()` and
  `instance-lock.ts`'s `takeLockClaim()` — each ~150 lines with the same marker-cleanup line
  repeated on nearly every failure branch — are now split into small named steps (fresh vs.
  contested guard/lock, live/dead/foreign owner, stale-claim retirement, publish-with-
  rollback), with marker cleanup going through one shared helper instead of being copied at
  each throw site. The claim/lock primitives moved to a new `runtime/lock/lock-claim.ts` to
  keep `instance-lock.ts` under its line budget; `instance-lock.ts` re-exports everything it
  used to export directly.
* Internal refactor, no behavior change: the security audit, private-paths ledger and recipe
  privacy readers test `selectedDeployment()` instead of catching "no deployment selected",
  so an unrelated error from a path getter now propagates instead of reading as "nothing to
  check"; the ownership ledger's and the installed-set marker's identical candidate-file
  reader is now one shared function, and its dead `exists`/`remove` capability checks (both
  are required `Transport` members) are gone.
* `check`: each check file now runs in its own process instead of all of them sharing one,
  so a leaked global, an env mutation or a stray `process.exit()` in one file can no longer
  affect another. Runs with bounded parallelism by default (`--jobs <n>` / `OC_CHECK_JOBS` to
  control it); each file's output prints as one block, in a stable file order, once it
  completes.
* Internal refactor, no behavior change: `apply`'s `applyFromSource`/`applyWithSource`, the
  recipe portable-content walker's `collectPortableRecipeFiles`, `pull`'s `pullLocked`,
  `rollback`'s `rollbackSet`, `accept`'s `acceptFromSource`/`runCheck`, `watch check`'s
  `runWatchCycle` and `set validate`'s `validateSet` are each split into smaller, named
  private helpers.
* `new-app`/`init`/`mcp-setup` now write a small, readable `mcp-launch.mjs` launcher next to
  `app.ts` instead of embedding the same ~800-character `node -e` script twice in each of
  `.mcp.json` and `.codex/config.toml`. The launcher has no secrets or machine paths, so it is
  committed (unlike `.mcp.json`/`.codex/`, still gitignored); `mcp-setup` never overwrites a
  locally edited launcher silently — `--rewrite-launcher` is the explicit ask required.
* Internal cleanup, no behavior change: comments condensed to the invariant across the
  framework, longest blocks first.

### Fixed

* `destroy` on a deployment that was never bootstrapped no longer answers "never been
  bootstrapped — run `./clawwright bootstrap`": it reports there is nothing to destroy and exits
  0 (dry run and `--yes --confirm-name` alike), takes no lock and creates no directory. Present
  `--backups`/`--snapshots` directories are still removed; a bootstrapped deployment is unchanged.
* Docs no longer send users to an unpublished package: the npm install sections in
  `README.md`, `docs/guide/deploy-and-mcp.md` and `tools/framework/README.md` say the package is
  not on the registry until the first release and give the working path (`npm run install:system`,
  or `npm pack` + `npm install <tgz>`); the registry commands are marked "after the first release".
* `lock --check` now exits non-zero when it lists any difference or cannot read live state (the
  JSON/MCP path still emits the report, then fails), so it can gate CI. On an instance that is not
  running the plugin/skill inventory is reported as `GATEWAY_DOWN` ("not running — start it or
  bootstrap first") instead of `CLI_READ_FAILED` "batch transport failed"; a running instance whose
  read failed keeps `CLI_READ_FAILED`.
* Scheduled jobs of a system-wide (global-mode) deployment start. The `./clawwright` shim's
  no-local-package fallback runs the global package's `dist/entry/bin.js` with the node it already
  found instead of exec'ing npm's shim (which failed with `exec: node: not found` under WSL and
  cron), and the Windows Task Scheduler line records the running package's entry instead of a
  non-existent `node_modules/@phpcraftdream/clawwright/...` path.
* `init` names what is meant to be committed accurately (`./clawwright`, `mcp-launch.mjs`, `app.ts`,
  `package.json`, `config/`, `recipes/`), the `.env` header is true for both `new-app` and `init`,
  and messages that pointed at repository-relative `docs/...` paths (WSL boundary, instance lock,
  recipe cutover) now print absolute GitHub URLs from one helper (`core/io/docs-url.ts`).
* `clawwright init --local` (system-wide install: `app.ts` was unresolved in editors) prints the
  `npm install --no-save` command that gives the app its own `@phpcraftdream/clawwright` for types; init
  does not run npm. Without the flag, init hints at it.
* A command deadline now ends the command's whole process tree, not only its top process: the
  ssh watchdog used on targets without `timeout` (macOS) signals a process group (`setsid`, else
  job control, else a `ps`-walked tree), and local execution signals the command and its
  `ps`-walked descendants on POSIX (same process group, so Ctrl+C still reaches it), so an orphaned
  child no longer holds the call open. The transport contract check now
  asserts that a child of a timed-out command is gone and the call returns at the deadline, for
  local, wsl and ssh.
* Private target publication decides escalation once, on the destination directory, and uses it
  for staging, rename and cleanup alike. An operator who is the runtime owner (uid 1000) writing
  into a root-only directory used to stage through sudo and then rename and clean up without it:
  the publication failed and the staging copy of the secret stayed behind.
* The secrets preflight refuses a protected target `.env` it cannot escalate to read in terms of
  the read ("is not readable by this user and sudo …"), not as a directory that is "not writable".
* Private target publication checks destination access before staging secret bytes and uses
  noninteractive sudo when required. `push` can install snapshot keys into restored
  UID-1000 data from a different operator account without relaxing private file modes.
  Secret preflight also reads a permission-protected target environment with noninteractive
  sudo after verifying that ordinary read access is denied; unrelated read failures still
  abort.
* Restore/deploy checks use canonical macOS marker paths, gate the GNU-only local archive
  scenario on actual userland support, and handle UID-1000 restored data from a different
  Linux operator account without losing health assertions or fixture cleanup.
* The documented offsite backup hook seals operator storage and creates binary archives
  exclusively with verified private permissions before content is written, through the
  installed `private-config` public entry. Plaintext shared Windows/WSL storage is explicitly
  excluded; existing copies require separate permission auditing.
* Windows private-directory DACL grants inherit only the trusted SID set, retaining the
  owner's read/write access to existing inherited files when the directory is sealed.
* Egress redaction handles structural URL userinfo normalization, whitespace-spanning
  diagnostic authorities, nested literal credential URLs and parser-ignored query-name
  controls without changing private probe input.
* Upgrade confirms predecessor and deployment settings under the instance lock before
  backup or an execute no-op; a changed, stopped or unreadable predecessor refuses
  without recreating or pinning a stale image.
* Recipe project identity hashes a serialized gateway-namespace/recipe-name pair,
  preserving component boundaries even when either name contains `-recipe-`.
  Both predecessor naming schemes require verified explicit cutover.
* Restore/push performs recipe ownership and inventory checks before gateway stop or
  data replacement, including `--no-start` and preview; reporting reuses the confirmed
  inventory instead of introducing a late policy refusal after mutation.
* Recipe stacks use the deployment's gateway Compose namespace, including
  `OC_COMPOSE_PROJECT`, and verify existing container ownership before lifecycle or
  backup discovery. Ambiguous legacy stacks require explicit operator cutover.
* CLI and MCP preserve literal option bindings such as `logs --grep=--tail`; raw
  readers honor inline values and passthrough boundaries without weakening missing-value checks.
* Recipe readiness state probes retain the available timeout budget near the end of
  the observation window instead of failing an otherwise ready WSL/SSH stack prematurely.
* `mcp-serve` uses an explicit duplex stdio relay through safe pipes, preserving live
  client input, exact protocol stdout, separate stderr and finite-input command behavior.
* Backup/watch scheduler ownership hashes the canonical execution root instead of its
  basename, preventing same-named projects from replacing or uninstalling one another.
  Legacy cron entries migrate only when their full invocation belongs to the current root.
* Upgrade validates with the target digest's CLI and confirms gateway identity before
  pinning; exceptions after recreation begins attempt rollback and report both causes
  when compensation fails.
* `lock` preserves existing pins when plugin/skill inventory is failed or malformed;
  `--check` reports unknown inventory instead of false removal or a match.
* SSH `watch status` reads target-side scheduled history and interval metadata;
  operator-side ad-hoc cycles use separate history. Concurrent cycles serialize alert
  delivery and state publication instead of duplicating a transition alert.
* The `afterBackup` offsite example preserves binary archives through base64 transfer
  and verifies the written copy's SHA-256; transport text reads are explicitly text-only.
* Egress diagnostics redact inline URL credentials in endpoint and probe detail across
  text/JSON `inspect`, `doctor`, `plan` and MCP while preserving original probe input.
* Instance-lock heartbeats share the acquisition/release mutation guard; release drains
  in-flight refreshes before removal so an old heartbeat cannot overwrite the next holder.
* ssh target: a command that hit its `timeoutMs` left the remote process running (killing the
  local `ssh` sends the remote command no signal without a pty). The deadline is now also
  enforced on the target — by `timeout`, or by a plain-sh watchdog where it is missing (macOS) — and
  keeps working after the connection is gone.
* recipe hooks: a `#specifier` import failed with "escapes the recipe directory" when the recipe
  was reached through a symlinked path (macOS `/var` → `/private/var`), because Node reports the
  hook's own file realpath'd; the boundary is now taken in the same spelling as that file.
* `control-mcp`: `ping` answered `method not found` instead of the empty result MCP clients
  use as a keep-alive; `initialize`'s `serverInfo.version` said `"1"` instead of the framework
  version. `tools/call` used to run strictly one at a time in the read loop, so a long call
  (an `upgrade`, a `recipe install`) blocked `ping`, `tools/list` and every other call behind
  it; calls now queue instead of blocking the loop, so `ping`/`tools/list`/`initialize` stay
  responsive while one runs, and `notifications/cancelled` answers the named call immediately
  with an `isError` "cancelled" result (the command itself keeps running to completion —
  there being no clean abort — and the instance lock still protects state). `tools/call`s
  still run one at a time among themselves, since the captured-output sink they share is one
  process-global slot.
* `upgrade` with no `--image` re-resolves the pinned channel at the registry instead of
  comparing the digest pin to itself.
* The security gate tells a missing `ufw` from one that failed to answer, on every transport.
* `watch` reports an unreachable target as down (`TARGET_UNREACHABLE`); `--interval` past 59
  minutes steps whole hours instead of silently running hourly, and other values are refused.
* `watch install`/`backup install --interval`: a value like `45m` or `7h` encoded as `*/45`/
  `*/7` and fired unevenly (`45m` at :00/:45, i.e. every 45 then every 15 minutes) despite the
  code's own doc comment promising a refusal. Minutes are now accepted only if they divide 60
  (1,2,3,4,5,6,10,12,15,20,30) and hours only if they divide a day (1,2,3,4,6,8,12,24; 24h/1d
  is daily); anything else is refused, naming the nearest valid values. `schtasksSchedule()`
  (the Windows counterpart) validates through the same rule.
* `watch` failures were invisible between cycles (`watch install`'s crontab entry discards
  all output): a failed alert delivery or a configuration error is now recorded
  (`lastRunAt`/`lastError`/`alertPending`) and surfaced by `watch status`, which also warns
  when the last run looks stale; the new `watch test` action sends a one-off test alert and
  heartbeat ping so delivery can be proven before a real outage is the first time it matters.
* `watch check` alerted only when the level itself changed: a new problem joining, or an
  existing one clearing, at an unchanged level — `degraded`(`CHANNEL_UNHEALTHY`) →
  `degraded`(`CHANNEL_UNHEALTHY`, `DISK_LOW`) — sent nothing. Now the reason-code SET moving
  alerts too (a reason's own detail text changing alone still does not), the alert payload and
  chat text name which codes appeared/cleared, and an undelivered codes-only change retries
  the same way a level transition's own failure already did.
* `OC_BACKUP_KEEP`/`OC_SNAPSHOT_KEEP`: a non-numeric or negative value (`ten`, an empty
  string, `-3`, `10x`) silently disabled rotation; it now warns and falls back to 10, and `0`
  is an explicit, reported "never rotate".
* Native backup no longer leaves its own full archive inside the live data directory.
* `bootstrap` pins a freshly pulled tagged image to the digest it just proved, without
  moving the shared tag.
* A root-privilege probe that never ran is no longer read as "needs a password".
* `incident` preserves the running container's log tail and `docker inspect` before rotating
  the token, and contains only this gateway's own `tailscale serve` route.
* `plan` names a step for every problem code — a never-bootstrapped deployment first,
  pointing at `bootstrap` — instead of printing "nothing to do" for the 19 of 36 codes it
  had no step for.
* On a deployment that has never been bootstrapped, `backup`, `incident`,
  `configure-provider`, `smoke`, `apply-config` (including `--dry-run`/`--dump`), `up`,
  `restart`, `down`, `logs`, `upgrade`, `secrets --apply`, `provision-agent`,
  `expose tailscale --apply` and `watch install --apply` died on a raw
  `could not take the instance lock … mkdir …/operation.lock: No such file or directory`
  instead of the same "never been bootstrapped — run `./clawwright bootstrap`" answer
  `doctor`/`plan`/`status`/`mcp-creds` already gave. A shared `requireBootstrapped()` now
  refuses first, before the lock or any target write; `bootstrap`, `restore` and `push`
  (the commands that create the instance) are unaffected.
* A failed target command built as `sh -c <script>` (the internal publish/private-write
  staging writes) pasted its whole multi-statement body into the operator-facing error —
  seen from `apply-config --dry-run` as the entire script instead of a reason. The headline
  now collapses to `sh -c …`; the real cause (stderr) still follows it, and `OC_DEBUG=1`
  still shows the untouched command.
* `--break-foreign-lock <hostId>` is accepted everywhere `--break-lock` is — `apply`,
  `rollback`, `provision-agent`, `set forget`, `restore`, `pull`, `recipe install`/`remove`,
  `apply-config` refused it as unknown — and by `secrets --apply`, which still refuses
  `--break-lock`. `push` validates its arguments before taking the lock, so a bad flag can
  no longer follow a takeover. The refusal for a guard owned by another machine names the
  flag, the host id and the runbook.
* `restore` with no `<archive>` now names which one it picked, with its date, before any
  confirmation or action — previously only visible from the log of a restore already running.
* `expose tailscale`/`expose status` and `recipe` (every action) reject an undeclared flag or
  an extra positional instead of silently accepting it; `recipe list --bogus extra` and
  `recipe <action> <name> <stray>` are now refused, naming which flags the action actually
  takes. `logs` is parsed against its own declaration too, so a stray token (`./clawwright logs
  extra`) is refused instead of reaching `docker compose logs` as another service name —
  only the validated `--since` still travels to the runtime.
* An unknown `--flag` close to one the command declares now says "did you mean --<name>";
  every unknown-argument refusal from the CLI also points at `<command> --help`.
* Gate command help (`check`/`new-app`/`list`/`init`) rendered from a copy of `--help`'s own
  renderer that dropped `choices` — a gate command's accepted values now show there too.
  `entry/cli.ts` and `integration/gate.ts` share one renderer (`core/io/help-render.ts`).
* `rollback --set` — a boolean flag reinstalling the previously installed set — collided with
  `plan`/`apply`/`accept`'s `--set <artifact>` option of the same name (one string, two types,
  under one MCP schema property). Renamed to `rollback --previous-set`.
* The general help's `--app <name>` line now says it belongs before the command, matching the
  refusal already given for one placed after it.
* `docs/guide/commands.md`'s command table was missing `set` and `exec`.
* `apply --dry-run` counted every action, advisory included, as "would run" and printed the
  literal `(you)` with no text for an advisory step — disagreeing with `plan`'s report of the
  very same deployment. Both now share one renderer (`printPlanActions`), so the executable
  count and each step's own text can never diverge between the two commands again.
* `details` paragraphs running to a thousand-plus characters on one line (`watch`, `incident`,
  `recipe`, `backup`, and others) are now split by phase/action/concept — the same wall of
  text either printed whole on a terminal or became an entire MCP tool description. A check
  fails the build past a 400-character single line.
* `deploy --path` defaulted to a hardcoded `/opt/openclaw` instead of `OC_REMOTE_PATH`, so a
  deployment with `OC_REMOTE_PATH` set elsewhere mirrored to the wrong directory while `watch
  install` (which reads `OC_REMOTE_PATH`) scheduled the cron entry for the one actually
  configured. The default is now `OC_REMOTE_PATH`; an explicit `--path` that still diverges
  from it is accepted but named in deploy's own closing output.
* A `check` run killed mid-flight left its scratch deployment under `apps/`, where `list`
  saw it. `check` now sweeps orphaned `apps/*-check-<hex>` directories older than 30 minutes
  at the start of every run.
* An exported `OC_*` (`OC_WSL_DISTRO`, `OC_SSH_HOST`, …) was silently ignored — only `OC_APP`
  is read from the shell, `.env` is the sole source for the rest. Now one stderr line per run
  names every such variable that disagrees with `.env` or is missing from it (never `--json`
  stdout, so `control-mcp`'s stdio framing is unaffected); values are never printed, only names.
* `new-app a b` created `a` and silently dropped `b`; it now parses through the same shared
  declaration parser every other command does, so a stray extra positional is refused.
* `help help` answered "unknown command: help / did you mean: help"; it now prints the
  general command list.
* With several deployments under `apps/` and none selected, commands led with
  `deployment "openclaw" not found`; they now say "several deployments (a, b) — pick one
  with --app <name> or OC_APP".
* `watch`/`set`/`recipe`/`expose`'s own "unknown action" refusal now carries a did-you-mean
  guess and a `<command> --help` pointer, the same as an unknown command or flag already did.
  Their bare-usage errors (no action at all) now also point at `--help`.
* `new-app`'s `.gitignore` now excludes `state/` (machine-local `watch.json`) and `sets/`
  (built artifacts); `config/`, `recipes/` and `deployment.lock.json` stay trackable.
* `control-mcp`'s `tools/list` carried every tool's whole `--help` text as its `description` —
  88 KB across 42 tools, roughly 22k tokens of context before an agent's first real call.
  Each description is now the command's one-line summary plus a pointer to the new `help`
  tool (input: `command`, optional), which returns exactly what `./clawwright help <command>`
  prints — or the command list when called without one. A check keeps `tools/list` under a
  byte budget and every description under 400 characters.
* `tools/list`'s `inputSchema` still carried every argument's full `--help` description —
  100-300 characters each, most of it detail `help <command>` already gives whole. Each
  argument description in the schema is now cut to its first sentence or clause (parenthetical
  asides dropped, ≤60 characters), and omitted entirely when it only restated the argument's
  own name; `help <command>` and `--help` are unaffected. `tools/list` is down from ~40 KB to
  ~37 KB; the check's byte budget is lowered from 46 KB to 38 KB (30 KB was tried and found
  unreachable without cutting an argument description below the point of still saying
  anything).
* A command's captured output was decoded per ~64 KB pipe chunk, corrupting multibyte
  characters split across a boundary into U+FFFD (logs, `config get`, large `--json`). It is
  now decoded as one continuing UTF-8 stream.
* `TARGET_UNREACHABLE` (before: only `watch`) now also covers `doctor`, `inspect`, `plan`,
  `status` and `backup list`. A wrong `OC_WSL_DISTRO`, a stopped WSL or an ssh that never
  connects used to end in `could not check whether … exists (exit 4294967295):` with nothing
  after the colon (wsl.exe's own errors are UTF-16LE); it is now one blocking, readable finding
  naming the variable to check and how to test the connection, and exit codes print signed.
* `init`'s `.env` template, `.gitignore` block and port selection were a separate copy of
  `new-app`'s, and had drifted: `state/` and `sets/` (machine-local watch state and built set
  archives) were excluded only by `new-app`, so an installed deployment committed them; a
  repo whose `.gitignore` already carried an older block never received lines added since;
  and `init` picked its port at random instead of avoiding one a sibling deployment already
  claimed. `init` now shares `new-app`'s template: `.gitignore` updates add whichever lines
  are missing one at a time (so an old block catches up instead of being skipped forever, and
  the operator's own lines are never touched), and the port avoids every sibling deployment
  directory's own `.env`, the same way `new-app` already did for `apps/`.
* `.env` parsing only understood a whole-line `#` comment and stripped edge quotes —
  `.env.example` reads as dotenv, so an operator writing `OPENCLAW_GATEWAY_PORT=18789  # my
  port` or `export FOO=bar` got a port with the comment stuck to it, or a key literally named
  `export FOO`, silently. Now: a leading `export ` is stripped, and whitespace before `#` in
  an UNQUOTED value starts an inline comment (quoted values keep `#` literal, no interpolation
  added). `serializeEnvLine` quotes a value containing ` #` so it survives the next read;
  `inspect`/`doctor` report `ENV_LINE_INVALID` for a line whose key is not a usable variable
  name. The accepted format is documented in docs/guide/deploy-and-mcp.md.
* `recipes/` existing but unreadable (a file where a directory belongs, a permissions error)
  used to read as an empty catalog: `recipe list` said "no recipes yet", `lock` wrote
  `recipes (none)`, and `accept` said nothing declares acceptance, while `inspect`/`plan`
  already refused with a named error. Every enumeration of `recipes/` now goes through one
  shared reader (`listRecipeDirectories`) that turns ENOENT into "no recipes" and any other
  error into a refusal naming the path and errno — `recipe list`, `lock`, `accept`, `deploy`
  and set build now fail the same way `inspect`/`plan` always did.
* `new-app`/`init` ended with "check `.env` — data directory, port, image" and never said the
  default data directory lands under `/srv` and typically needs `sudo install -d` on a fresh
  host — that fact lived only in README's troubleshooting table. The final output now names
  the actual data directory the `.env` it just wrote chose, and when it is under `/srv` points
  at `./clawwright bootstrap --check` as the next step, before `bootstrap` itself.
* The instance lock judged staleness from when it was taken, never refreshed while the holder
  stayed alive — so `recipe install`, which holds the lock across a whole build, could outlive
  the 30-minute threshold and get refused with "longer than any operation should take … may be
  left over from a run that died", pointing at `--break-lock` for a run that was still working.
  The holder now rewrites a `heartbeatAt` field every 30 seconds for as long as it holds the
  lock, and staleness is judged from that once a record has one (10 minutes of silence; a
  record from before this field existed keeps the old 30-minutes-since-taken rule). The refusal
  now states the facts instead — who holds it, since when, and "not refreshed for N minutes" or
  "refreshed N seconds ago — the operation is still running" — and only ever suggests
  `--break-lock` once the holder is actually stale or provably dead. `configure-provider` was
  also the one lock-taking command with no `--break-lock` of its own and a refusal pointing at
  a different command to break it; it now declares and threads `--break-lock`/
  `--break-foreign-lock` like every other ordinary lock-taking command.
* `control-mcp`'s `tools/list` shrank from ~37.2 KB toward its 30 KB target (now ~30.4 KB):
  the structured-command `outputSchema` (identical on every one of them) now declares types
  and required fields only, not a ~90-byte prose description repeated per field per tool —
  that meaning now lives in `help <command>`'s own output for a structured command instead,
  reachable the same way any other detail `tools/list` shortens already is; each tool's
  description also points at `help` in fewer words. `mcp-mirror.check.ts`'s byte budget drops
  from 38 KB to 32 KB (just above the ~31 KB now reached) and gained checks that every
  structured tool still declares the documented generic envelope and that its field meanings
  are still reachable through `help`.
* README's Quick start named a fixed `http://127.0.0.1:18789` web interface; `new-app` writes
  `OPENCLAW_GATEWAY_PORT` from 20000-32767, so following it opened the wrong address on
  anything but the default. It now points at `./clawwright status`/`mcp-creds` for the real
  port, and gains a note that `bootstrap --check` names the exact `sudo install -d` line on a
  fresh, root-owned `/srv`.
* `new-app`/`init` printed the Windows-ACL/WSL-boundary warning — two ~700-character lines —
  before their own "created … next:" block, burying the useful part under it. It now prints
  after, as one line pointing at a new subsection in docs/guide/requirements.md with the full
  explanation; every other caller (`bootstrap` included) is unchanged.
* `bootstrap --check` and an invalid `bootstrap <flag>` created `.env` and a gateway token —
  the framework prepared the environment for every `preparesEnvironment` command before its
  own argv was parsed, so neither the `--check` branch nor an "unknown argument" refusal
  could stop it. `preparesEnvironmentFor()` now gates preparation on the same predicate that
  already marks a call read-only (`readOnlyWhen`) and on the argv the command's own parser
  would accept, checked before `ensureEnvironment()` runs, on both the console and MCP paths.
* The gateway token was read and written with regexes that did not understand `export` or
  spacing round `=` — the same dotenv basics `parseEnv` learned earlier. An
  `export OPENCLAW_GATEWAY_TOKEN=…` line was invisible to `bootstrap`'s `ensureToken`, which
  then appended a second, bare line; since `parseEnv` reads the last line for a duplicate key,
  the next command silently ran on a different token than the one already handed out.
  `incident rotate` had the same blind spot. `core/env.ts` gained `readEnvValue`/
  `upsertEnvLine`, used now by `ensureToken`, `incident rotate` and `upsertEnvValue`.
* `recipe import` dropped credential-shaped names (`.env.example` included) without saying so.
  It now copies through the same walk
  (`collectPortableRecipeFiles`) set build and the provision-agent mirror use, so symlink
  resolution and containment agree across every carrier, and import refuses a source whose
  link escapes it the same way they do. Import now prints `skipped: N file(s) — <path>
  (<reason>), …` when anything is excluded, and warns that `prepare.ts`/`verify.ts`/
  `onboard.ts` run on this machine with the operator's rights during `bootstrap`/`up`/`recipe
  verify`.
* `parseDeclaredArgs` (every command's argv parser): a value option swallowed the next
  token even when it was itself a declared flag/option of the same command (`logs --grep
  --json` took `"--json"` as the pattern) — it now dies as `--grep needs a value` instead;
  a value that legitimately starts with `-` still works via `--grep=-x`. A value option
  given twice (`--tail 5 --tail 6`) silently kept the last one — now refused as `--tail
  given more than once`. `--json=false`/`--json=x` on a flag reported `unknown argument`
  instead of naming the real mistake — now `--json is a flag and takes no value`. A bare
  `--` reported `unknown argument: --`; it now ends option parsing the way `host`'s own
  hand-rolled parser already did, so everything after it is positional. `backup list
  --keep 3` reported `--keep` as wholly unknown even though it is declared, just not for
  `list` — `CommandArgument` gained an optional `actions` field so a multi-action
  command's own argument can say which action(s) it belongs to; the refusal now reads
  `--keep applies to \`prune-replaced\`, not \`list\``, and `backup --help`/its MCP
  description group `--keep`/`--interval`/`--apply` by the action(s) they apply to.
* `host`/`cli`/`exec`: a non-zero exit from the wrapped command always became the generic
  process exit 1 ("failed (exit N)" was only the text, never the actual status), so a script
  branching on `$?` could not tell `false` from `exit 7`. The CLI process now exits with that
  command's own code (`CommandFailedError`, clamped to 1..255 — a signal-derived negative or
  an out-of-range value can no longer read as success); the text is unchanged, and over MCP it
  still carries the exit code in the `isError` result's text.
* `./clawwright cli --help` went to the container instead of printing this framework's own help
  (`passesThroughHelp`), which meant a fresh, never-bootstrapped deployment answered "never
  been bootstrapped" instead of a help screen — `exec --help` and `help cli` were unaffected.
  `cli --help` now behaves like every other command; put `--help` after a bare `--`
  (`./clawwright cli -- --help`) to reach OpenClaw's own instead — the same before-the-first-`--`
  boundary `host`'s own parser already drew (`requestsHelp`, `entry/cli.ts`).
* `mcp-creds` printed the gateway URL and token, then failed with "never been bootstrapped" —
  the secret was already on the screen by the time the command gave up. It now runs the same
  bootstrap check every other guarded command does before printing anything.

### Internal

* `commands/lifecycle/lifecycle.ts` (700 lines, at the per-file limit) is split by command into
  `commands/lifecycle/instance/`: `control.ts` (up/restart/down), `logs.ts`, `destroy.ts`,
  `upgrade.ts` (each 78-330 lines). No behaviour change; public exports unaffected.
* MCP `tools/list` budget headroom: 80 bytes to about 1.6 KB free (32688 to 31166 of 32768)
  without raising the budget. Shorter shared argument descriptions (`break-lock`,
  `break-foreign-lock`, `confirm`), an empty `required` is not sent, and shorter command
  summaries; the full text stays reachable through the `help` tool and `./clawwright help <command>`.
* checks: new `gnu-userland` capability (GNU-compatible `mkdir`/`mv` and GNU `tar` on this
  process's PATH). Checks that drive the local transport skip on macOS and on a Windows runner
  without them, instead of failing on BSD `tar`/`mv` or a missing `mkdir`; the Linux CI job
  requires it. The nine "real POSIX filesystem" checks no longer treat every non-Windows host as Linux.
* Comments condensed to the invariant; imports of one style per file.
* `docs/internal/README.md`: an index of the review, session-task, plan and audit documents,
  grouped by series, newest first, with status notes.
* `sudoFor` and `sudoForRead` share one sudo-availability answer (absent / asks for a password /
  usable), probed once per context, so a sudo-escalated private publication no longer spawns the
  `command -v sudo` / `sudo -n true` probes twice (each a `wsl.exe` spawn on WSL). Transport
  failures still throw and are never cached. Refusal messages are unchanged.
* checks: `runProcess` in `tools/checks/kit/spawn.ts` is the one child-process helper (cwd, env,
  stdin input or an open pipe, timeout with SIGKILL and `timedOut`, stdout/stderr apart and
  interleaved, Windows `.cmd` through a shell). The per-file spawn helpers in nine check files use
  it; `system-install.check.ts` picks the control MCP entry by `CLAWWRIGHT_CONTROL_MCP_NAME`, not by
  position.
* checks: the nine check files at 675-700 lines (`runtime-image-identity`, `watch/check`,
  `backup`, `recipe-hook-freshness`, `checkout-policy`, `inspect/drift`, `set-build`, `state`,
  `apply`) are split along their scenario seams into files of 100-375 lines, most of them in a
  new subdirectory named after the subject (shared stubs in a sibling `fixture.ts` /
  `mutation-guard.ts`). No assertion added, removed or weakened; each part keeps its own
  `check:exclusive` marker where it needs one.

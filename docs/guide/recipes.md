# Recipes: things that live beside the instance

See the [recipe.json reference](recipe-manifest.md) for all manifest fields, validation rules and hook contracts.

A recipe is a third-party application deployed alongside: a `recipes/<name>/` directory. It
comes in two flavours, and a recipe may be either or both.

**A service**: `recipe.json`, `compose.yml` and a multi-stage `Dockerfile`.

```bash
./clawwright recipe list
./clawwright recipe import <source> [new-name]
./clawwright recipe new <name> [--with-hooks]
./clawwright recipe install <name>
./clawwright recipe status <name>
./clawwright recipe verify <name>
./clawwright recipe run <name> <recipe-action> [<key>=<value> ...] [--dry-run]
./clawwright recipe onboard <name>
./clawwright recipe remove <name> [--volumes]
./clawwright recipe inspect <name> [--json]
./clawwright recipe pin <name> --version <v> [--apply]
./clawwright recipe trial <name> [--dry-run]
./clawwright recipe check <name> [--dry-run]
./clawwright recipe retire-legacy <name> [--apply]
```

Every recipe is its **own compose project**, not a service in our file. That is why
`up`/`down`/`status` keep dealing with the gateway alone, a broken recipe cannot drag it
down, and state snapshots never pick up a recipe's images or volumes.

The project is `clawwright-recipe-<sha256>`, derived from the validated gateway namespace
and the validated recipe name — all lifecycle commands, diagnostics and backup discovery
use the same builder, even when a recipe manifest is broken. To get the exact project and
its ownership evidence, run `./clawwright recipe inspect <name> --json` and review the
reported namespaces and containers.

Every mutating recipe action runs under the instance lock. `install` and `remove` change the
target, and `verify`, `onboard` and `diagnose` run the recipe's own hooks with a full context,
so the framework cannot know what they touch; `install` holds the lock across the whole
build, and until it is done other mutating operations are refused with `recipe install
<name>` named as the holder. `recipe migrate` holds that same lock across its executor. `list`, `status`, `logs` and
`inspect` take no lock, nor do install/remove/recover/migrate previews. Neither does
`import` or `new` — both write only the repository's recipes/ directory and never touch the
instance. An operation that already holds the lock runs recipe actions as its own steps
instead of refusing itself.

`recipe new <name>` scaffolds `recipes/<name>/` with the smallest valid manifest — a
`recipe.json` carrying only `description`, and a `compose.yml` skeleton (one placeholder
service, `restart: unless-stopped` already set) — no hooks by default. Refuses an existing
directory, the same way `import` does, and validates `<name>` with the same rules every
other recipe name follows. `--with-hooks` also writes commented `prepare.ts`/`verify.ts`
stubs using the `@phpcraftdream/clawwright/private-config` helpers shown below, ready to
uncomment, with a one-line reminder that hooks run with the operator's own rights.

A recipe can sit in the repository switched off — `"enabled": false` in `recipe.json`.
`install` then refuses and points at `--force-disabled`.

## Writing a recipe

Builds are multi-stage: cloning and compilation happen in the build stage, so neither git
nor toolchains reach the host or the final image. Everything is built **on the target**, so
a first install on a server takes as long as the build.

An app-owned recipe may also contain `prepare.ts`, `verify.ts` and `onboard.ts`. The framework
runs these hooks around the service lifecycle and exposes `recipe verify`/`recipe onboard` over
MCP, while each hook owns its domain-specific config and checks. Hooks are plain ESM TypeScript
executed from their real path in the recipe directory: relative imports resolve inside the
recipe and refresh on edit — the whole local import graph is checksummed, so editing any helper
takes effect on the next call of a long-lived MCP session — while bare imports resolve against the
recipe's own `node_modules` and `import.meta.url` and neighbouring files keep pointing at the
real recipe directory. Only package-internal (`#specifier`) imports are validated to stay
inside the recipe directory; a plain relative import is resolved, checksummed and re-stamped,
not containment-checked — hooks already run with the operator's full rights, so reading what
they import is the real boundary. Use the public
`@phpcraftdream/clawwright/private-config` helpers for generated credentials, atomic owner-only files,
env updates and checksums; the framework never prints the values. The specifier works in both
kinds of deployment: an installed one resolves it from the framework package, a checkout
deployment (`./clawwright new-app`) resolves it against the checkout's own framework sources. A secret is never a
command-line argument — use `execWithSecrets` (or the private-file helpers) instead of putting
a credential in `args`.
`execWithSecrets` creates the temporary target directory and file with owner-only access:
POSIX targets use modes 700/600, and local Windows targets use a sealed ACL. A Windows
drive mounted into WSL has a separate Linux access boundary, which the framework reports.

Gateway-dependent OpenClaw commands must use the gateway-sharing CLI service, for example
`runtime.runOneOff("cli", ["channels", "status", "--probe", "--json"],
{ profile: "cli", noDeps: true, input: "", allowFailure: true })`.
A separate one-off `gateway` container has its own loopback and cannot use `127.0.0.1`
to reach the running gateway. Capture child output with `input: ""`; return sanitized
facts rather than streaming account identities, credentials or raw diagnostics.

What `recipe install` waits for before calling `afterStart` and reporting success is also
declared in `recipe.json`, under `readiness`:

```json
{ "readiness": { "services": ["app", "worker"], "timeoutMs": 60000 } }
```

`services` names the compose services that must all be running — and healthy, where the
service declares a healthcheck — before install proceeds; `timeoutMs` bounds the wait, two
minutes when a recipe declares readiness without it. A recipe that declares nothing still
gets a check: every service compose reports for the project, stopped containers included,
against a five-second window — enough to catch one that starts and exits at once, with no
name to hold a slower starter to.

The wait is not one poll, and neither case reports success on a lucky instant. The first
fully ready answer only starts a five-second observation window in which every required
service must stay ready — the required set is frozen at that answer, so a container that
crashes inside the window fails install by name. If the deadline passes first, install
fails instead of proceeding: it names what never came up (`missing` / `not running` /
`not healthy`, with the service names), leaves the stack in place, points at `recipe
diagnose`, and skips `afterStart` — a hook never runs against a stack that is not actually
up. A malformed declaration (an empty service list, a non-positive `timeoutMs`) is refused
when the manifest loads, not discovered at install time.

The observation window's end is the earliest acceptance time, not a shorter deadline
for a state query already in progress. That query can finish after the window while
the readiness timeout still has budget; it must return a ready verdict before install
can succeed. Slow WSL/SSH queries do not fail merely because they began near the window's end.

Declare consumer endpoint ownership explicitly in `recipe.json`:

```json
{
  "consumerEndpoints": [
    { "configPath": "channels.telegram.proxy", "service": "http-bridge" }
  ]
}
```

Each entry has exactly `configPath` and `service`: a safe dotted configuration path and
an exact Compose service name. There is no URL, protocol, port or probe field. Paths must
be unique within the manifest and across recipe owners; malformed declarations or ambiguous
ownership refuse. An absent declaration means no endpoint ownership; published `ports`
never infer it. This declaration identifies ownership, not reachability or successful
Telegram polling.

A migrating recipe may also declare disposable container paths under `ephemeralPaths`:
writable-layer diff entries at a declared path (or under it) are ignored when the executor
inspects the container's writable layer, instead of refusing the migration. The declaration
is the author's guarantee that everything ignored there is scratch data the application can
safely lose and recreate — never credentials, databases or required history — and a
declaration equal to or above a declared mount destination refuses migration. See
[Existing-stack cutover](#existing-stack-cutover) and the
[executor notes](../internal/recipe-migration-executor.md#writable-layer-inspection-and-ephemeralpaths)
for the matching and refusal rules.

### Reconcile helpers (`@phpcraftdream/clawwright/recipe-kit`)

For converging an owned path onto a desired set of members, the recipe-kit `reconcile`
module exposes four helpers (worked example in the
[cookbook](recipes-cookbook.md#reconcile-an-owned-set)):

- `reconcilePlanView(plan, options?)` — read-only redacted view of a plan: entry keys
  pseudonymized (or stable `#<index>` markers without a pseudonym context), values reduced
  to short fingerprints, plus the numeric summary. It leaks no raw key or value, so it is
  the right shape for reporting, logging and dry-run output. The raw full-fidelity planner
  is internal: it is not exported from the entry, and a hook gets its plan from
  `reconcileApply`'s guarded flow.
- `reconcileApply(source, options)` — guards ownership, protected segments and removal
  bounds, then applies the desired set as one batch patch with a durable journal intent
  before and a result after; dry-run plans and reports without writing.
- `appConfigAccessor(ctx, path)` — default accessor behind `reconcileApply`: reads through
  `config get <path> --json`, writes through `appConfigPatch`; supply a fake in checks. When
  the read contains a registered secret, `appCli` masks it and reports `redacted: true`; the
  accessor then refuses (`guard`) before anything is written, because patching the masked
  projection would overwrite the real value. Use an accessor that reads full-fidelity data
  for a projection that holds secrets.
- `reconcilePendingIntents(journal)` — reports pending journal intents (the crash gap); a
  precomputed plan is refused while any exist, forcing a fresh computation.

Removals are bounded by `RECONCILE_MAX_REMOVED_COUNT` (100) and
`RECONCILE_MAX_REMOVED_FRACTION` (0.5); the bounds are not caller-raisable —
`maxRemovedCount`/`maxRemovedFraction` only lower them — and only the exported
`RECONCILE_LARGE_REMOVAL_CONSENT` symbol lifts the defaults. Protected segments
(`owners`, `approvers`, `credentials`, extended by `protectedPaths` — extend only, never
shrink) are enforced across plan keys and the nested keys of added/changed values. Keys present without recorded provenance surface as overlap — adopted
only with `adoptOverlaps: true`, which keeps their current values and records provenance,
never overwrites.

### Recipe actions

A recipe can declare operator-facing actions in `recipe.json`, each backed by a file inside
the recipe directory. `recipe inspect <name>` lists the declared actions with their effects
and arguments; `recipe run <name> <recipe-action> [<key>=<value> ...] [--dry-run]` executes
one. An action is a hook like any other: plain TypeScript, run with the operator's rights,
reviewed like the rest of the recipe's code. Worked patterns are in the
[recipe cookbook](recipes-cookbook.md#run-a-one-off-action-against-a-running-recipe).

```json
{
  "actions": {
    "rotate-token": {
      "file": "actions/rotate-token.ts",
      "effect": "change",
      "description": "Rotate the sidecar's API token and reload it",
      "arguments": [
        { "name": "graceSeconds", "kind": "integer" },
        { "name": "mode", "kind": "choice", "choices": ["hot", "cold"], "optional": true }
      ]
    }
  }
}
```

At most 16 actions; names are lowercase kebab of at most 40 characters. Each entry has
exactly `file` (a relative `.ts` path that stays inside the recipe directory), `effect` and
`arguments`, plus an optional `description`. The hook file must export `run` (or default),
called as `run(ctx, recipe, input)` with `input = { action, args, dryRun }`.

The `effect` is read from the manifest **before** the MCP confirmation decision, and no hook
code is imported to determine it. `change` and `destroy` both require `confirm: true` over
MCP; `read` does not. `--dry-run` is treated as a read: no lock, no confirmation, and the
flag is passed to the hook as `input.dryRun`. **Trust boundary: the hook must return its
plan without writes — the framework cannot enforce that.** Review the code before trusting
a dry run the same way you review any hook.

Locking follows the effect: `change` and `destroy` take the instance lock **before the hook
module is imported**, so a hung or hostile top-level import cannot slip past a lock another
operation holds; `read` never locks.

Arguments travel as `key=value` tokens and are validated in the prepare stage against the
selected declaration, before any hook module is loaded. Kinds are `text`, `integer`
(strict base-10), `choice` (value must be one of `choices`) and `flag` (`true`/`false`,
boolean in `args`). A missing required argument, unknown key, duplicate key, wrong kind or
out-of-choices value is an argument refusal naming the argument.

The result may be any JSON-serializable value, bounded at 64 KiB after
`JSON.stringify` and secret-redacted (registered secrets masked in strings and keys);
`undefined` becomes `{ "ok": true }`. A thrown error is a refusal whose message is
secret-redacted. Keep payloads safe to share — a result is printed, not stored.

```ts
// recipes/status-board/actions/announce.ts
export async function run(ctx, recipe, input) {
  if (input.dryRun) return { wouldAnnounce: input.args.message }; // plan only — no writes
  // ... perform the announcement with ctx.settings / runtime access ...
  return { announced: input.args.message };
}
```

```bash
./clawwright recipe run status-board announce message="deploy finished" --dry-run
```

### Config path ownership (`owns`)

Beyond consumer endpoints, a recipe can declare application-config path ownership in
`recipe.json`:

```json
{
  "owns": [
    { "path": "plugins.statusBoard", "mode": "value", "prefix": true },
    { "path": "channels.telegram.allowedSenders", "mode": "list-member" }
  ]
}
```

Each entry has a safe dotted configuration path (the same grammar as
`consumerEndpoints[].configPath`) and a `mode`: `"value"` means the recipe may set the
value at that path; `"list-member"` means the path is a list and the recipe may add or
remove members it created, never reorder the list or touch members it did not create.
Durable provenance for list members arrives with a later reconcile primitive. With
`prefix: true` (the default is `false`) the entry covers the path and everything below
it, segment-wise: `a` covers `a.b` but never `a.bc`. A `list-member` entry cannot be a
prefix.

Paths must be unique within a manifest, and the ownership catalog — built over all
recipes, disabled ones included — refuses two owners of one path, an exact path under
another recipe's prefix, and two prefixes where one covers the other; the refusal names
both recipes. Malformed declarations refuse loading, exactly like consumerEndpoints.
Each declared `consumerEndpoints` entry is itself a value-mode owned path, so endpoints
and `owns` share one catalog.

A desired-state declaration may not touch an owned path: an exact match, a path under an
owned prefix, or an ancestor of one is refused, because applying it would overwrite the
owned subtree. `config apply` dies before staging; `config inspect` reports the conflict
as a `SET_RECIPE_INVALID` problem and lists owned paths as `ownedConfigPaths` in its
`--json` output. `config apply` never writes owned paths and never reports them as
drift.

An emergency change to a running container is not a complete recipe repair. Identify the
owner of the fault and update its reproducible source: `compose.yml`/`Dockerfile` for
runtime dependencies and mounts, `prepare.ts` for generated configuration, `recipe.json`
for required services/readiness, and `verify.ts` for the consumer-visible check. Preserve
existing credentials and application state; a repair must not silently regenerate them or
overwrite live data. A Docker/host fault is not automatically a recipe-code defect, but the
recipe should detect an unavailable dependency and must not report it as ready.

Declare every service required by the consumer, including protocol bridges, in readiness.
A listening socket alone does not prove usable egress. Verification must check command
success, the expected protocol/status and application result, not accept any positive HTTP
code. Distinguish dependency reachability, API authentication and active channel processing.
For a proxy serving Telegram, a successful `getMe` is insufficient while polling is stopped;
verification should report that channel state as a separate failed or unverified condition.
If Telegram is optional for the recipe, report it separately rather than silently converting
an unavailable check into a ready verdict.

Reconcile the consumer after its dependency is ready through the supported lifecycle hook,
with disruptive effects disclosed. Then verify from the gateway and, with permission, send
an end-to-end message and observe the reply. Do not send messages or claim a working reply
without that check. Exercise the repaired recipe's install/verification path on an isolated
fixture or through an approved live run; a manual repair alone does not prove that the next
install or recovery reproduces it.

Keep an explicit distinction between recovered service, durable recipe fix and framework
tool gap. When the supported lifecycle is blocked by migration or a lock, record the blocker
and the approved temporary recovery instead of claiming the recipe has been fully repaired.


## Private files: `privatePaths` and `privateFiles`

A recipe that generates credentials declares — in the same `recipe.json` — where they live.
Two fields, two different coordinate systems, stated here twice because swapping them fails
silently:

```json
{
  "description": "a sidecar service that keeps its own API token",
  "ports": [{ "host": 8081, "container": 8080, "description": "sidecar API" }],
  "variables": { "SIDECAR_URL": "where the gateway reaches the sidecar" },
  "privatePaths": ["sidecar-credentials"],
  "privateFiles": ["local-secrets.env"]
}
```

**`privatePaths` is data-relative.** Each entry is a path from the data directory root on the
target — `sidecar-credentials` means `<dataDir>/sidecar-credentials` — and describes where the
recipe keeps generated credentials at runtime. One declaration, three readers: `backup` and
`pull` exclude these paths from `migrate` and `share` archives (`full` keeps them — it is
credential-complete by design, so restoring one restores the sidecar's working state), `verify`
refuses an archive that already carries them, and the private-file helpers refuse a private
write anywhere else. The write gate is pooled: a write is covered when *any* installed recipe
declares the path (or a parent of it), not only the recipe doing the writing.

Entries are literal, and they are validated when the manifest is loaded — a sloppy entry is
rejected at load instead of silently excluding nothing:

* non-empty, relative to the data directory, `/`-separated: `""`, `/absolute` and
  `trailing/` are all refused;
* no `.` or `..` segments — the declaration cannot climb or pad;
* glob punctuation is not special: a declaration `vault[1]` is the literal directory
  `vault[1]`, the archive exclusion escapes it for tar, and the undeclared sibling `vault1`
  keeps travelling — nobody's declaration excludes more than it names;
* the write gate judges the *normalized* path, by segments: a hook writing
  `<data>/sidecar-credentials/../escape.env` is refused even though the string carries a
  declared prefix, and `//` and `.` fold away before the comparison.

The `@phpcraftdream/clawwright/private-config` helpers enforce the same declaration from the
writing side: `ensurePrivateTargetDirectory` and `replacePrivateTargetFile` only proceed inside
a declared path, files land mode 600 and directories 700, and a symlink between the data
directory and the declared root is refused (the data root itself may be a link, and a link at
the final component is replaced rather than written through). This is armor against a recipe
author's path-assembly mistake, not isolation from hostile code — the hook already holds a
full context. A prepare hook that uses them:

```ts
import { ensurePrivateTargetDirectory, replacePrivateTargetFile, generatePrivateSecret } from "@phpcraftdream/clawwright/private-config";

export async function prepare(ctx, recipe): Promise<void> {
  const dataDir = ctx.settings.dataDir;
  await ensurePrivateTargetDirectory(ctx, `${dataDir}/sidecar-credentials`);
  await replacePrivateTargetFile(
    ctx,
    `${dataDir}/sidecar-credentials/sidecar.env`,
    `SIDECAR_CREDENTIAL=${generatePrivateSecret()}\n`,
  );
}
```

**`privateFiles` is recipe-tree-relative.** It names files and directories inside the recipe's
own directory — the source tree, not the target. Every carrier of recipe bytes reads it from
the source manifest through the same portable-content policy: `recipe import` leaves declared
entries out of the copy, set build and `provision-agent`'s workspace mirror hold them back the
same way, and `deploy` refuses outright while one still exists in the recipes tree or synced
`config/`. Entries are literal here too — no globs, `/`-separated, no `..`, backslashes
refused. The coordinate systems do not mix: a data-directory path does nothing under
`privateFiles`, and a recipe-directory path does nothing under `privatePaths`; an author who
swaps them gets neither the exclusion nor the write gate, and nothing reports the mistake.
`privateFiles` is a filter over file names, not a guarantee — a credential under an undeclared
name is copied. The enforced promise about a recipe's private files is the target-side
`privatePaths` policy, never the portable filter.

**Keyed pseudonyms and intent journals.** When a journal must remember *that* an identifier
was seen without remembering the identifier, use the keyed-pseudonym helpers from
`@phpcraftdream/clawwright/private-config`. `privatePseudonymKey` creates the deployment's HMAC key
exactly once under a declared private path (exclusive create — an existing key is only ever
read and validated, never rewritten, and concurrent first-callers converge on one key). The key is versioned, registered for redaction, and never returned to output:
a tampered, truncated or wrong-version key file refuses with a content-free error.
`privatePseudonym` hashes the length-prefixed `recipe`, `namespace` and `value` fields with that
key, so the same input always yields the same `v1.` token, different recipes or namespaces never
collide even when their concatenations would, and `privatePseudonymLookup` lets an operator
match a candidate value back to its token without exposing the key. This is pseudonymisation,
not anonymisation: tokens are unlinkable to their raw values without the key, but an operator
holding the key can always link them again. For work that must survive a crash between "start"
and "finished", journal the intent with `appendPrivateIntent`, journal the outcome with
`appendPrivateResult`, and recover the crash gap — intents without a matching result — with
`readPendingPrivateIntents`; duplicate intents are reported once, and idempotent retries decide
over the pending set:

```ts
import { privatePseudonym, appendPrivateIntent, appendPrivateResult, readPendingPrivateIntents } from "@phpcraftdream/clawwright/private-config";

const token = await privatePseudonym(ctx, `${dataDir}/vault/pseudonym-key.json`, { recipe: recipe.name, namespace: "user-id", value: rawUserId });
await appendPrivateIntent(ctx, `${dataDir}/vault/journal.jsonl`, { id: orderId, kind: "sync" });
try { await syncOrder(orderId); await appendPrivateResult(ctx, `${dataDir}/vault/journal.jsonl`, { id: orderId, kind: "sync", outcome: "done" }); }
catch { await appendPrivateResult(ctx, `${dataDir}/vault/journal.jsonl`, { id: orderId, kind: "sync", outcome: "failed" }); }
const pending = await readPendingPrivateIntents(ctx, `${dataDir}/vault/journal.jsonl`, { limit: 100 });
```

**Versioned state and raw journals.** For data a recipe keeps between runs, the same entry
exports `writePrivateState` / `readPrivateState` and `appendPrivateJournal` /
`readPrivateJournal`. All four refuse a path outside a declared `privatePaths` entry and a
symlink as the final component; refusals are a `PrivateDataError` whose `code` is one of
`policy`, `io`, `symlink`, `invalid`, `version`, `validation`, `size`, `secret` or `busy`, and
never echo the content. None of them knows about `--dry-run`: a hook skips the write itself when
`ctx.dryRun` is set.

```ts
import { readPrivateState, writePrivateState, appendPrivateJournal, readPrivateJournal } from "@phpcraftdream/clawwright/private-config";

const isCursor = (value: unknown): value is { cursor: number } =>
  typeof value === "object" && value !== null && typeof (value as { cursor?: unknown }).cursor === "number";

const statePath = `${ctx.settings.dataDir}/vault/state.json`;
const state = await readPrivateState(ctx, statePath, { version: 1, validate: isCursor }); // undefined when absent
if (!ctx.dryRun) {
  await writePrivateState(ctx, statePath, { cursor: (state?.cursor ?? 0) + 1 }, { version: 1, validate: isCursor });
  await appendPrivateJournal(ctx, `${ctx.settings.dataDir}/vault/events.jsonl`, { event: "advanced" });
}
const { records, corrupt, truncated } = await readPrivateJournal(ctx, `${ctx.settings.dataDir}/vault/events.jsonl`, { limit: 50 });
```

State is one strict `{version, value}` JSON envelope of at most 1 MiB, published atomically
(mode 600, parent 700); a missing file reads as `undefined`, a different stored `version` refuses
with `version`, and a rejecting `validate` refuses with `validation`, so a format change is an
explicit migration rather than a silent misread. The journal appends one JSON line per record
under the instance lock, overwrites a reserved UTC `timestamp`, refuses a record carrying a
registered secret, and rotates at `maxBytes` (default 256 KiB, at most 1 MiB) keeping
`maxRotations` old files (default 3, at most 8, `0` keeps none). Reads return newest-first
records, `limit` between 1 and 1,000, scanning at most 9 files and 10,000 lines; corrupt lines
are counted in `corrupt`, never echoed, and `truncated` reports records left unscanned. Full
backups keep these files; `migrate` and `share` archives exclude them as declared private paths.

Reading the declarations is strict where it matters, and honest about what it reads: the
independent `privatePaths` policy reader enumerates every installed recipe's declaration and
stops the command on a `recipe.json` that exists but cannot be read, parsed or validated for
`privatePaths` — the quiet-empty failure is exactly how a private file once walked into a share
archive. It validates that field and the JSON around it, not every manifest field. Cold
`backup` separately full-loads the manifests of running stacks, so a broken manifest refuses
while its stack is live and is tolerated when the stack is proven stopped. `recipe list` is
deliberately the opposite: a catalogue keeps showing the
working recipes beside a broken one, and the broken recipe is the one not listed.

Checking that a declaration took effect, in the order that answers the question:

```bash
./clawwright recipe install <name>      # runs prepare.ts — the first write outside every declaration is refused
./clawwright backup --profile migrate   # stops with an error if any manifest is broken; excludes declared paths
./clawwright verify --profile migrate <archive>   # refuses the archive if a declared path travelled anyway
```

`verify` passing after a migrate backup is the round trip: exclusion at archive time and
refusal at check time read the same declaration, so a declared path that was excluded passes,
an archive taken before the declaration existed is refused, and a file written under a name
nobody declared is invisible to the whole chain — verify looks for known secret values and
declared paths, never for content it has no way to name.

Limits, as plain as the happy path:

* `recipe remove` removes the compose project, not the data. Files already written under the
  data directory stay on the target, and once `recipes/<name>/recipe.json` is gone its
  declaration is gone with it — but the private-write ledger keeps protecting every recorded
  private write, so the migrate/share snapshot stays excluding them until explicit cleanup.
  Unrecorded writes, such as a running container writing into its own bind mount, were never
  intercepted and still are not. Move or delete former private files before removing the
  recipe if you want them to travel.
* The gate intercepts writes made through the helpers on this side. A running container that
  writes into its own bind mount is not intercepted — declare the directories the service
  actually writes, and keep credentials out of paths nothing declared.

Mixed command groups may declare structured output only for selected actions. The recipe tool
therefore keeps install/list/status as human progress while verify/onboard can return a stable
machine-readable result beside the text.

`recipe import <source> [new-name]` copies an app-owned recipe into a deployment and refuses
to overwrite an existing recipe. It copies through the same walk set build and the
provision-agent mirror use (`collectPortableRecipeFiles`), so symlink resolution and
containment agree across every carrier of recipe bytes: a link resolving outside `<source>` is
refused rather than copied. The copy leaves out credential-shaped files: the framework's
generic set — `.env*` (templates such as `.env.example` included — a filled template must not travel),
`secrets/`, `*.token`, `*.secrets.env`, its own conventions — plus whatever the source's own
`recipe.json` declares under `privateFiles` (recipe-tree-relative literal paths), because the
application, not the framework, knows its own files. This is a filter over file names, not a
guarantee: a credential under a name nobody declared is copied. The enforced promise about a
recipe's private files is the target-side `privatePaths` policy — snapshots exclude them and
verify refuses archives that carry them — not import's copy filter. Anything left out is named
on import: `skipped: N file(s) — <path> (<reason>), …`.

**Trust boundary: hooks run with the operator's rights.** `prepare.ts`, `verify.ts` and
`onboard.ts` are plain TypeScript, executed on this machine — not sandboxed, not reviewed by
the framework — with whatever rights the operator's own account has, whenever `bootstrap`,
`up` or `recipe verify` runs them. Importing a recipe is importing code that will run here on a
later command, not just data; `recipe import` names any hook it finds so that fact is visible
before the first run, but reading the hook itself is the only real check. Treat an unfamiliar
recipe's hooks the way you would treat a shell script from the same source, before running any
command that reaches them.

Keep recipe code easy to maintain: use small typed modules with one responsibility, named
constants for paths and protocol values, pure renderers for generated files, and thin lifecycle
hooks that orchestrate those functions. Validate inputs at the boundary, keep secrets inside
private-file helpers, return safe structured results, and document only the decisions a future
maintainer cannot infer from the code. Run the repository typecheck and linter, then
`./clawwright recipe check <name>` before shipping a recipe.

### Updating a pinned artifact

Use `recipe pin` to update the version and checksum defaults for a pinned release artifact in a recipe Dockerfile:

```bash
./clawwright recipe pin <name> --version <V>
./clawwright recipe pin <name> --version <V> --apply
```

Without `--apply`, the command previews the proposed change. `--apply` updates the two Docker `ARG` defaults atomically while holding the instance lock. If the Dockerfile contains more than one recognized pinned-artifact declaration, identify the intended current asset with `--artifact <basename>`; the value is the expanded asset basename, not a path or URL. The requested version must be a simple token containing letters and digits, followed only by letters, digits, `_`, `.`, `+` or `-`; paths and URLs are not versions. A request for the already-pinned version is refused.

The command does not edit `recipe.json` or add manifest fields. It retrieves checksum metadata from the project's GitHub release page over HTTPS only: first the asset's `.sha256` checksum, then `SHA256SUMS` only when the former returns 404. The checksum entry must name the exact asset and contain 64 hexadecimal characters; a bare digest is not accepted. Requests have an eight-second timeout, a 64 KiB response limit and at most five redirects, restricted to `github.com`, `objects.githubusercontent.com` and `release-assets.githubusercontent.com`. It does not download or hash the release asset. This trusts the project's release page; it is not a substitute for verifying a release signature.

Changing the pins does not restart a running service: rebuild and restart it with `recipe install <name>`. A worked example is in the [cookbook](recipes-cookbook.md#bump-a-pinned-release).


### Local recipe checks

Run `./clawwright recipe check <name>` before deploying recipe-code changes. The command
first lints portable Dockerfiles, then recursively discovers portable `*.check.ts` files,
excludes `node_modules` paths, sorts files, and runs each with
`node --experimental-strip-types` in the recipe directory.
It requires no instance, Docker or instance lock and does not invoke lifecycle hooks.
Unknown recipes, broken manifests and recipes with neither checks nor Dockerfile/Compose
lint input are refused. A lint-only recipe does not need its own check file.

Lint discovery walks `Dockerfile`, `Dockerfile.*` and `*.Dockerfile` anywhere in the portable
recipe tree. Root `compose.yml` services can also name a Dockerfile relative to their build
context; only contained portable recipe files are read. Compose parsing supports common
block mappings and build-argument lists without dependencies or interpolation. Unsupported,
malformed or nonportable definitions emit `compose-unparsed` warnings; name-discovered
Dockerfiles are still linted. No Compose command, build, download or recipe hook runs.

| Code | Severity | Rule |
| --- | --- | --- |
| `remote-add-unpinned` | error | HTTP(S) `ADD` requires `--checksum=sha256:<64 lowercase hex>`. Checksum ARG references must be declared; visible ARG defaults and Compose build args must be valid hashes. |
| `remote-add-checksum-unverified` | info | A declared checksum ARG has no statically visible value; runtime validity is unknown. |
| `curl-pipe-shell` | error | `curl` or `wget` piped directly into `sh` or `bash`. |
| `download-without-verification` | warning | Download to a file followed by extraction/execution of that file in the same RUN without `sha256sum -c`/`--check` or `shasum -a 256 -c`. |
| `floating-base-tag` | warning | `FROM` uses `latest` or no tag/digest, except `scratch` and earlier build stages. |
| `git-clone-unpinned` | warning | Remote clone/fetch lacks commit-SHA checkout or pinned fetch in the same RUN; ARG references are accepted. |
| `unparsed-construct` | info | Unsupported text constructs, including heredocs, are skipped rather than treated as verified. |

These are small static text rules, not a Dockerfile/shell interpreter or artifact trust proof.
Continuations, comments, shell RUN and common exec RUN forms are recognized. Findings carry
code, severity, file and physical starting line. To waive a single rule, put a nonempty reason
on the immediately preceding physical line (no intervening blank line):

```dockerfile
# recipe-check: allow floating-base-tag reviewed upstream compatibility requirement
FROM example:latest
```

The finding becomes info `waived`, retaining the waived code, location and reason. Errors
or failing own check files exit 1; warnings/info alone exit 0. Lint findings print before
own check execution; lint errors do not suppress those checks.

Use `./clawwright recipe check <name> --dry-run` to list lint targets and own check files
without executing recipe code; preview exits 0.
Real execution requires confirmation over MCP, like verify/onboard: checks run with the
operator's rights and are not sandboxed. Only a minimal environment is passed; deployment
settings and secrets are not injected, but code can still read host files or contact the
network. Review unfamiliar checks before running them. Each direct child has a 30-second
limit and 64-KiB combined output budget; descendants are not sandboxed or collectively
terminated. Failures print their retained output and make the command exit nonzero.

Discovery uses the shared portable-content walker, including its contained-link and
private-file policies. Top-level `node_modules` is pruned; nested `node_modules` is walked
before filtering, so unsafe links there can refuse discovery even though its checks are
never executed.

### Trying a recipe against a copy of its data

`./clawwright recipe trial <name>` builds the recipe and runs its stack against a copy of
the live data, without touching the live stack. It copies the recipe's declared
`privatePaths` from the live data directory into a target-side scratch directory and starts
the trial from that copy. The live stack, its ports and its data are never touched, and no
lifecycle hook runs: `prepare`, `verify`, `onboard` and `afterStart` are skipped, so a
trial exercises build and runtime only.

Requirements: a `compose.yml` in the recipe; declared `privatePaths` that fit under the
256 MiB copy bound; Docker Compose v2.24.0 or newer — the trial strips every port
publication with the `!override` merge tag and refuses older or unreadable Compose
versions in both the real run and `--dry-run` — and a transport with private-file
support, since the data is copied as private files.

In `--dry-run` the merged-config publication proof is skipped, because proving the merge
requires writing the override file and a dry-run writes nothing; the report says so
explicitly (`configProof: "skipped (requires writing the override); the real run refuses
on failure"`), and the real run refuses if the proof fails. Nothing is faked either way.

Teardown begins only after a local mutation has settled or (for SSH) after the
conservative target watchdog duration plus its rounding and kill grace. If that wait
cannot be completed or a second signal arrives, cleanup is skipped, the command exits
nonzero, and the trial project and scratch home are named as possible leftovers. SSH
cancellation only confirms that the local SSH client stopped, not the remote process; WSL
trial cancellation is unsupported and refused. Isolation analysis conservatively refuses
additional build tags, cache sources/destinations, additional build contexts, build
secrets/configs, service configs/secrets, and top-level config/secret file sources.
Unknown compose constructs are not analysed and are outside the trial safety guarantee;
this is not a general-purpose sandbox.

A trial is not isolation from the network: the build and the running services still reach
the network and any external account their credentials allow. A trial of a service that
talks to an external system with live credentials is not isolated from that system.

## Durable repair and verification

Use the framework's recipe commands to diagnose and recover a sidecar before resorting to
manual administration. `recipe logs` observes the stack and accepts `--tail`, `--since`,
`--no-color` (strips ANSI escape sequences) and `--json` (one JSON object per line);
`recipe
diagnose` also invokes `verify.ts` and takes the instance lock because the hook may mutate
state. An ownership/cutover refusal must be resolved deliberately, not hidden by a second
Compose project or bypassed without the operator's agreement.

Use `recipe inspect` first: unlike `diagnose`, it does not invoke `verify.ts` or other
hooks, take the instance lock or write the target. Default `recipe recover --service <service>`
recreates only that service with its existing exact image, starts no dependencies and runs
no hooks. `--build` or `--pull` explicitly opts into changing the selected image; preview
those impacts first. Recovery is for the current owned namespace, not an implicit legacy
cutover; use migration for the latter.

Changing a bind-mounted configuration file does not make an already-running process reload it.
After preparing new inputs, explicitly use `recipe recover <name> --service <service>`
to apply them to that owned service. A repeated install/up is not proof that the new bytes
were loaded. Reconcile the consumer separately only when required and approved.

Consumer reconciliation is a separate explicit `--reconcile-consumer` recovery option.
It invokes the named `prepare.ts:afterStart` export only after the selected service and
all declared readiness dependencies are already ready; it does not start dependencies.
The hook may mutate consumer configuration and the gateway, and its evaluation/invocation
stays inside the executor's instance lock. Preview discloses these effects without importing
the hook. A recovered service alone is not proof that its consumer works.

An emergency change to a running container is not a complete recipe repair. Identify the
owner of the fault and update its reproducible source: `compose.yml`/`Dockerfile` for
runtime dependencies and mounts, `prepare.ts` for generated configuration, `recipe.json`
for required services/readiness, and `verify.ts` for the consumer-visible check. Preserve
existing credentials and application state; a repair must not silently regenerate them or
overwrite live data. A Docker/host fault is not automatically a recipe-code defect, but the
recipe should detect an unavailable dependency and must not report it as ready.

Declare every service required by the consumer, including protocol bridges, in readiness.
A listening socket alone does not prove usable egress. Verification must check command
success, the expected protocol/status and application result, not accept any positive HTTP
code. Distinguish dependency reachability, API authentication and active channel processing.
For a proxy serving Telegram, a successful `getMe` is insufficient while polling is stopped;
verification should report that channel state as a separate failed or unverified condition.
If Telegram is optional for the recipe, report it separately rather than silently converting
an unavailable check into a ready verdict.

Reconcile the consumer after its dependency is ready through the supported lifecycle hook,
with disruptive effects disclosed. Then verify from the gateway and, with permission, send
an end-to-end message and observe the reply. Do not send messages or claim a working reply
without that check. Exercise the repaired recipe's install/verification path on an isolated
fixture or through an approved live run; a manual repair alone does not prove that the next
install or recovery reproduces it.

Keep an explicit distinction between recovered service, durable recipe fix and framework
tool gap. When the supported lifecycle is blocked by migration or a lock, record the blocker
and the approved temporary recovery instead of claiming the recipe has been fully repaired.

### Existing-stack cutover

Earlier releases used `<gateway-compose-namespace>-recipe-<name>`; the original
scheme used `<deployment-basename>-recipe-<name>` even with an override. Ordinary lifecycle
operations and backups refuse to touch a legacy project that contains containers, including
stopped ones; they do not adopt a legacy stack or bypass ownership checks. Containers in the
current project must carry Compose `project.working_dir` and `project.config_files` labels
matching the intended recipe's root and definition; foreign, missing or ambiguous provenance
is not permission to cut over.

Use the framework inspection and bounded recovery/migration path instead of raw
`docker compose down`:

```bash
./clawwright recipe inspect <name> --json
# Current owned namespace: recreate exactly one declared service
./clawwright recipe recover <name> --service <service> --dry-run
./clawwright recipe recover <name> --service <service>
# Proven owned legacy namespace: preview the whole migration
./clawwright recipe migrate <name> --dry-run
./clawwright recipe migrate <name>
# Proven owned legacy namespace whose data is disposable: preview the retirement
./clawwright recipe retire-legacy <name>
./clawwright recipe retire-legacy <name> --apply
```

Choose the cutover path by what the legacy stack still is. `recipe migrate` is for a legacy
stack that still matches the recipe definition's service set and whose data must move into
the new stack; it transfers named volumes and preserves bind paths. `recipe retire-legacy`
is for a legacy stack that no longer matches the definition, or whose writable data is
disposable: it previews by default, and with `--apply` it stops the legacy containers (a
container that will not stop refuses; there is no kill or force; an image or container
configured with an unsupported stop signal — anything but SIGTERM/SIGINT — refuses before
anything is stopped), verifies they stopped, re-checks writer isolation (no other container,
in any project, may still write the storage; a conflict after the stop aborts without backup
or removal and reports the stopped containers and `docker start <ids>` to bring them back),
takes a cold backup of their writable binds and named volumes into a private recovery
directory (using a trusted local helper image: the legacy stack's first image by default, or
`--helper-image <sha256 image ID>`; its read-only temporary helper probe runs during preview and does not write target storage; missing helper tools refuse before the stop), records the
full `docker inspect` JSON of every removed container plus a storage-to-archive restore
manifest, then removes the containers only — images are retained, no volume or image is ever
removed, and the recipe's data directory is untouched. Afterwards
`recipe install <name>` proceeds normally. Preview and apply share the same ownership proof
and refusal rules as inspection; the journal and the rollback steps (retained image IDs, the
recorded inspect JSON files as the authoritative reconstruction source, per-container ports,
mounts and environment names, and per-archive restore commands) are part of the reported
result.

Review the preview before approving execution. Recover and migrate are destructive effects
requiring `confirm: true` through the MCP framework pipeline; `--dry-run` is a read effect.
Both accept the existing optional `--break-lock` / `--break-foreign-lock <hostId>`
takeover flags; those are not substitutes for ownership proof or execution confirmation.
Inspection takes no lock, runs no hooks and makes no target writes; it always requests the
runtime's sanitized log evidence — the human output hides it and the structured output can
include it — so review requested logs before sharing them: bounded, sanitized output is not
a guarantee of secrecy, and unlabelled unknown secrets cannot be universally detected.

Migration is bounded to a proven owned inventory: one populated legacy namespace, an
empty target namespace, and one source replica for every configured service. When it runs,
it takes cold storage backups after verifying clean shutdown, transfers supported
Compose-managed named volumes into fresh target volumes, preserves bind paths, and keeps
backups and old volumes retained in a private recovery directory. On failure after target
writes it compensates: it proves the target is shut down before restoring verified bind
backups and resuming old writers, never adopts foreign containers, and never resumes the
old stack while the target's shutdown is unproven. Failed target artifacts, journals,
backups and old volumes are not automatically cleaned up; review them before any separately
approved recovery or cleanup.

The executor enforces these guarantees through detailed checks — journal phases, exact
stop acknowledgements, storage and helper-image verification, writable-layer inspection,
compensation sequencing and recovery-directory ownership — documented in
[the migration executor notes](../internal/recipe-migration-executor.md#recipe-migration-executor-implementation-notes).
Those pages are the implementation contract, not a claim that migration has been
runtime-verified on your deployment.

### Storage boundaries and preservation

Migration distinguishes **container mounts** from **backup roots**. It preserves bytes,
fractional mtimes, numeric ownership, modes and link topology for declared mount storage,
using POSIX/PAX archives; storage with ACLs or extended attributes is refused. A read-only
file mount is archived once, as part of the unique writable directory that contains it —
read-only access in one mount does not make that storage disposable. Missing files,
symlinks, ambiguous or overlapping writable roots refuse, before storage effects and again
after restoration; only a successful, verified restore authorizes replacement identities.
The [executor notes](../internal/recipe-migration-executor.md#storage-boundaries-and-preservation)
carry the exact revalidation, identity-continuity and helper-boundary rules.

### Application-owned migration contract

Migration requires an explicit author guarantee in the loaded `recipe.json`, before any
runtime planning or mutation. The field is optional for ordinary recipe lifecycle commands;
absence refuses migration, including preview. Invalid declarations refuse manifest loading.
The complete interface is:

```ts
interface RecipeMigrationBackup {
  readonly consistency: "application-cold-safe";
  readonly persistentState: "all-in-declared-named-volumes-and-bind-mounts";
  readonly cleanShutdown: "flushes-all-writers";
  readonly restore: "application-safe-including-compensation";
}
```

```json
{
  "migrationBackup": {
    "consistency": "application-cold-safe",
    "persistentState": "all-in-declared-named-volumes-and-bind-mounts",
    "cleanShutdown": "flushes-all-writers",
    "restore": "application-safe-including-compensation"
  }
}
```

The direct mode accepts exactly these four keys and literals. It guarantees that all
persistent state lives in declared storage, every clean shutdown flushes every writer,
and cold restore is safe including compensation. Existing cold-safe apps remain unchanged.
Do not make a false unconditional flush declaration: even exit zero can accompany a writer
close failure or producer timeout and lost data (including in a pinned Tor application).

An application which can prove each particular stop may instead declare exactly:

```json
{
  "migrationBackup": {
    "consistency": "application-verified-cold",
    "persistentState": "all-in-declared-named-volumes-and-bind-mounts",
    "cleanShutdown": "verified-by-post-stop-hook",
    "restore": "application-safe-including-compensation",
    "verification": "migration-verify.ts"
  }
}
```

`RecipeMigrationBackup` is the union of the four-key direct contract above and this
five-key conditional contract. Mixed modes, additional keys, alternate paths and booleans
are rejected. Persistent-state and compensation/restore guarantees still apply; a verifier
is not a database dump protocol or a guarantee about external/remote state.

The app-owned file must have this named export (no default fallback):

```ts
export async function verifyMigrationBackup(
  ctx: Context, recipe: Recipe, evidence: MigrationBackupEvidence,
): Promise<MigrationBackupVerification>
```

The application implements a read-only assessment of every stopped service. For a Tor
verifier, require this stop's clean final completion marker and refuse writer-close warnings,
producer timeouts or insufficient observations; exit zero alone is not sufficient. Read
bounded logs privately through Context, scoped to verified full IDs and
`--since evidence.stopStartedAt`; failed/ambiguous reads are unknown, never empty success.
Do not return or emit raw logs, credentials or private context. The framework does not read
logs for this callback and supplies no readLogs capability or public log snapshot.

Return exactly `{ verified: true }` only after successful assessment; throw on refusal or
unknown. Boolean true, false, generic `{ ok: true }`, additional keys or other truthy
values fail closed. The verifier callback has a fixed 30-second deadline including import,
must be read-only, and timeout or refusal fails closed with source compensation. Planning
imports nothing and inspect never invokes the callback; the executor imports the verifier
only after proven source stop, and journals record whether application verification stayed
pending, became verified, or ended unknown. The exact evidence and verification interfaces
live in `runtime/runtime.ts`, and the timestamp-boundary and journal mechanics in the
[executor notes](../internal/recipe-migration-executor.md#application-verified-cold-mode-executor-mechanics).

### When a migration refuses

Migration fails closed: an unproven prerequisite refuses the whole operation, before any
target write, and there is no build, pull or fallback adoption. The refusal classes and
the supported next step for each:

* **Ownership/namespace unproven** — the legacy project's containers do not prove they
  belong to this recipe (missing, foreign or ambiguous `project.working_dir` /
  `project.config_files` labels), or the target namespace is not an empty, proven-owned
  one. Nothing is adopted or stopped. Run `./clawwright recipe inspect <name> --json`,
  read the reported namespaces and provenance, and resolve the ownership question
  deliberately before re-previewing.
* **Writable-layer data** — the containers' writable layers hold data outside declared
  mounts and `ephemeralPaths`. No layer is archived or copied, so this data would be lost.
  The refusal names a sanitized sample of the offending paths and points at
  `ephemeralPaths`: declare only genuinely disposable scratch paths in `recipe.json`, or
  move the data into declared named volumes or bind mounts before migrating.
* **Unsupported storage** — mounts outside the supported set (for example ACLs or extended
  attributes, or an ambiguous/overlapping root). The framework will not archive or transfer
  them. Restructure the stack's mounts, or cut over manually (below).
* **Missing helper tools** — no available image supplies the storage tools the executor
  requires; a failed capability check is reported honestly, without choosing another
  image, installing, building or pulling. Supply `recipe migrate --helper-image
  sha256:<id>` naming an image already present locally that you have reviewed — it runs as
  root with access to application storage and private backups.
* **Foreign lock** — another holder owns the instance lock (or a foreign host's). Use the
  existing `--break-lock` / `--break-foreign-lock <hostId>` takeover flags only after
  confirming the holder is gone; they are not substitutes for ownership proof or execution
  confirmation. Preview (`recipe migrate <name> --dry-run`) takes no lock and is always
  available.

For every class, `recipe migrate <name> --dry-run` is the safe probe: read-only, no lock,
no hooks, no target writes, with the full refusal reason in the preview.

The last resort is outside the framework's guarantees. A manual cutover — stopping the old
stack with `docker compose -p <project> down` (never with `-v`) using the exact project name `recipe inspect`
prints, preserving all bind-mounted data yourself, and then `./clawwright recipe install
<name>` — is not covered by the migration contract: nothing verifies the old containers are
gone rather than merely stopped, named-volume data is not transferred by the reinstall and
stays wherever the old project left it, no cold backups are taken, and a mistake can lose
application state silently. Prefer `recipe recover` and `recipe migrate`; take this path
only with the data's location and the old project's state verified by hand.

**An MCP server plus an agent to use it**: `server.ts` (a stdio MCP server) and an `agent/`
directory.

```bash
./clawwright provision-agent <recipe>
```

```
recipes/<name>/
├── server.ts                the recipe's own stdio MCP server
├── <anything else>          data the server reads — mirrored into the data mount as-is
└── agent/
    ├── config.json          agentId, mcpServerName, cronJobName, cronSchedule, cronTimeoutSeconds
    ├── *.md                 copied verbatim into the new agent's workspace (AGENTS.md, SOUL.md, …)
    └── cron-message.txt     optional — its presence is what creates the cron job
```

Everything under `recipes/<name>/` except `agent/` is mirrored into the deployment's
workspace mount so the container can spawn `server.ts`; `agent/` stays host-side and is
read to build the workspace files and the cron job. The command creates the agent if it is
missing, registers the MCP server, and adds the cron job — and re-running it rewrites the
prompt files and the mirrored data to match the repository, the same way `apply-config`
treats `openclaw.json`. What the agent itself writes into its workspace afterwards is never
touched.

Three behaviours worth knowing about:

* A write-level call can need a wider scope than the deployment's `cli` client is paired
  with (`cron add` is the one met in practice). A scope refusal never starts a model turn
  implicitly. `accept --with-model` and `set try --with-model` are the only commands that
  opt into asking the `main` agent to approve the exact request and retrying once. Without
  that flag, the check reports that it could not be checked. Otherwise approve the named
  request through a trusted admin session or the Control UI; never use
  `devices approve --latest`, because another device's request could be newer.
* The recipe's files are mirrored, deletions included: a page removed from the recipe is
  removed from the target, or the recipe's MCP server would go on serving it and the agent
  would answer from withdrawn instructions with nothing reporting a problem. Only the
  recipe's own mirror directory is treated this way — the agent's workspace holds its
  `memory/` and is never pruned.
* The cron job is reconciled, not merely created: a job whose schedule, message, timeout,
  session or delivery no longer matches the recipe is removed and added again, so editing a
  recipe and re-running is enough. Everything else about a job — its id, its run history —
  is state the gateway owns and is not compared.
* The cron job is created with delivery disabled. Its product is whatever the agent writes
  in its own workspace, and the default (announce to the `last` channel) fail-closes on
  every run of a deployment with no messaging channel configured.

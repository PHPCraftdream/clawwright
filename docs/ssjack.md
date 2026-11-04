# Optional ssjack runtime

Clawwright can operate without ssjack. The integration is an optional runtime protocol dependency, not an npm dependency on a Go executable. A managed launch uses the keeper that supplied the temporary child context; it never discovers another ssjack executable on PATH, unlocks a vault, exports a key or installs a binary.

## Runtime compatibility

`runtime/transport/remote/ssjack-contract.ts` owns the requirements. The pinned HTTPS/MCP client checks the actual serving keeper for protocol 1, 16384-byte chunks, `exec`, `stdin`, `binary`, `backpressure`, `cancel` and `connection-only` cancellation. The keeper reports its source commit. A compatible protocol does not prove a binary's supply provenance, and a matching filename does not prove compatibility.

`OC_TARGET_LOCATION=auto` selects the keeper when a complete child context is supplied. Without any child context it keeps the existing platform defaults. `OC_TARGET_LOCATION=ssjack` explicitly requires a context. Explicit `local`, `wsl` and `ssh` stay standalone choices; they do not implicitly borrow the keeper. A partial, invalid, incompatible or disconnected context in auto/ssjack mode rejects rather than falling back to another transport. Real cross-project laboratory acceptance remains separate from these source-level and synthetic checks.

The agent must use the keeper's registered `app_exec` launch to obtain a fresh child context. Merely running Clawwright as a shell subprocess of an agent that has the primary ssjack MCP bridge does not claim the primary bootstrap or manufacture a child lease. Unrelated host subprocesses launched through `spawnLocal` have the child context removed from a copied environment, case-insensitively, even if an env override attempts to pass it; the parent environment remains available for other contexts within this finite operation. This scrubbing is not general gateway/provider-secret redaction: ssjack registers the child bootstrap token with the framework logger, not every secret the application or gateway may handle.

A scoped path bridge translates declared target/container mounts only. It refuses operator-to-target and target-to-operator filesystem mappings. Compose copies the operator package's definition into the existing owner-only per-call environment directory, uses that directory as its project directory, and removes it with the environment on success or failure. No corresponding checkout on the target is assumed. Missing private-file staging capability refuses before target preparation.

Scoped scheduling, port forwarding, nested stdio relay and second-hop deployment are refused at their owning boundaries before applying those routes. Recipe side-stack definition delivery is conservatively unsupported in this slice, including image-only side-stack definitions; it is not silently interpreted as a shared target file. Legacy transports retain their existing path and Compose behavior.

The finite executor pumps 16 KiB stdin frames and drains output concurrently. Only `accepted: false` permits retrying the identical encoded input; uncertain responses fail the scope, never replay it. Output DTOs and canonical base64 are validated before use. Captured output has an explicit 64 MiB combined bound and fails rather than overwriting unread bytes. A binary sink can replace capture; it is awaited before another frame is read, must honor the operation's AbortSignal, and owns its own destination/publication rules. Buffered command results decode UTF-8 only after reassembly, preserving a leading BOM. Public byte/environment contracts use `Uint8Array` and plain records so importing the application API does not require consumer-side Node type declarations. The transport preserves the existing distinction between terminal streaming and captured output.

Finite deadlines and caller cancellation request `transport_cancel` once. Neither an acknowledgement nor closing the client confirms termination of a detached remote process. Stdio protocol relay and persistent client invocation explicitly refuse this temporary route. The new transport does not inherit from the external-SSH implementation.

## Binary supply pin

The framework package manifest declares this optional dependency in `ssjackRuntime`, separately from npm dependencies. Its `requirements` are checked against the client's shared runtime contract in CI. Its `supply` is an explicit preparation pin, currently for Linux amd64; it is not an installer or a claim that the same binary runs on Windows or macOS. Other platforms require their own reviewed pin, never substituting a similarly named artifact.

An operator preparing ssjack must pin a reviewed binary source explicitly. The supply record validated by `validateSsjackSupply` has these shared fields:

- `repository`: exactly `PHPCraftdream/ssjack`;
- `commit`: a full lowercase 40-character Git commit;
- `platform`: an explicit supported OS and architecture, never `auto`;
- `archiveSHA256`: the exact downloaded archive or release payload's digest;
- `executableSHA256`: the extracted executable's digest.

Before a suitable release, use `kind: "ci"` and exact numeric `runId`, `artifactId` and `artifactName`. Check the run's repository, source commit, successful conclusion, artifact identity and expiry before download. Verify the downloaded archive digest, inspect its member layout, and verify the extracted executable digest before execution. An artifact name, a branch, or the run's successful conclusion alone is insufficient. CI artifacts expire; an expired pin must fail preparation rather than discover a newer run.

After a suitable release, explicitly replace that record with `kind: "release"`, an exact `version` such as `v1.2.3` and `asset`. Check the release/tag source commit and both digests. For a raw executable asset the payload and executable digests are equal. Do not retain CI-only fields in a release record. Transport code and runtime protocol requirements do not change merely because the supply source changes.

There is no automatic download, installer, fallback to `latest`, tag creation or version bump in this contract. A running compatible keeper may come from an independently approved source; the supply pin describes preparation, not a demand to replace an authenticated keeper with another process.

## Persistence boundaries

The existing `config/deployment.lock.json` pins the remote OpenClaw instance composition. Its writer is `commands/management/lock.ts`; plan, inspect and set validation read it. An operator-side binary supply pin is not an image, recipe or model setting, so it does not belong in that lock or its declaration checksum.

A supply record contains no endpoint, bearer token, TLS session pin, password, private path or SSH credential. Unknown fields are refused. In particular, never copy `SSJACK_APP_ENDPOINT`, `SSJACK_APP_TOKEN` or `SSJACK_APP_CERTIFICATE_SHA256` into a deployment, package manifest, lock or archive. They identify one temporary operation, not a reusable dependency.

Secrets handled by the wider application have separate lifecycle and backup boundaries: target-environment changes require a gateway restart to be read; repository `.env` values are fixed in the container environment at creation, so applying changed values requires container recreation (a plain restart retains the old environment). The `secrets.ts` comparison checks environment values but prints names only; it does not prove that a provider or gateway adopted or can use them. Full backups include secrets by default; `--with-secrets` explicitly selects the full profile. Migrate snapshots may have plaintext secret sidecars, separate from the archive. Treat these files and backups as sensitive.

## Launcher boundary

At keeper startup, an operator enrolls a trusted deployment directory and native Node entry, plus an optional fixed Incus container/user route. The current full `app_exec` is not a restricted declarative sandbox: its admitted exec/host operations and credential reporting can act generally, including exposing secrets, with the configured principal's privileges. `confirm=true` is caller acknowledgment, not proof of human approval. Each operation receives a fresh child capability; finish, timeout, cancellation or parent disconnect revokes it. This bounds the capability lifetime, not the authority of code using it. Registration trusts the application code and is not a filesystem sandbox: trusted application or recipe code, Docker/Incus admin sockets, `sudo` or an alternate shell can bypass restrictions in future narrower APIs. Non-admin operation is an operator-enrolled server policy, not something guaranteed by a role name or SSH key.

A future declarative MCP interface and universal encrypted secret store are plans, not current guarantees. The current transport slice stages the operator-side Compose definition rather than assume shared package paths. Unsupported second-hop deployment, recipe build inputs, persistent scheduling and stdio relays must refuse before mutation. Invalid supplied context must never trigger fallback to ordinary SSH.

## Deploy text mode

The deploy-text source group is `packages/clawwright/runtime/transport/remote/text/canonical.ts`, `packages/clawwright/runtime/transport/remote/text/client.ts`, `packages/clawwright/runtime/transport/remote/text/input.ts`, `packages/clawwright/recipe-kit/consumer.ts`, and the public `packages/clawwright/recipe-kit/index.ts` export for `deployText`.

`deploy-text` usage is `deploy-text --file <registered-target> --template <local-reference-only-file> --profile <expected-profile>`. The producer must launch with `SSJACK_TEXT_LAUNCH=1` and `SSJACK_TEXT_PROFILE=<expected-profile>` plus the exact `SSJACK_APP_ENDPOINT`, `SSJACK_APP_TOKEN` and `SSJACK_APP_CERTIFICATE_SHA256` values provided by `serve` (or the `SSJACK_APP_*` mapping where explicitly configured). Any ordinary generic command under this marker refuses; there is no fallback. `apply-config` refuses unsupported flags while structured markers remain unchanged. For the selected input, the client uses `lstat` to reject symlinks and non-regular files before opening. On POSIX it opens nonblocking, then checks that the opened handle is regular and has the same device/inode as the pre-open entry, preventing a substituted path from being accepted. Windows follows the normal disk-file path with pre/post identity checks; `O_NONBLOCK` is not a portable Windows guarantee. Reads are bounded to 32768 bytes plus one byte to detect growth beyond the limit; UTF-8 decoding is fatal and preserves a leading BOM. There is no universal filesystem deadline guarantee. The runtime directory is also subject to an immediate-entry ceiling of 7. CLI outcomes other than `received` exit 1; the recipe returns a status that callers must not equate with unknown success.

Text templates are literal compact canonical JSON placeholders, with exact fields and order: `{"$ssjack":{"format":"ssjack-secret-ref-v1","object_id":"…","snapshot_id":"…","store_id":"…","version_id":"…"}}`. Clawwright does not re-serialize, escape, interpolate or resolve values; it passes the literal reference-only text to ssjack for the approved replacement. Templates are limited to 32 KiB and 1–16 unique references, all from the same store and snapshot. Text mode uses its separate endpoint and accepts only the `text_hydrate` capability. Direct temporary bootstrap uses `SSJACK_TEXT_*`; an explicitly configured `SSJACK_TEXT_LAUNCH` mapping may instead map `SSJACK_APP_*`. Neither mapping makes these temporary credentials durable configuration. Canonical field order remains the published Go order; the verified source pair and its bounded acceptance are listed below. No values are resolved, persisted, or exposed to ordinary deployment paths.

The text operation is one-attempt, bounded to at most 60 seconds, and reports `withheld`, `received` or `unknown`. An uncertain post-dispatch outcome is `unknown` and is never retried; unknown does not imply restart or replay. `received` is delivery evidence, not application authentication or adoption. The selected-text CLI composition has passed the pinned public-CI acceptance below; it does not automatically enable structured `apply-config`, provider requirements or arbitrary recipe execution.

## Backup text mode

`backup-text --file <PATH> --output <PATH> --profile <NAME>` reads one explicitly granted text file through the CLI's parallel narrow client path. A separate prior human approval of `reverse-copy-v1` at the root is required; launch does not prompt for or authorize that approval. The keeper privately reads only the approved source; it does not ask the human for a grant. The grant profile is frozen by the producer, which accepts only the exact `text_reverse_copy` capability (distinct from hydrate's `text_hydrate`). One attempt, at most 60 seconds, bounded by the earliest caller/grant deadline; no generic/raw fallback. Decoded text is limited to 1 MiB (wire limit 25,231,360 bytes); request 256 KiB and file 4096 bytes. After dispatch, uncertainty is `unknown` and never returns text. `withheld` and `unknown` omit text; `received` with empty text is valid. Preserve BOM and Unicode. Local output uses exclusive publication: existing output is never overwritten, and the live source is never mutated. This does not promise atomic network delivery, crash durability or application adoption. CLI emits the status and exits 0 only after a received copy is published; refusals and publication failures exit nonzero. The public recipe API is `backupText(ctx: RecipeContext, input: BackupTextInput): Promise<BackupTextResult>`.

Exact literal completeness is required; no secret certification is implied. Empty or ordinary backups are legitimate, but restore is unsupported unless the selected template contains 1–16 canonical references, all from the same store and snapshot, with the entire template at most 32 KiB. Restore proceeds through existing `deploy-text`; it never resolves `latest`. Unmatched bytes are preserved, so an incomplete mapping can leave other secrets in the returned copy. Users own mapping completeness, file selection, escaping/representation and consumer storage. Reverse copies reject invalid UTF-8 and NUL; no binary archive, arbitrary-document round-trip or automatic unknown-secret discovery is promised.

## Verified selected-text composition

The verified runtime source pair is Clawwright `506ff2a2802bbfa5cf931f735f1b06aaee7f5244` and ssjack `eb89b10000d1cbdd2a46b8e39f3a7bca5df757ce`:

- [Paired feature acceptance 41569701166](https://github.com/PHPCraftdream/ssjack/actions/runs/41569701166): actual registered CLI, real keeper authority and encrypted fixtures, pinned HTTPS, authenticated SSH loopback, deploy, safe backup and exact-version restore; PASS without SKIP.
- [ssjack full gate 41570783616](https://github.com/PHPCraftdream/ssjack/actions/runs/41570783616): all nine jobs passed, including the paired gate, three operating systems, race detector and unchanged production KDF profile.
- [Clawwright full gate 41569699232](https://github.com/PHPCraftdream/clawwright/actions/runs/41569699232): all seven platform/negative-control jobs passed. Scoped run `41568975739` and policy run `41568975725` also passed on the same Clawwright commit.

Use a checkout/package built from these verified sources; an older published package is not evidence that it contains these commands. No package version bump, release or main-branch merge is implied.

Run each operation as the approved child of its separately authorized ssjack text context. The following arguments contain only metadata and reference-file paths; bootstrap credentials are supplied by the keeper, not copied into declarations:

```sh
./clawwright --app deployment deploy-text --file /approved/config --template template.ref.txt --profile approved
./clawwright --app deployment backup-text --file /approved/config --output new-backup.ref.txt --profile approved
./clawwright --app deployment deploy-text --file /approved/config --template new-backup.ref.txt --profile approved
```

The backup context needs a prior `reverse-copy-v1` grant; deploy/restore need `hydrate-v1` grants. Each grant binds the actual source/destination, SSH credential identity, command, exact references/snapshot and expiry. Select a new output path: an existing backup is never overwritten. Do not automatically retry or recreate a capability after an unknown result.

The public recipe helpers are `deployText(ctx, { file, template, profile })` and `backupText(ctx, { file, profile })`. These explicitly selected operations do not grant the rest of a recipe generic exec/read capabilities or create its execution context. The actual paired gate covers CLI composition; helper contracts have separate component checks.

Acceptance uses synthetic credentials and a controlled target, with test-only accelerated installation derivation. It does not verify interactive human approval/unlock prompts, production enrollment/hardening, universal sandboxing or OpenClaw authentication/adoption. The consumer may keep plaintext in its explicitly approved final configuration. Root, same-UID processes and the trusted runtime remain trust boundaries.

## Streaming text v2 (candidate)

The v2 path is a separately gated candidate. Its public recipe helpers and
internal framing, file and pinned HTTP components have dedicated CI acceptance;
registered CLI wiring and the actual Clawwright/keeper/SSH composition are not
claimed as accepted here.
The verified v1 commands and limits above remain unchanged, with no automatic
fallback between protocols.

CLI streaming is explicit: use `--stream` together with
`--references grant-refs.json`. The metadata file is a UTF-8 JSON array of exact
canonical placeholder strings, not placeholder objects or secret values. It is
bounded to 16 KiB and 1–16 distinct refs. Supplying only one of these options
refuses before transport; a large file never silently selects another protocol.
Each invocation needs its own independently approved directional v2 context.

```sh
./clawwright --app deployment deploy-text --stream --references grant-refs.json --file /approved/config --template template.ref.txt --profile approved
./clawwright --app deployment backup-text --stream --references grant-refs.json --file /approved/config --output new-backup.ref.txt --profile approved
./clawwright --app deployment deploy-text --stream --references grant-refs.json --file /approved/config --template new-backup.ref.txt --profile approved
```

`deployTextStream(ctx, input)` accepts `file`, `profile`, `references` and a local
`templatePath`. `backupTextStream(ctx, input)` accepts `file`, `profile`,
`references` and a new local `outputPath`. Both return only
`"withheld" | "received" | "unknown"`, not hydrated or copied text. Their public
input and result declarations are self-contained and do not import Node types.
Dry-run refuses with `invalid-request` before opening a transport.

`references` is the operator's exact set of canonical placeholder strings from
the separately approved v2 root grant: 1–16 distinct refs from one immutable store
and snapshot. Parsed refs are correlation metadata, not human approval. The client
does not discover values or expand this set. Forward and reverse need separate
`hydrate-stream-v2` and `reverse-copy-stream-v2` contexts respectively.

```ts
import { deployTextStream, backupTextStream } from "@phpcraftdream/clawwright/recipe-kit";

await deployTextStream(ctx, {
  file: "/approved/config", profile: "approved", references,
  templatePath: "template.ref.txt",
});
await backupTextStream(ctx, {
  file: "/approved/config", profile: "approved", references,
  outputPath: "new-backup.ref.txt",
});
```

The client reads one verified regular template handle twice, without retaining
the whole template. The keeper privately binds Prepare to Execute. Decoded input
and transformed output have separate 64 MiB bounds; data frames are at most
32 KiB and the keeper retains the 1 MiB aggregate selected-value bound. Reverse
publication requires valid UTF-8/no NUL, exact framed counters/correlation, terminal
completion and full HTTP EOF before exclusive publication. Existing output is
never replaced; the source file is not rewritten. Incomplete tentative copies
are removed, not published.

Each helper has one attempt and a transport/stream processing deadline of at most
60 seconds. Local filesystem operations have no universal OS deadline guarantee.
Unknown may follow possible effects and never authorizes retry or resume.
Received is delivery/publication evidence, not crash durability or application
adoption. Restore submits the captured reference-only file through a separately
approved forward v2 context; refs never become `latest` and a new snapshot does
not renew an old grant. Mapping completeness, encoding, source selection and
consumer storage remain the operator's responsibility.

## Reference-only secret placeholders

Deployment declarations may carry an explicit metadata object with one `$ssjack` field. Its body has exactly `format: "ssjack-secret-ref-v1"`, `store_id`, `object_id`, `version_id` and `snapshot_id`. Each ID is 32 lowercase hexadecimal characters encoding a nonzero 16-byte ID. There are no `latest`, wildcard, endpoint, credential or value fields. The format is shared with ssjack's `docs/application-store/PLACEHOLDERS.md`; it is not a native OpenClaw SecretRef or proof of authorization.

The metadata collector preserves exact identities and structural paths without interpolating strings or reading an environment. It validates parsed JSON data, rejects malformed reserved markers with value-free errors, avoids invoking property getters, and bounds traversal. Raw duplicate-key rejection belongs to the raw declaration parser; validation of an already-parsed JSON5 object must not be described as that protection.

For ordinary provider requirements and structured declarations, managed value delivery remains unenrolled. The explicit selected-text profile above does not change that boundary. A marker cannot be treated as a satisfied provider credential, replaced by a conventional environment-variable guess, or enabled through a caller flag. Requirements refuse it before the application-requirements hook or environment-value fallback. `apply-config` also refuses declared markers before live-value reads, target patch staging or native OpenClaw invocation. A real operation may already have acquired its bookkeeping instance lock; this is not a claim that every lifecycle/recipe operation or existing full transport is a restricted secret API.

Reference-only declarations remain unchanged on refusal. Ordinary standalone environment/file/exec/native reference behavior is preserved. No code in this path resolves values, writes `.env`/persistent target plaintext files, passes values in argv/environment, or routes them through captured output. The existing full application/transport surfaces retain their previous authority; their bootstrap-token masking does not make them approved secret sinks.

Successful metadata validation or selected-text acceptance does not establish production enrollment, native provider integration, broad backup migration or observed adoption. Unsupported ordinary declaration paths continue to refuse rather than fall back to legacy secret handling.

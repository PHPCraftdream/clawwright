# Dependency license audit: evidence and limits

## Reviewed dependency evidence

The audit is fail-closed. It reads required and optional production dependencies from the **published** `packages/clawwright/package.json`, and resolutions, versions, license fields and integrity values from the npm v3 root `package-lock.json`. Every reachable package must match an explicit reviewed name/version/license entry. No general SPDX allowlist is used; missing or unreviewed package evidence is a failure.

### `json5@2.2.3`

The tagged source <https://github.com/json5/json5/blob/v2.2.3/LICENSE.md> identifies the text as the MIT License and states “Copyright (c) 2012-2018 Aseem Kishore, and [others].” The permission text requires the copyright and permission notice with copies or substantial portions; it also includes the warranty/liability disclaimer. GitHub API returned this tagged file's blob SHA `2171aca5a833acbc6fb2b402433d8f10ff95c73f`.

The registry record <https://registry.npmjs.org/json5/2.2.3> reports `_id` and version `json5@2.2.3`, `license: MIT`, `gitHead: c3a75242772a5026a49c4017a16d9b3543b62776`, tarball `https://registry.npmjs.org/json5/-/json5-2.2.3.tgz`, and integrity `sha512-XmOWe7eyHYH14cLdVPoyg+GOH3rYX++KpzrylJwSW98t3Nk+U8XOl8FWKOgwtzdb8lXGf6zYwDUzeHMWfxasyg==`. The check pins lockfile version/license/tarball/integrity to this evidence and retains the reported gitHead in the reviewed record. Neither these observations nor the check authenticate the registry artifact against the git commit: no artifact was independently fetched and compared to source. This is documentation of factual evidence, not legal advice or legal approval.

## OpenClaw notice evidence

The packed `THIRD_PARTY_NOTICES.md` reproduces an OpenClaw MIT notice attributing copyright to “OpenClaw Foundation (2026).” GitHub API returned the upstream repository's root `LICENSE` at commit `3ffc75eecb1f2ea29b97602b76b26d58750284ad` (commit verified by GitHub; license blob SHA `ed064819ab537575d0cad902f7e5af4a3488b1d0`): <https://github.com/openclaw/openclaw/blob/3ffc75eecb1f2ea29b97602b76b26d58750284ad/LICENSE>. The returned content identifies itself as the MIT License, carries “Copyright (c) 2026 OpenClaw Foundation,” and includes the standard permission, notice-retention condition and warranty/liability disclaimer. This matches the license and copyright statement in the notice reproduced in this repository. This verifies the recorded content against that upstream source at that commit; it is not legal advice or legal approval.

## Scope and limitations

The check walks dependency and optionalDependency edges from each production dependency. Root manifest ranges must exactly agree with the root lock ranges; each transitive lock edge is accepted only when its declared range is an exact version equal to the resolved lock entry's version. It fails closed on peer dependencies, peer dependency metadata, bundled dependencies, malformed or missing license metadata, aliases and unsupported ranges. It does not audit `peerDependenciesMeta` fields on transitive lock entries: these are treated as ancillary metadata, while any actual nonempty peer dependency map itself fails. Lock metadata shape and consistency are checked; source authenticity and cryptographic retrieval are not proved. Dev dependencies, bundled OpenClaw images, app-owned recipe sources, embedded transitive contents and generated/downloaded binaries are outside scope.

The check compares repository and `packages/clawwright/` copies of `LICENSE`, `LICENSE-MIT`, `LICENSE-APACHE`, and `NOTICE`. `THIRD_PARTY_NOTICES.md` copies intentionally differ in package wording. Release/full-tier CI compares packed notice/license bytes and package manifest with source copies; this verifies archive contents, not license validity or legal clearance.

## Go migration candidate and execution boundary

`npm run license:audit` now invokes the standard-library Go module at `tools/checks/release/license-audit`, with explicit repository and `packages/clawwright` paths, followed by uncached module tests. The source-location default is only suitable for a source checkout; a relocated standalone binary needs explicit paths. Existing CI audit callers and publish verification select the pinned Go 1.26.0 toolchain before this mandatory gate. No package or dependency version changed.

The auditor retains exact reviewed dependency evidence and edge traversal, including required, optional, nested, hoisted and scoped packages. Root/transitive queue entries retain their dependency names, and installed identity is checked before visited-path deduplication. Stable non-regular inputs are rejected before open and rechecked through the opened descriptor. Files are limited to 16 MiB and JSON nesting to 128; duplicate keys, invalid UTF-8 and trailing JSON are rejected. These stricter malformed-input refusals and first-error ordering are not byte-for-byte TypeScript diagnostic parity. Notices are compared as raw bytes. The stat/open race remains, and filesystem stat/open/read operations have no general wall-clock deadline.

Authored regressions include the original adversaries, copied-json5-evidence scoped-name attacks, conflicting identities on an already-visited path, a real writerless FIFO in a finite Unix subprocess, CLI outcomes, the actual npm caller and mandatory workflow ordering/pins. The Unix FIFO fixture explicitly skips unsupported platforms; the remaining suite stays portable. The unchanged superseded TypeScript implementations were inspected and removed from this candidate after parent source review.

An earlier delegated worker violated the source-only restriction by running local formatters and tests before later edits. That violation was disclosed; those results are not acceptance evidence for this candidate. Subsequent correction passes and parent reconciliation were source-only. Final compilation, behavior, cross-platform callers, indexed policy and package/license-byte checks still require public GitHub CI. No complete tooling migration, legal clearance, OpenClaw adoption or production-readiness claim follows.

# Task 258 source-receipts handoff

**Source-only status:** parent commit `d1db890cfdfa865759eb66816d4fb144b972c65a` is published. Tooling CI run `41542591278` passed; main CI run `41542591370` failed. The actual cause is documentation/tables/golden inventory and a Windows `O_NONBLOCK` undefined-platform mismatch, while the new command was absent from inventory snapshots and treated as a target-context unit, while the Windows fixture refused before opening a handle. The fixes are authored, not rerun: **AUTHORED-CI-FIXES-NOT-RERUN**. No Clawwright runtime or paired acceptance is established; the follow-up fixes remain unpublished and pair 260 is unaccepted.

## Final source layout

- `packages/clawwright/runtime/transport/remote/text/{canonical,client,input}.ts`
- `packages/clawwright/recipe-kit/consumer.ts` and `index.ts` (public export)
- `packages/clawwright/commands/orchestration/config.ts` exports `SSJACK_TEXT`; structured `APPLY_CONFIG` is unchanged.

Imports use these destinations. The parent inspected and removed the five task-generated, untracked superseded copies below; none is part of the current runtime:

- `packages/clawwright/runtime/transport/remote/canonical-text.ts`
- `packages/clawwright/runtime/transport/remote/ssjack-text-client.ts`
- `packages/clawwright/runtime/transport/remote/ssjack-text-input.ts`
- `packages/clawwright/recipe-kit/ssjack-text.ts`
- `packages/clawwright/commands/orchestration/ssjack-text.ts`

Parent metadata inspection after removal confirms directory counts: remote 7 (including `text/`), `text` 3, recipe-kit 7, orchestration 7. Source files remain subject to 700 physical lines. The executable layout check has not run. Keep the deleted `tools/checks/runtime/transport/remote/ssjack-text.check.ts` deleted; do not recreate it.

## Receipts and limits

The exact five-path policy overlay is:

- `tools/checks/foundation/packaging/build-output.check.ts`
- `tools/checks/runtime/transport/remote/ssjack-client.check.ts`
- `tools/checks/foundation/core/command/needs.check.ts`
- `tools/checks/completeness/flags-matrix.check.ts`
- `tools/checks/foundation/core/command/spec/effect.check.ts`

The parent reviewed the changed checks and reconciled all five immutable/current Git blob pairs from Git metadata. Historical 79-row transitions and immutable baseline `8eadbd4e8dcfac3d6e11fe5ee49525da5baa3482` remain unchanged.

| Check | Immutable blob | Current reviewed blob |
| --- | --- | --- |
| build-output | `1c5015bc4c6afac4744138357cffbf72376faafc` | `3708a8afdce4fd67c0503b767e0c93e28e1aa5f2` |
| ssjack-client | `3682aaf124ecf03f97e57c128711682c37bb5734` | `a1b3a3c845b31245292acc54ca5b75982a1a78ae` |
| needs | `58bb72512f77f0162b44b71fa72fb4898ad1d05b` | `7b56b335a05c91d45f73a18c628cf57f95dc956f` |
| flags-matrix | `5975223e16394db0843efc9adfc734d05a9591b0` | `b4d0c05ed38e8ba840aa5a4230157ca7d3ab2b4e` |
| effect | `45e1d90304f4b8c1c87986160fbe7a7624d96e64` | `40e76bc2d879a919fe9e5841ff014535f825076f` |

The parent restored the accidentally truncated command catalog from the published `d1db890cfdfa865759eb66816d4fb144b972c65a` bytes, supplied valid required arguments in the effect assertion, and inspected and removed the worker-created untracked `TEMP-deployrow`. Only reviewed source and expected snapshots belong in the candidate. Main CI run `41542591370` failed; Tooling CI run `41542591278` passed for the previous candidate. These follow-up fixes have not been rerun. No general acceptance or full-completion claim is made.

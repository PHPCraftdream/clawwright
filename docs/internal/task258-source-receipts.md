# Task 258 source-receipts handoff

**Source-only status:** parent commit `814e0f431b5b2bae46a1f1a2709eb1d479f86d52` is published. Policy run `41548238463` passed; Main run `41548238464` failed architecture prose (`HeldFlow` 1190 vs 1188; needs +1/client +1), three ad-hoc skips vs zero, and a missing full checkout help block. Per the parent and saved log, other previously failing checks and goldens now passed. The current follow-up edits are limited to `tools/checks/foundation/core/command/needs.check.ts`, `tools/checks/runtime/transport/remote/ssjack-client.check.ts`, `tools/checks/golden/expected/help-checkout.txt`, and this handoff. They are **AUTHORED-NOT-RUN**: scanner counts have not been rerun, and source traces are inferred, not observed execution. No product or pair acceptance is established. Parent publication/review, public CI, and cleanup remain required; no actual Windows cause is confirmed by this run.

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
| ssjack-client | `3682aaf124ecf03f97e57c128711682c37bb5734` | `62b570a4a7d4a1bd65db05c305fcea9a5b3d44cc` |
| needs | `58bb72512f77f0162b44b71fa72fb4898ad1d05b` | `4bf762935e8e8fcbfe6e911bfb6770dd92773876` |
| flags-matrix | `5975223e16394db0843efc9adfc734d05a9591b0` | `b4d0c05ed38e8ba840aa5a4230157ca7d3ab2b4e` |
| effect | `45e1d90304f4b8c1c87986160fbe7a7624d96e64` | `40e76bc2d879a919fe9e5841ff014535f825076f` |

The parent personally reviewed the final check changes and recomputed the client and needs current Git blobs above, reconciling both policy and ledger. Build-output, flags-matrix, effect, the immutable baseline, and the historical 79 rows were not changed in this follow-up. The latest main CI receipt is the failed run 41548238464; these source corrections remain AUTHORED-NOT-RUN until the next public CI result.

The parent restored the accidentally truncated command catalog from the published `d1db890cfdfa865759eb66816d4fb144b972c65a` bytes, supplied valid required arguments in the effect assertion, and inspected and removed the worker-created untracked `TEMP-deployrow`. Only reviewed source and expected snapshots belong in the candidate. Main CI run `41542591370` failed; Tooling CI run `41542591278` passed for the previous candidate. These follow-up fixes have not been rerun. No general acceptance or full-completion claim is made.

# Task 258 source-receipts handoff

**Producer-only acceptance:** producer source commit `275a5221e821a06133cbb25b61ea9164144b06d5` is accepted. Full CI run `41533475792` passed all eight checks; this is a run ID, not a commit. No Clawwright runtime or paired acceptance is established. Clawwright source and tests are authored, not run. Group B is unpublished; pair 260 is unaccepted.

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

The two frozen TypeScript receipt paths are:

- `tools/checks/foundation/packaging/build-output.check.ts`
- `tools/checks/runtime/transport/remote/ssjack-client.check.ts`

The parent reviewed the sources and filled exact current Git blob IDs from Git metadata: build-output `3708a8afdce4fd67c0503b767e0c93e28e1aa5f2`, client check `e4d9a05f9dee8c068183e1f11136e5e3a24bd57b`. Go policy retains the historical 79-row set plus a finite two-path overlay; immutable baseline `8eadbd4e8dcfac3d6e11fe5ee49525da5baa3482` is unchanged. CI selection, packaging, policy and runtime execution still require public CI. No general acceptance or full-completion claim is made.

# Task259 source receipts

Status: **AUTHORED-NOT-RUN**. Parent source review and Git metadata reconciliation do not establish runtime or task260 pair acceptance.

## Connected source path

- Registered `backup-text --file <source> --output <new-local-copy> --profile <expected-profile>` uses only the reverse-capability client and publishes only a complete validated received copy.
- Public `backupText(ctx: RecipeContext, input: BackupTextInput): Promise<BackupTextResult>` exposes the discriminated result through self-contained recipe-kit declarations. Empty and ordinary reverse text is legitimate.
- Supported captured copies restore through existing `deploy-text`/`deployText`, preserving exact immutable references and the existing 32 KiB canonical-template admission. Unsupported empty/ordinary/oversized restore input refuses.
- The reverse request, file, decoded text and complete encoded response limits are 256 KiB, 4096 bytes, 1 MiB and 25,231,360 bytes. One attempt, bounded deadline/cancellation, no raw fallback, no automatic retry after uncertainty.
- Output staging contains only keeper-transformed received text. Exclusive hard-link publication preserves existing destinations; no atomic-network or crash-durability guarantee is made. Backup never rewrites the live source.

## Source review corrections

The parent checked product callers, result validation, public declaration ownership, finite packaging footprint, inventories, docs and golden deltas. The status oracle preserves legitimate withheld results. Exact-cap padding is limited to the reverse-operation response, not initialization. NUL/unpaired-surrogate/decoded limits and late deadline/cancellation checks precede copied-text return; Unicode/BOM controls remain.

The parent additionally changed the cap-plus-one negative to a complete otherwise valid JSON-RPC received response padded to exactly 25,231,361 bytes. Without size enforcement, it would be accepted rather than fail JSON parsing. The malformed/lost/failed-response loop now asserts the entire `{ status: "unknown" }` result, so leaked copied-text fields fail the check. The client check remains 699 physical lines. All regression cases and manually authored snapshots require public CI execution.

## Reviewed current Git blobs

The immutable baseline `8eadbd4e8dcfac3d6e11fe5ee49525da5baa3482`, historical 79 rows and exact five-path overlay are unchanged. The parent computed these current blobs from the reviewed source; no new path exemption is introduced:

| Check | Current reviewed blob |
| --- | --- |
| build-output | `9ce91f164e78fdb8e03df66b10e68b776a1a6d1a` |
| ssjack-client | `cbda75d7282c92bf1959fd7b42eac73d5ea1fa0d` |
| needs (unchanged) | `4bf762935e8e8fcbfe6e911bfb6770dd92773876` |
| flags-matrix | `9679640e21f664647bced89dec3223044dd8485f` |
| effect | `c7a5c6ee881dc86e7be5fa5c7f53f069fa40ec63` |

The source feature changes cover 20 paths; parent receipt metadata adds `tools/tooling-policy/transitions.go`. Dependency/project versions and toolchains are unchanged. The packaging Node-free guard remains active, including explicit backup API assertions and only the finite output/type footprint additions.

## CI follow-up (parent report)

Parent published `48c5e693b5b36b0069c6dcee21f089ceade00791`. Parent reports policy `41560045826` passed and main `41560045734` failed on all four platforms. Build-output rose from 1 to 4; client from 0 to 1. The client failure is an exit-code assertion. Parent already corrected the expected `undefined`; keep that correction.

Packaging follow-up oracles tokenize full `.d.ts` declarations, signature, required fields, discriminated union and index export, retaining the Node-free guard and historical parity. The client expects immutable `boundaryText`, not mutable server-fixture `copyText`, retaining the poison fixture and existing-file preservation. Source inference: nested `copyText` assignments carried `wrong response` into the previous expected operand.

The parent personally reviewed these source changes and recomputed the packaging/client receipts in the table above; the other three current receipts remain unchanged. No local scanner/tests were run and no new count is claimed as passing. This source-only note remains **AUTHORED-NOT-RUN**; task260 is separate.


Accepted prerequisites are Clawwright e38a144 (full 41551188014, scoped 41550824328, policy 41550824331) and ssjack 2562a31 (full 41550023896, feature 41549571973). These receipts do not validate this candidate. Its synthetic HTTPS fixtures do not establish the actual producer/client pair. Parent public scoped/full CI, actual failure fixes, accepted cleanup and later task260 joint acceptance remain required. No local test, compiler, formatter, generator or application execution was performed.

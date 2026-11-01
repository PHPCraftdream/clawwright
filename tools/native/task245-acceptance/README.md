# Task 245 native supervisor acceptance

## Source scope (not execution evidence)

This Linux/amd64 worktree contains an authorized conductor-only overlay: an exact-entry change to the acceptance workflow plus additive composed-lab test source. The pinned CLI, keeper, driver, harness, and crypto sources remain unchanged. The product `syntheticdriver` executable is not byte-for-byte the unmodified product build: existing `run.py` lines 42–44 zero ELF64 header bytes 40–47 (`e_shoff`) and 58–63 (`e_shentsize`, `e_shnum`, `e_shstrndx`). This removes section-header metadata; it does not modify executable load segments or instructions. The transformation is retained for the existing laboratory syntheticdriver compatibility path. Its runtime compatibility is unverified. No new product overlay is added. No commands were run for this update and no runtime, test, build, or CI result is claimed.

The optional workflow describes connected/confinement coverage plus five negative scenarios. The root `LabScenario` hooks are intended to act only after actual native capture: suppress or truncate keeper ACKs, with refusal evidence for a real wrong-writer or denied-exec case before readiness. Typed outcomes are asserted through the unchanged pinned harness. Full-held is a per-send source fact. The newly authored conductor verifies revoked typed refusal and unchanged actual state, receipt, and fault markers; it does not synthesize outcomes. These are authored expectations, not runtime evidence. The composed matrix is authored and source-connected, but all cases are **NOT RUN**; mediation security and runtime behavior are not accepted.

The authored `metadata_test.c` regression includes the actual `metadata.c` owning `release_ack` implementation. Test-only descriptor invalidation induces real kernel EBADF failures for ACK write, fsync and close; assertions require failure despite cleanup-caused absence while the owner remains alive. Positive coverage observes the real seven-byte ACK before removing it. Refusal cases cover mismatched receipt, invalid cancellation input, missing/wrong fault evidence, mismatched owner parent and an unchanged pre-existing ACK. This is **NOT RUN**; it does not exercise the complete seccomp-notification/snapshot/`owner_capture` pipeline or replace composed keeper acceptance.

Direct kernel tests use synthetic bindings and are distinct from the real CLI/keeper composed path. The direct test set contains eight cases; they do not establish completion of the composed negatives.

## Bounded metadata and cancellation mediation

Cancellation is mediated in source, not **BLOCKED**. The disposable root daemon serves bounded actual-metadata snapshots through seccomp-notify: it reads fixed state/receipt metadata and a sealed-memfd snapshot, validates exactly seven bytes of cancellation input, and releases the notification only after checking the current receipt and native-fault evidence. No directory writes, arbitrary paths, payload access, or authority are granted. The daemon uses only existing capabilities and performs no host installation. Client authentication is `SO_PEERCRED` plus executable inode; serviced tasks are checked against actual TGID. Landlock remains read-only for `/lab/bin`. Notification-ID races remain a limitation; the authored harness correlates actual state and verifies it unchanged, with no synthetic outcomes.

The direct-kernel test set contains eight cases, separate from the composed path; it does not establish composed completion. All composed matrix cases and mediation security/runtime remain **NOT RUN**, not accepted.

No readiness, adoption, completion, passing-negative, or execution claim is made. The source describes intended checks only.

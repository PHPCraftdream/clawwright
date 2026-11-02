# Task 245 native supervisor acceptance

## Source scope (not execution evidence)

The pinned product checkout, exact commit/base, input constraints, disposable image/capability limits, and no-secret/no-new-privilege boundary remain unchanged. The pinned external product `scripts/lab/delivery_pty.py` is retained as a non-Go helper. The Go probe uses safe child execution (`os/exec`), not bare fork. The task #249 invariants remain retained. This update claims no PASS, acceptance, or completed migration.

## Current Go service implementation

The current publisher is `internal/service` in Go, not the historical Python `service.py`/`Popen` implementation retained in Git at `04f1d80`. It owns children through `exec.Cmd`, tracks `/proc` start time, waits/reaps, and validates the actual service executable, inode/hash, listening SOCK_SEQPACKET endpoint and owned kernel FD before publishing the root-owned canonical proof. Go clients check the protected record and endpoint identities, peer PID/UID and proc start time. Historical `service.py` descriptions and evidence refer to the earlier implementation only; they are not evidence about the current Go publisher. The root proof conveys identity, not delivery authority.

The profile's active/inactive preflights, actual-binary and kernel regression sources remain authored source-only coverage. No commands, builds, tests, CI, or acceptance were run for this update. The pinned product CLI, keeper, driver, harness and crypto sources remain unchanged; runtime compatibility is unverified. Earlier parent-reported CI/evidence in this README is explicitly historical and does not establish current Go behavior or acceptance.

The disposable profile retains `apparmor=unconfined`; this is not a host policy. Docker seccomp uses exact capabilities, no host binds, no network, and no-new-privileges; the inner fixture uses Landlock. ELF compatibility zeros exactly byte ranges 40–47 and 58–63, validating ELF64 little-endian x86_64; no other ELF patches are made.

## Task 250 source-only handoff

Task 250 source mapping: `run.py` → `cmd/acceptance`; `profile.py` → `cmd/profile`; `service.py` and `service_test.py` → `internal/service`; `gateway.c` → `fixtures/gateway`; `release_fixture.c` → `fixtures/release`; `probe.c` → `../task245-control-profile/cmd/control-probe`. The seven superseded sources were removed after parent review; their originals remain in Git at `04f1d80`. Replacement execution and acceptance still require public CI. The pinned external `scripts/lab/delivery_pty.py` is retained. Existing Rust fallback paths are unchanged; no new Rust exceptions are introduced.

Source-authored broker lifecycle kernel coverage includes a real socket receive timeout producing EAGAIN, then explicit nonblocking (`MSG_DONTWAIT`) polling without a read goroutine. The five-second receive timeout is cleared in production; cleanup waits under the same 60-second deadline. The source coverage includes getsockopt confirming zero timeout, child-alive check, cancellation and child reaping. A timeout is not proof of reaping. Natural EOF and unexpected data are refusal cases. These are source descriptions, not execution results.

This is source-only and NOT RUN; there is no CI evidence for acceptance. Parent removed the accidental nested path; current tree contains no such path. Parent-reviewed legacy removal is source migration, not runtime evidence. The separately pinned external Python ceremony helper is still retained; this is not an all-Go repository claim. The tooling-policy baseline remains immutable; no reset or exemption is claimed. No PASS or source-as-acceptance claim is made. No private workstation paths are included.

## Follow-up source notes (NOT RUN)

The gateway provider inherits stderr through `os.Stderr`; it does not redirect stderr to `/dev/null` or require device mounts. `Start` and `StartDaemon` share `startOwned`, which starts the child and immediately establishes the sole `Wait` owner; startup cleanup has a fixed two-second budget matching the current `Stop` budget. Start failure directly handles the owned process; kill refusal or reap timeout retains the child and receipt and does not claim cleanup.

Source coverage records actual self-exec `EBADF`, capture/refusal under container `EPERM` without `CAP_KILL`, and EOF release/reaping. The receipt gate is bounded. The broker remains the sole helper waiter; after a valid timeout transition, an actual unconnected seqpacket produces `ENOTCONN`. These are source claims only, not proof of actual keeper outputs. The adoption-claim guard checks adoption claims only; ceremony checks are retained and do not prove keeper outputs. Tests NOT RUN; parent public CI is required.

Publisher parity source changes restore the protected /run/task245-lab ancestor and retain read-only /lab/bin validation. Canonical marker, socket, auth-directory and published-record modes use full raw 07777 comparisons; final publication revalidates socket type, UID and full mode before dev/inode. CheckServices authors owning refusal, restoration and positive cases before the existing real-client cases. These changes are NOT RUN; parent public CI remains required.

## Bounded diagnostics source coverage (NOT RUN)

The diagnostics tests require the actual regular checkpoint file to have UID 65534, full mode 0600, link count 1 and size 1–128 bytes. Binary codes are restricted to 1–32 and the final checkpoint field to 48. Captures are bounded to 4 KiB total, with finite reconstructed numeric/enum lines emitted only on failure. Raw conductor text and current metadata error text are not forwarded; finite conductor event/exit and metadata stderr-presence summaries replace unbounded text, while numeric legacy metadata records are still strictly filtered. The outer path always obtains container state after start and retains failure for any stderr, nonzero exit, or error.

The source workflow selects these tests in the pure Go suite, and runs the root-only checkpoint suite separately in the existing sudo environment. This is future parent public CI only and was NOT RUN here. Diagnostics are not cause/adoption proof.

Direct-kernel release-test failure stdout is bounded and filtered to finite canonical `kernelFailure245` labels from known Go test frames only; raw fixture, helper, and CLI output is never forwarded. `kernel=<label>` is forwarded through the same outer-failure filter. Success remains silent, and either a nonzero exit or stderr remains failure. All eight kernel cases and their actual protocol assertions are unchanged. The exact actual hyphenated label is preserved, unlike legacy regex truncation. Authored diagnostic/profile/outer tests are selected by the existing diagnostics/profile/runner workflow commands; no workflow edit is needed. This is source-only, NOT RUN, and is not acceptance, cause proof, or adoption proof.

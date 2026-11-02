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

Direct-kernel release-test failure stdout is bounded and filtered to finite canonical `kernelFailure245` labels from known Go test frames only; raw fixture, helper, and CLI output is never forwarded. `kernel=<label>` is forwarded through the same outer-failure filter. Success remains silent, and either a nonzero exit or stderr remains failure. All eight kernel cases and their actual protocol assertions are unchanged. The exact actual hyphenated label is preserved, unlike legacy regex truncation. Authored diagnostic/profile/outer tests are selected by the existing diagnostics/profile/runner workflow commands; no workflow edit is needed. This is not acceptance, cause proof, or adoption proof.

## Task 250 public-composition follow-up (source-only; NOT RUN)

Authorized log run `41395624886` on `8d0b32d` recorded a connected generic app failure with no inner-stage result. Five negative cases reached checkpoint 24 through stages 1–3, then stage 4; the lost-ack child reported 101 and the other four reported 255. The log contains a failure excerpt only. Confinement/source success is parent-reported and is not established by that log. Earlier component CI `41395542057` success and policy/feature success are also parent-reported; neither changes the published migration evidence nor establishes this current, unexecuted follow-up.

Cause remains undetermined: worker exit cannot be distinguished from peer EOF or context stop. Worker exit 101 marks startGateway, not proof of cause; 255 may reflect a signaled wait and is not a generic diagnosis. Current changes add finite profile-stage and broker-wait-kind, signal, lifecycle-reason and errno diagnostics for the next public run; they do not claim a cause fix. Owning source-authored tests and the next CI run remain required. Readback NOT RUN.

## Task 250 startup diagnostics follow-up (source-only; NOT RUN)

The source workflow additionally selects TestStartupDiagnostics and TestStartGatewayDiagnosticsFailures from ./task245-native-supervisor. Existing kernel cases and deadlines are unchanged. Current finite service code/role/case and worker startup stage/errno diagnostics are authored for the next parent public run, not execution evidence.

Run `41397094959` on `17d9a45f` reports connected `stage=service_preflight`. Wrong-holder reports worker wait exit 101; the other four negatives report peer EOF followed by SIGKILL 9. Cleanup is a possible source of that signal, not an established initiating cause. No intended scenario outcome or root cause is established. These follow-up changes are NOT RUN.

## Task 250 connected preflight and Rust startup refusal follow-up (source-only; NOT RUN)

Run `41399012497` records a connected `preflight-not-fresh` failure. The freshness refusal is observed, but the stale filesystem path is not named by the log. Source review found that `publishKernelProof` used `MkdirAll` for `/run/task245-services`, removing proof but not the directory. The new profile uses exclusive, owned acquisition and same-inode empty-directory cleanup to restore freshness without waiving the guard. This is source coverage, not execution evidence.

Rust worker stdio deliberately remains null on fd 0–2. The ineffective stderr-only diagnostic is replaced by a fixed 64-byte correlated startup-refusal message sent on the existing seqpacket control channel before `SSRDY`. Its finite 13-value enum and errno convey startup refusal only; the message is never readiness, a fault, or a secret grant. A source integration test authors coverage for actual Rust with suppressed stdio. It was NOT RUN; the next parent CI run is required. No claim is made that this explains the known gateway failure.

No commands, tests, or execution were run for this update. No raw log or private paths are included; no PASS or acceptance is claimed.

## Task 250 Rust startup refusal transport correction (source-only; NOT RUN)

The Go worker under the Rust bootstrap sends a fixed 64-byte `OCSTART1` message over fd 4, which the consumer parses. The pinned product deliberately discards consumer stderr (as observed by the parent), so the consumer instead writes a fixed 12-byte `OCSF0001` stage/errno record to an owned synthetic file. The root profile's `ReportLabFailure` reads, validates, and reconstructs that record into the existing `ReportFailure` filter; the actual outer `applicationResult` is filtered as `ContainerFailure`. Rust and pinned product sources are unchanged. An `io.Discard` consumer-subprocess regression is authored but NOT RUN. Initiating cause remains unresolved; no acceptance is claimed.

## Task 250 constructor evidence follow-up (source-only; NOT RUN)

Authorized log `41410639372` records `connected`, `lost-ack`, and `wrong-holder` as ceremony failures with `startup=tracker errno=0`; `partial-ack`, `unexpected-exec`, and `cancel` have no startup record. The `connected` case progressed past `service_preflight` to ceremony. EOF and SIGKILL are cleanup observations, not established initiating causes. Parent source information indicates the constructor collapses failures to errno 0; no EPERM is assumed. Current source changes add closed constructor stages and wrapped errno through the already-proven 64-byte/12-byte path. No framing, authority, or custody changes are made, and no source-proven runtime fix is claimed. Missing-PID and real second-seize regressions plus pipeline subtype coverage are authored but NOT RUN; parent public CI is required. No acceptance is claimed.


## Task 250 init-to-tracker evidence follow-up (source-only; NOT RUN)

Log `41413183671` records `connected` and `unexpected-exec` with tracker `seize` returning `EPERM`; `lost-ack` records tracker `wait` returning `ECHILD` (10). This is not proof of a live process or of the cause. Init source waits for the specific worker, not `waitany`. The stdio fd contract does not reject null on fds 0–2. No source-proven bootstrap fix is claimed.

A regression is authored for actual init → non-root Go → exact stub → guarded tracker using read-only root and valid root-owned executable fixtures. It observes the role-exec guard, then performs finite cleanup. It is NOT RUN.

Finite pre-supervisor-kill nonblocking-wait correlation now distinguishes pending, exit 111, exited, signaled, no child, and observe error subtype, retaining constructor errno through the existing path. Post-constructor cleanup may affect the wait case and therefore does not prove cause. No Rust or product changes were made. No acceptance is claimed until parent CI.

## Task 250 FD 6 startup lifetime follow-up (source-only; NOT RUN)

Source review confirms Rust `main.rs` clears `FD_CLOEXEC` on descriptors 3, 4 and 6 before exec; the Go worker previously deferred closing its fd-6 `os.File` until after `startGatewayControl`. The stub rejects descriptors above 5, while Go `ForkExec` does not generally close unrelated inherited descriptors lacking CLOEXEC. The baseline namespace helper consumes and closes metadata before gateway launch, so it does not cover this retained-fd interval. The Go reader now closes fd 6 after complete read and before later opens. The retained-metadata actual-init regression checks the fd remains valid/CLOEXEC-clear through namespace validation, invokes the production reader and checks immediate EBADF, then starts the tracker and actual stub. It approximates allocation ordering with image hashing, control nonblocking/deadline setup, and the production-path listener; it does not execute the production worker's complete JSON validation or startup guards.

Authorized log `41416118422` records partial-ack and cancel at `tracker_seize_exit111 errno=1`; the other four ceremony failures have no startup record. This is not proof of an initiating cause. No commands, builds, tests or runtime branch were run for this update; the runtime v14 cause remains unproven. No acceptance is claimed.

## Task 250 v15 metadata inherited-pipe follow-up (source-only; NOT RUN)

Parent reports integration `3d6fbd86` and native, policy and feature runs `41419372666`, `41419372729` and `41419372728` SUCCESS; manual run `41419417573` reports source/confinement and intended `unexpected-exec` success, with five failures remaining. Authorized `ci-v15` log directly read at top level records five peer-EOF plus SIGKILL-9 cleanup outcomes, no startup-refusal records, and does not prove all startup succeeded. Source mismatch: nativeprovider `main` calls `SetReadDeadline` directly on exec-inherited `os.Stdin` (old line 69), while gateway fixture lines 107–117 passes an `os.Pipe` via `cmd.Stdin`. The keeper precedent uses an owned nonblocking duplicate. This establishes a source mismatch, not the actual v15 initiating cause.

The provider now reads metadata through a shared reader, using a CLOEXEC duplicate made nonblocking before `NewFile`, with finite context-bounded reads and retained metadata size/schema checks; existing authentication is unchanged. The duplicate shares input open-file status flags, so `O_NONBLOCK` also affects the original read end; original fd 0 remains open, and the separate broker write end is unaffected. No custody or output changes are made. Inherited-pipe subprocess regressions are authored but NOT RUN. The direct-release fixture's custom provider speaks the wire protocol directly and bypasses the real nativeprovider entry. Helper regression scope is not full-run, policy or auth coverage; the v14 metadata-helper regression callsite limitation remains, and the actual manual production matrix is e2e callsite evidence only. The timer-based cancellation case does not deterministically establish interruption of an already-blocked read; it may exercise cancellation before helper entry. No generic diagnosis or runtime proof is claimed; acceptance is not established.

# Disposable-lab control profile

Linux/amd64 laboratory component, not a production service or OpenClaw adoption proof. Public push/PR CI runs disposable component containers; the complete keeper-composed laboratory remains a separate manual job and is not accepted. No host sudo, setuid installation, existing guest changes or production provisioning is involved.

## Implementation boundary

- `cmd/control-profile`: Go argument/environment validation and root-service proof client.
- `installer`: dependency-free Rust single-task pre-exec boundary. Go runtime threads cannot safely own this process-wide transition. It reserves sealed persistent FD1023, transfers the real seccomp listener, applies Landlock and the control filter, and execs the fixed harness.
- `cmd/native-metadata` and `internal/metadata`: Go notifier service, bounded nonsecret snapshots, caller/owner correlation and daemon-private cancellation handling.
- `cmd/metadata-regression` and `internal/regression`: owning syscall-error and actual-binary/kernel regressions.
- `internal/proof`: canonical root-service proof parsing and client authentication.

The superseded `control-profile.c`, `metadata.c`, `metadata_client.c`, `metadata.h` and `metadata_test.c` remain available in Git at `c85aa1a`. `probe.c` remains an unchanged protocol fixture for the subsequent fixture migration. The component root has five immediate entries; new implementation files remain within 700 physical lines and nested directories within seven entries. These constraints do not mean the repository-wide tooling migration is complete.

## Identity, confinement and authority

The external laboratory route remains CLI/keeper to fixed consumer, root broker, launch-owning native supervisor and fixed provider. Keeper supplies finite human-authorized per-write grants; root-service metadata, hashes, UID, receipts and immutable artifacts identify components but never approve secret delivery. Payload does not pass through the root broker. Provider OC-PIPE-ACK is a write receipt, not gateway adoption or authentication proof.

The control profile grants read/execute access only to immutable read-only `/lab/bin`. Landlock ABI v3 and selected Linux/amd64 seccomp rules block `/proc` access, AF_UNIX/SCM bypasses, namespace changes and process-memory access after installation. Ordinary allowed descriptors and inherited filters remain usable across the tested process/image transitions. Root compromise, same-UID trust and trusted-runtime/kernel limitations remain outside this component's guarantees.

The unchanged `service.py` publisher independently verifies its actual root process, executable inode/hash, proc start time, listening SOCK_SEQPACKET endpoint and owned kernel FD before publishing a root-owned canonical proof. Go clients verify protected directories/record, expected artifact/socket identities, peer PID/UID and proc start time without dereferencing the root process's executable. The Go regression publisher is a separate fixture, not a replacement for that Python publisher or proof of full composition.

Regression launchers distinguish an absent socket, an authenticated bound-but-not-listening endpoint and a ready listener. PID/start, pinned socket inode, ownership, endpoint state and owned descriptor checks precede the unchanged strict publisher. A socket pathname alone is not readiness.

## Cancellation and finite lifecycle

FD1023 remains a sealed non-authoritative reservation in the client. Cancellation bytes stay in the daemon-private slot. That writable slot uses `SEAL_SEAL | SEAL_SHRINK | SEAL_GROW` (mask7); the separate client reservation retains all seals (mask15). Write/fsync/close failure returns EIO even if cleanup removes the ACK. Receipt/fault/owner correlation, pre-existing ACK refusal and truthful failure remain mandatory.

The shipped service budget is 600 seconds; fixed root/CI-only two-second modes exercise no-client, incomplete-handoff and idle-listener expiration. Nonblocking receipt/ACK read opens reject writerless FIFO replacement rather than blocking outside deadline checks. Owned-child cleanup checks PID/start and propagates Kill refusal instead of waiting unconditionally. Only the disposable metadata kernel container receives CAP_KILL for its cross-UID cancellation child; a separate container without that capability requires actual EPERM, retained child liveness, EOF release and reaping. Host and confinement-container policies are unchanged.

The installer transfers its listener and closes its local copy; the daemon has one receive loop. Linux v6.8 [seccomp source](https://raw.githubusercontent.com/torvalds/linux/v6.8/kernel/seccomp.c) explains how a canceled request can leave a count consumed by receive and yield ENOENT. This is not a general multi-reader or all-kernel proof. The actual cancellation test gates the daemon after poll readiness, kills/reaps the filtered holder, and requires real receive ENOENT followed by normal shutdown.

## Executed public evidence

At `b66ff07537e4532e57d1671c40745cd928d1119c`, native CI `41368394895` passed twice on the same SHA; policy `41368394892` and feature `41368394902` also passed. The daemon-slot mask repair restored the original writable-slot contract. Earlier cross-UID Kill failure was reproduced as EPERM in a real refusal fixture and no longer hides behind an unconditional Wait.

At readiness repair `d1dbe1235f014569a40f66107e9797307b9ad108`, native `41370462077`, policy `41370462147` and feature `41370462118` passed. The new pipe-gated kernel fixture enters the full waiter while the real socket remains bound, rejects premature readiness/publication, then permits Listen and requires exact publication. Wrong-process/socket and pre-listen death/reaping cases also ran. This establishes the repaired readiness contract, not the unrecorded exact cause of an earlier intermittent inactive failure.

Executed component coverage includes Rust parser/filter/ABI tests, Go proof refusals, owning ACK positives and real syscall faults, deterministic ACK publication/replacement/error cases, finite lifetime and canceled-notification cases, service-proof negatives and forged-listener/wrong-caller cases, distinct same-image/different-TGID and same-PID/different-image witnesses, FD1023 protection, active/inactive cancellation, FIFO receipt refusal and the golden confinement probe. Feature CI was diff-scoped, not an explicit full sprint gate. The full keeper-composed job was skipped.

CI recorded Linux `7.0.0-1017-azure`, Rust/Cargo `1.99.1` and target `x86_64-unknown-linux-gnu`; Go remains `1.26.0`. No local build/test or toolchain upgrade occurred. Shipped Rust uses edition2021, optimization2, static CRT and panic abort; test harnesses unwind. Unsafe ABI/pointer lifetime/alignment boundaries were source-reviewed and kernel-tested, not formally proven; Miri does not prove these raw kernel transitions. No external Rust dependency graph was introduced.

Tooling policy retains immutable baseline `8eadbd4e8dcfac3d6e11fe5ee49525da5baa3482`, seven exact Rust fallback paths, and exact baseline-derived runner/profile transformations. Its real CLI/Git tests and index audit passed. Remaining C/Python and TypeScript helper debt stays explicit; application/runtime relocation is separate.

Diagnostics emit only finite stage/event/class codes and bounded errno/exit/signal values. Arbitrary error text and child stderr are filtered; payload, bootstrap values, raw PTY/CLI output and private configuration are not diagnostic channels. Component success does not establish full keeper composition, actual OpenClaw authentication, production readiness or permission for deployment.

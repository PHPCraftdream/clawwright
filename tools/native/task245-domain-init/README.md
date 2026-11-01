# Task 245 Rust domain-init fallback

## Scope and status

`main.rs` is a Linux x86_64 fallback for the domain initialization boundary. Rust is narrowly used where the lifecycle crosses raw `fork`, namespace syscalls and post-fork execution; this is not a language preference or general migration. `init.c` remains the parent-reviewed reference and may be removed only with parent review. There is no Cargo manifest, crate dependency, or C shim source in this component. Standard-library parsing, environment and task enumeration occur before the first fork. The program does not spawn threads. After fork, it uses fixed buffers and raw syscalls only; it does not enter Go or Rust runtime operations. Child termination uses raw exit syscalls rather than Rust cleanup.

## Input, FD inventory and binding

The init requires exactly three arguments (program plus decimal nonzero UID and GID, no leading zeroes), an empty environment, root real/effective UID, matching PID/TID, a single `/proc/self/task` entry, and validated inherited FDs. FD 3 is a sealed root-owned regular image mode 0555; FD 4 is a `SOCK_SEQPACKET` control socket; FD 5 is a root-owned, non-group/world-writable, read-only directory root; FD 6 is a sealed root-owned regular metadata file mode 0444. FDs 3, 4, and 6 have close-on-exec cleared for handoff; all descriptors >=7 are closed, with an upper bound of 1,048,576 from `RLIMIT_NOFILE`; if the limit is infinity, initialization fails closed (stricter than the Go caller's limit handling). Required memfd seals are all four bits (`0xf`). The image and metadata FD seals, ownership and modes are checked. No FD 5 path is used after it is closed.

The launch caller in `tools/native/task245-lab-broker/launch_linux.go` supplies the process arguments and descriptor roles; metadata is passed as an already-prepared sealed FD, not parsed by this init. The source validates descriptor properties, not a manifest/hash binding itself. Do not infer immutable byte identity from the FD checks alone. The child executes the image by `execveat(3, "", ..., AT_EMPTY_PATH)`.

## Lifecycle ordering

The init first establishes parent-death guards, opens `/dev/null`, changes cwd to FD 5, chroots to that directory, changes cwd to `/`, and closes FD 5 **before** `unshare(CLONE_NEWNS | CLONE_NEWNET | CLONE_NEWPID)`. It makes `/` recursively private and forks PID-namespace init. PID 1 mounts read-only proc with `nosuid,nodev,noexec` and `hidepid=0`, and `/run` as `tmpfs` with `nosuid,nodev,noexec`, mode 0700, size 1m and the configured UID/GID. PID 1 then clears supplementary groups and sets all real/effective/saved GIDs and UIDs to configured nonzero IDs before forking worker PID 2. PID 2 verifies parent-death guard, PID/parent IDs, dropped IDs and empty supplementary groups, redirects standard streams to `/dev/null`, sets `no_new_privs` and non-dumpable, then executes the sealed image. Both parent branches close image/control/metadata and `/dev/null` as applicable and propagate child status.

## Build, CI and limits

Existing `.github/workflows/native-supervisor.yml` builds/tests with direct `rustc`: `x86_64-unknown-linux-gnu`, edition 2021, optimization level 2, panic abort, static CRT. The authored test harness uses panic unwinding; `-C panic=abort` applies only to shipped builds. The workflow compiles the remaining out-of-scope C components, not the superseded `init.c` stub. Public-kernel `TestDomainInit` tests are authored gates, not evidence until CI passes. `main.rs` reports an exact numeric checkpoint and restores the most recent raw-syscall errno for diagnostics. On refusal, it captures the raw negative syscall result immediately, then performs a bounded raw write of at most 64 bytes with at most 64 attempts; it does not emit arbitrary logs. Numeric diagnostic formatting and actual-binary refusal regressions are authored; runtime evidence remains pending public CI. No tests/builds were run locally; CI is pending.

## Acceptance boundary

Task #245 remains unaccepted. The latest acceptance matrix `41335351818` failed with child exit **255** (not issue #255): broker receive timed out after 5 seconds and propagated to EOF. The monitor's `EAGAIN` fatal path is a separate, unfixed finding; other leaf work remains pending. Neither the runner's authored Rust build wiring nor workflows establish runtime acceptance or adoption. Do not claim adoption, completion, or verified namespace security from source or workflow definitions.

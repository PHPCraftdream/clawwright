# Native namespace bootstrap

## Why this component uses Rust

The bootstrap is a dependency-free Linux/amd64 Rust fallback for a single-task raw-fork/pre-exec boundary. Standard-library argument/environment preparation and task enumeration occur before the first fork. Post-fork branches use fixed buffers and raw syscalls, not Go runtime operations or Rust runtime cleanup. The former C implementation remains only in Git history at baseline `8eadbd4e8dcfac3d6e11fe5ee49525da5baa3482`. There is no authored C shim, Cargo manifest or external crate.

## Descriptors and lifecycle

The caller supplies decimal nonzero UID/GID, empty environment and root real/effective UID. The bootstrap verifies matching PID/TID and a single task. FD 3 is a sealed root-owned regular image mode 0555; FD 4 is a `SOCK_SEQPACKET` channel; FD 5 is a root-owned non-writable readonly directory root; FD 6 is sealed root-owned regular metadata mode 0444. Required seals are `0xf`. Other descriptors are closed up to the finite `RLIMIT_NOFILE`, capped at 1048576; infinity is refused. Descriptor properties alone are not a manifest/hash check: authenticated broker construction supplies that separate binding.

It arms parent-death protection, opens `/dev/null`, establishes the verified chroot/cwd and closes FD 5 **before** unsharing mount/network/PID namespaces. Linux remaps current root/cwd during namespace copying, but an inherited directory FD would still refer to the old mount. The new root is recursively private.

PID 1 mounts readonly proc with `nosuid,nodev,noexec,hidepid=0`, plus `/run` tmpfs with `nosuid,nodev,noexec`, mode 0700, size 1m and configured ownership. It clears supplementary groups, sets all GIDs/UIDs, then forks worker PID 2. The worker checks ancestry, IDs/groups and parent-death protection, redirects standard streams to null, sets `no_new_privs` and non-dumpable, then executes sealed FD 3. Parent branches close their copies and propagate child status without runtime cleanup after fork.

Refusals emit only a fixed numeric checkpoint and the most recent raw negative-syscall errno. Formatting and writes use bounded buffers/attempts; no payload, environment, argv or arbitrary error text is logged. Metadata and diagnostics never grant secret authority.

## Verification and remaining limits

At commit `cc14a1098dc2d3da0ad47862af20c8478578c40c`, public supervisor CI `41347987327` passed Rust unit/ABI/diagnostic tests and actual-bootstrap kernel cases twice: positive launch, parent death, invalid IDs, unsealed image/metadata, wrong control type, writable root/mode and invalid image mode. Kernel checks observe fresh namespace identities, IDs/groups, sealed-image identity and mount restrictions. Admission CI `41347987407`, tooling-policy CI `41347987309` and feature CI `41347987344` also passed.

CI recorded `rustc 1.99.1`, Cargo `1.99.1`, target `x86_64-unknown-linux-gnu`, with edition 2021, optimization level 2, panic abort and static CRT for shipped builds. Test harnesses unwind. No compiler was installed or version changed; the runner compiler is recorded rather than repository-pinned.

Raw syscall `unsafe` boundaries still require manual selected-ABI/pointer/lifetime review; Miri does not prove these transitions. No local builds or tests were run. Full keeper-composed task #245 remains unaccepted; its broker lifecycle-timeout defect is separate. Neither these component tests nor metadata receipts prove application adoption or production readiness.

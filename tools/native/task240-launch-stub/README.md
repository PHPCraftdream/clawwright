# Task 240 Rust launch-stub fallback

## Scope and status

`main.rs`, `linux.rs`, and `packet.rs` are a Linux x86_64 fallback implementation of the narrow launch-stub boundary, not a general Rust migration or language preference. It confines the kernel-side transition to one task (`getpid == gettid` and exactly one `/proc/self/task` entry), validates inherited launch descriptors and packet, waits for its supervisor gate, installs seccomp, then attempts `execveat` from FD 3. `stub.c` is retained as the parent-reviewed reference; removal requires parent review. There is no Cargo manifest, crate dependency, or C shim source in this component.

Rust standard library operations are used before the post-fork boundary (in this component, there is no fork). The `CHECK_INHERITED_FDS` init-array constructor uses `fcntl` checks on FDs 0–5 and refuses missing descriptors; it does not initialize FDs 0–2. The fallback does not spawn threads. No authored C shim is present. `extern "C"` is the init-array constructor ABI, not a seccomp callback; the seccomp filter is installed with raw `prctl` syscalls. After the gate, syscall operations are raw Linux x86_64 `syscall` assembly; no Go runtime is entered in this boundary. The production caller in `task245-native-supervisor/worker_linux_amd64.go` starts the stub with empty environment and inherited FDs 3–5, writes the packet and opens the gate only after trace tracking is established. CI evidence is pending.

## Build and limits

Existing `native-supervisor.yml` builds and tests directly with `rustc`, target `x86_64-unknown-linux-gnu`, `--edition=2021`, `-C opt-level=2`, `-C panic=abort`, and `-C target-feature=+crt-static`. CI records the installed `rustc --version --verbose`, Cargo version and active toolchain; no compiler version is pinned here. Policy limits are at most 7 immediate entries and 700 physical lines per implementation file. No local tests or builds were run for this update; CI is pending.

## Inherited descriptors and packet contract

The stub requires exactly FDs 0–5, with no additional descriptors: FD 3 is a root-owned regular executable, single-link, executable, and not group/world writable; FDs 4 and 5 are read-only FIFOs; descriptors 0–2 are present and no descriptor target may contain `io_uring`. FD 3 is made close-on-exec. FD 5 carries the packet; FD 4 carries the gate: exactly byte `0xa5`, followed by EOF. These source checks inspect each incremental prefix read, and a valid frame awaits EOF; retained-writer and EOF kernel regressions are authored, not run.

Packet format is `OCARGV01`, big-endian u32 argument count, length-prefixed UTF-8 arguments, big-endian u32 environment count and length-prefixed UTF-8 `KEY=value` entries; embedded NULs and trailing bytes are rejected. Limits: total packet 4096 bytes, 1–16 arguments, each 1–1024 bytes, aggregate argv storage including terminators 3072 bytes; 0–2 environment entries, each 3–768 bytes, aggregate env storage including terminators 1024 bytes. Only `OPENCLAW_CONFIG_PATH` and `CLAWWRIGHT_NATIVE_SOCKET` are allowed; duplicate keys are rejected.

## Seccomp boundary

The 45-instruction classic-BPF policy kills non-x86_64 audit architecture and rejects x32 syscall numbers with `EPERM`. It returns `ENOSYS` for syscall IDs 435 and 425; `EPERM` for 101, 311, 272, 308, 165, 166, 155, 161, 429, 428, 430, 431, 432, 433 and 442; and rejects `clone` (56) with the checked flag mask `0x7e820000`. Other native-ABI syscalls are allowed by this filter. `no_new_privs` and filter installation failure terminate the stub. These are source facts; kernel behavior remains pending public-kernel CI.

## Verification caveat

Miri cannot interpret the inline assembly or prove raw-kernel interactions. The parser unit tests plus public-kernel tests in the existing workflow are the intended compensation, not a claim of UB proof. Workflow wiring and authored tests are not a passing CI result. All tests are **NOT RUN locally** and CI evidence is pending.

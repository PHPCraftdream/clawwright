# Single-task launch gate

## Why this component uses Rust

This Linux/amd64 component must remain one kernel task before descriptor-bound exec and inherited seccomp installation. Go runtime threads cannot satisfy that invariant merely through `GOMAXPROCS` or `LockOSThread`. This is a narrow, dependency-free Rust fallback, not general Rust preference. The former C implementation is retained only in Git history at baseline `8eadbd4e8dcfac3d6e11fe5ee49525da5baa3482`.

The `.init_array` constructor checks inherited FDs 0–5 before Rust main can repair missing standard descriptors. It does not initialize them. Its `extern "C"` type is the constructor ABI, not a seccomp callback. Standard-library preparation precedes the restricted transition; the program does not spawn threads. Seccomp and exec use raw selected-ABI syscalls with documented pointer invariants. There is no authored C shim, Cargo manifest or external crate.

## Launch contract

The process requires empty environment and no extra argument. It checks matching PID/TID, one `/proc/self/task` entry and exactly FDs 0–5. FD 3 must be a root-owned regular executable, single-link and not group/world writable. FDs 4–5 must be read-only FIFOs; no descriptor target may contain `io_uring`. FD 3 becomes close-on-exec.

FD 5 carries `OCARGV01`: big-endian u32 counts and length-prefixed UTF-8 strings. NULs, duplicate environment keys, trailing data and malformed prefixes are rejected. Limits are 4096 packet bytes, 1–16 arguments, 1–1024 bytes per argument and 3072 aggregate argv bytes including terminators. Up to two environment entries use 3–768 bytes each and 1024 aggregate bytes including terminators. Only `OPENCLAW_CONFIG_PATH` and `CLAWWRIGHT_NATIVE_SOCKET` are accepted.

Malformed complete fields are refused while the writer remains open. Valid framing still requires final EOF. FD 4 then supplies exactly byte `0xa5` followed by EOF. The supervisor establishes trace tracking before opening that gate. The process installs the classic-BPF architecture/x32, syscall and clone-mask restrictions, then executes FD 3 through `execveat`.

## Verification and remaining limits

At commit `cc14a1098dc2d3da0ad47862af20c8478578c40c`, public CI `41347987407` passed Rust parser/filter tests and the real admission/kernel suite twice. This includes guarded exec, packet/gate/FD refusals, retained-writer refusal and final-EOF checks. Supervisor CI `41347987327`, tooling-policy CI `41347987309` and feature CI `41347987344` also passed.

CI recorded `rustc 1.99.1`, Cargo `1.99.1`, target `x86_64-unknown-linux-gnu`; no toolchain was installed or version changed. Shipped builds use edition 2021, optimization level 2, panic abort and static CRT. Test harnesses unwind. The runner toolchain is recorded, not pinned by this repository.

Raw syscall/constructor `unsafe` boundaries require manual ABI and resource-lifetime review. Miri cannot interpret these kernel transitions; passing tests are not a formal UB proof. No local builds or tests were run. These component results do not establish keeper-composed delivery, OpenClaw adoption or production readiness.

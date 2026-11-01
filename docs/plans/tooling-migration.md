# Tooling migration

## Component inventory and current callers

| Component | Current role and observed caller | Migration constraint |
|---|---|---|
| `tools/clawwright.ts` | Main dispatcher; npm scripts and CI invoke through the package's Node type-stripping entry point. | Preserve command-line and runtime parity before changing dispatcher. |
| `tools/checks/**` | Repository checks and integration suites called by `clawwright.ts`, npm scripts and workflows. | Move narrow deterministic checks only with equivalent fixtures. |
| `tools/dev/**` | `golden-update.ts`, `docs-commands.ts`, `check-linux.ts`, `worktree.ts`, and `install-system.ts` have package-script callers. | Map platform assumptions and callers before replacing. |
| `tools/build-framework-package.ts` | Called by package `build`; produces the framework runtime package. | Not a policy checker candidate. |
| `tools/native/task240-native-admission/**` | Linux admission API, controller, custody, diagnostics, guard and kernel tests; run by `native-admission.yml`. | Experimental native validation; retain behavior and kernel coverage. |
| `tools/native/task240-native-policy/policy.go` and `policy_test.go` | Go policy implementation and tests. | Security policy behavior and parser tests must migrate together. |
| `tools/native/task240-native-provider/**` | Linux provider executable and protocol with protocol tests; workflow exercised with admission. | Protocol and provider caller parity required. |
| `tools/native/task245-native-content/**` | Native content implementation and tests; part of the native component workflow set. | Preserve content contract and tests. |
| `tools/native/task245-lab-broker/**` | Broker auth, launch and main executable with auth tests. | Security-sensitive component; migrate only with explicit integration coverage. |
| `tools/native/task245-native-supervisor/**` | Linux/amd64 domain, isolation, keeper, worker and supervisor with protocol tests; run by `native-supervisor.yml`. | Preserve OS/architecture constraints and protocol behavior. |
| `tools/native/task245-composed-lab/**` | Composed lab executable, negative paths and cancellation checks. | Integration-facing orchestration; parity before any rewrite. |
| `tools/native/task240-launch-stub/` | Dependency-free Rust launch gate; the superseded C source was removed after kernel CI and parent review. | Narrow single-task pre-exec fallback. The constructor checks inherited FDs 0–5; BPF installation uses raw `prctl`, not an extern-C callback. See the component README for contract and CI evidence. |
| `tools/native/task245-control-profile/**` | C control profile, metadata client/service, probe and tests. | Control/metadata interface and tests remain a coherent unit. |
| `tools/native/task245-domain-init/` | Dependency-free Rust bootstrap used by `task245-lab-broker/launch_linux.go`; superseded C source removed after actual-binary kernel CI. | Raw-fork/namespace fallback, with verified chroot-before-unshare ordering and fail-closed finite descriptor limits. Full keeper composition remains separate. |
| `tools/native/task245-acceptance/**` | C gateway/release fixture and Python `run.py`, `profile.py`, `service.py`, `service_test.py`; acceptance workflow invokes runner. | Acceptance orchestration is experimental validation, not evidence of product adoption. |
| Framework TypeScript under `tools/framework/**` | Shipped runtime and public package surface; `tools/build-framework-package.ts` builds JavaScript and declarations from it. | Do not blanket-port: require public API/declaration parity, package output compatibility and runtime tests. |

## Policy leaf and transitional boundary

`tools/tooling-policy` audits the committed/index snapshot, not working-tree bytes: `git ls-files --full-name --stage -z -- tools/` supplies repository-root-relative paths, modes and blob IDs, and `git cat-file blob` supplies the exact audited content. The checker resolves any supplied existing directory (including a linked worktree subdirectory) to its actual Git worktree top-level before inventory; a path outside a worktree fails clearly instead of producing an empty success. The baseline is the immutable commit `8eadbd4e8dcfac3d6e11fe5ee49525da5baa3482`.

Every tracked `tools/` path is classified. Go, TypeScript/JavaScript, C/C++, Python, Rust, shell and PowerShell are implementations and count toward a 700-physical-line ceiling. Non-Go implementations retain their baseline blob identity except for four exact Rust fallback paths: `tools/native/task240-launch-stub/main.rs`, `linux.rs`, and `packet.rs`, plus `tools/native/task245-domain-init/main.rs`. These are narrow fallbacks for a single-task kernel/pre-exec boundary and raw-fork mount/ID lifecycle; they do not establish Rust preference or blanket language allowance. There is no Cargo dependency or C shim source authorized. Rust files remain subject to 700 lines; directories to at most 7 immediate entries. The baseline remains immutable.

The exact finite `tools/native/task245-acceptance/run.py` build transition passed tooling-policy CI `41347987309`: a single-anchor transformation of the immutable baseline C build list admits only the resulting exact Rust build-wiring blob. Its public-CLI regression rejects additional staged changes. This validates the policy transition, not execution of the full composed lab runner. No broad Python exemption is allowed. Classification is extension-based, not content parsing; data may carry declarative executable behavior. Directory limits count tracked files and derived directories, excluding untracked, ignored, generated and empty directories. The checker audits the Git index, not unstaged working-tree changes.

The ceiling is a fixed baseline ceiling, not a historical ratchet: after a file is reduced, it may later grow back up to its original baseline without explicit tightening. Existing grandfathered debt is reported, not completion. Immediate-entry limits prohibit new children while a directory remains over limit. Inventory and debt are report output, separate from violations.

## Credible migration order

1. First migrate narrow release checks with concrete callers: `tools/checks/release/license-audit.ts` and `license-audit.check.ts`, invoked by `npm run license:audit`; verify parity before changing that caller.
2. Next migrate named `docs/dev` checks, then installer/package checks such as `tools/checks/foundation/packaging/build-output.check.ts`, then runtime checks. Keep each existing npm/workflow caller and compare fixtures before switching it.
3. Keep this standard-library checker and its parsing, classification, ceiling and ratchet tests self-contained; do not treat this as general Rust permission.
4. The two launch C sources have been removed after verified replacement execution and parent review; their history remains at the immutable baseline. Other native components retain independent tests/workflows and remain migration work. Task #245 remains unaccepted: composed run `41335351818` failed with child exit 255. The broker's source still carries the five-second handshake receive timeout into an EOF monitor that treats `EAGAIN` as fatal; that separate defect and full composition require their own fixes and evidence. No adoption claim follows.
5. The approved product boundary is to relocate the shipped TypeScript runtime/public library out of `tools/`, preserving its language, runtime behavior, generated JavaScript/declarations and public API. Do not rewrite that application/library runtime in Go. Update real build/import/package callers coherently and verify compatibility before removing old paths. Migration remains unfinished.

## Verification

At replacement commit `cc14a1098dc2d3da0ad47862af20c8478578c40c`, public admission CI `41347987407`, supervisor CI `41347987327`, tooling-policy CI `41347987309` and feature CI `41347987344` passed. Actual launcher and bootstrap kernel suites ran twice, including malformed retained-writer refusal, valid final EOF, descriptor/seal/type/mode failures, namespace/mount/identity checks, numeric diagnostics and parent death. Rust parser/filter/ABI tests and real Git/public-CLI policy tests also passed. Feature CI is not an explicit full sprint gate.

CI recorded preinstalled Rust/Cargo `1.99.1`, target `x86_64-unknown-linux-gnu`; no versions were installed or changed. Shipped Rust builds use edition 2021, optimization level 2, panic abort and static CRT; test harnesses unwind. The runner compiler is recorded, not repository-pinned. Go stays at `1.26.0`. No local builds/tests were run. Raw-syscall/constructor unsafe boundaries require manual ABI/lifetime review; Miri cannot prove these kernel transitions, and passing component tests do not establish full composition, application adoption or production readiness.

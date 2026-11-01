# Tooling migration

## Component inventory and current callers

| Component | Current role and observed caller | Migration constraint |
|---|---|---|
| `tools/clawwright.ts` | Main dispatcher; npm scripts and CI invoke through the package's Node type-stripping entry point. | Preserve command-line and runtime parity before changing dispatcher. |
| `tools/checks/**` | Repository checks and integration suites called by `clawwright.ts`, npm scripts and workflows. | Move narrow deterministic checks only with equivalent fixtures. |
| `tools/dev/**` | `golden-update.ts`, `docs-commands.ts`, `check-linux.ts`, `worktree.ts`, and `install-system.ts` have package-script callers. | Map platform assumptions and callers before replacing. |
| `tools/build-framework-package.ts` | Called by package `build`; produces the framework runtime package. | Not a policy checker candidate. |
| `tools/native/task240-native-admission/**` | Linux admission API, controller, custody, diagnostics, guard and kernel tests; run by `native-admission.yml`. | experimental native validation components; retain behavior and kernel test coverage. |
| `tools/native/task240-native-policy/policy.go` and `policy_test.go` | Go policy implementation and tests. | Security policy behavior and parser tests must migrate together. |
| `tools/native/task240-native-provider/**` | Linux provider executable and protocol with protocol tests; workflow exercised with admission. | Protocol and provider caller parity required. |
| `tools/native/task245-native-content/**` | Native content implementation and tests; part of the native component workflow set. | Preserve content contract and tests. |
| `tools/native/task245-lab-broker/**` | Broker auth, launch and main executable with auth tests. | Security-sensitive component; migrate only with explicit integration coverage. |
| `tools/native/task245-native-supervisor/**` | Linux/amd64 domain, isolation, keeper, worker and supervisor with protocol tests; run by `native-supervisor.yml`. | Preserve OS/architecture constraints and protocol behavior. |
| `tools/native/task245-composed-lab/**` | Composed lab executable, negative paths and cancellation checks. | Integration-facing orchestration; parity before any rewrite. |
| `tools/native/task240-launch-stub/stub.c` | Small native launch stub. | C launch boundary, not disposable tooling data. |
| `tools/native/task245-control-profile/**` | C control profile, metadata client/service, probe and tests. | Control/metadata interface and tests remain a coherent unit. |
| `tools/native/task245-domain-init/init.c` | Native domain initialization executable. | Initialization behavior and callers must remain covered. |
| `tools/native/task245-acceptance/**` | C gateway/release fixture and Python `run.py`, `profile.py`, `service.py`, `service_test.py`; acceptance workflow invokes the runner. | acceptance orchestration and service fixtures are experimental native validation components, not evidence of product adoption. |
| Framework TypeScript under `tools/framework/**` | Shipped runtime and public package surface; `tools/build-framework-package.ts` builds JavaScript and declarations from it. | Do not blanket-port: require public API/declaration parity, package output compatibility and runtime tests. |

## Policy leaf and transitional boundary

`tools/tooling-policy` audits the committed/index snapshot, not working-tree bytes: `git ls-files --full-name --stage -z -- tools/` supplies repository-root-relative paths, modes and blob IDs, and `git cat-file blob` supplies the exact audited content. The checker resolves any supplied existing directory (including a linked worktree subdirectory) to its actual Git worktree top-level before inventory; a path outside a worktree fails clearly instead of producing an empty success. The baseline is the immutable commit `8eadbd4e8dcfac3d6e11fe5ee49525da5baa3482`.

Every tracked `tools/` path is classified. Go, TypeScript/JavaScript, C/C++, Python, Rust, shell and PowerShell are implementations and count toward a 700-line ceiling; counts include every physical source line, including blank and comment lines, so the ceiling is conservative. Implementation extensions are inventoried by language. Non-Go implementations must retain their baseline blob identity, preventing new or altered implementations; existing non-Go content is therefore frozen and cannot be reduced until replaced with Go. Classification is extension-based, not a content parser: data formats are treated separately, but data may carry declarative executable behavior, and the checker cannot prove that it contains no embedded old implementations. No Rust exception is implemented. Directory limits count tracked files and derived directories only, excluding untracked, ignored, generated and empty directories. The checker audits the Git index, not unstaged working-tree changes.

The ceiling is a fixed baseline ceiling, not a historical ratchet: after a file is reduced, it may later grow back up to its original baseline without requiring explicit tightening. Tightening that ceiling requires a future explicit change. Existing grandfathered debt is reported, not completion; report the actual remaining components rather than implying policy passage means migration is done. Immediate-entry limits compare current and baseline trees and prohibit new children while a directory remains over limit. Inventory and debt are report output, separate from actual violations.

## Credible migration order

1. First migrate narrow release checks with concrete callers: `tools/checks/release/license-audit.ts` and `license-audit.check.ts`, invoked by `npm run license:audit`; verify parity before changing that caller.
2. Next migrate named `docs/dev` checks, then installer/package checks such as `tools/checks/foundation/packaging/build-output.check.ts`, then runtime checks. Keep each existing npm/workflow caller and compare fixtures before switching it.
3. Keep this standard-library checker and its parsing, classification, ceiling and ratchet tests self-contained; do not treat this as an exception for Rust or any other implementation language.
4. Treat native admission/provider, policy, content, broker, supervisor and composed-lab as distinct runtime components with their current named tests/workflows as gates; preserve the C launch/control/init and Python acceptance paths until equivalent executable and acceptance coverage exists.
5. The approved product boundary is to relocate the shipped TypeScript runtime/public library out of `tools/`, preserving its language, runtime behavior, generated JavaScript/declarations and public API. Do not rewrite that application/library runtime in Go. Update real build/import/package callers coherently and verify compatibility before removing old paths. Tool implementations still migrate to Go; no Rust exception or blanket native exclusion is currently supported by this policy leaf, and migration remains unfinished.

## Verification

`.github/workflows/tooling-policy.yml` runs on push, pull request and manual dispatch with Go `1.26.0`, disabled CGO, a ten-minute timeout, Bash strict mode and checkout credentials disabled. CI runs `go test ./...` (including public-binary tests that build the CLI at test runtime and exercise temporary local clones, linked worktrees, staged blob behavior, and error cases) and `go run . --root ../..`. The coverage is authored but pending execution; no local execution was performed for this revision.

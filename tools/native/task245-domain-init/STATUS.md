# Native launch component status

## Verified component migration

The launch gate and namespace bootstrap use dependency-free Rust only for their single-task pre-exec/raw-fork boundaries. Go remains the tooling default. Their superseded C sources have been removed after parent review and successful execution of the replacement binaries. Historical reference source is available at baseline `8eadbd4e8dcfac3d6e11fe5ee49525da5baa3482`.

Public CI for replacement commit `cc14a1098dc2d3da0ad47862af20c8478578c40c`:

- `41347987407`: Rust parser/filter tests and real admission/kernel suite passed; kernel cases run twice.
- `41347987327`: Rust bootstrap ABI/diagnostic tests, actual bootstrap positive/negative/parent-death kernel cases twice, Go source tests and builds passed.
- `41347987309`: finite tooling-policy transitions and public-CLI regressions passed.
- `41347987344`: existing feature CI passed; this is not an explicit full sprint gate.

The component READMEs state the exact descriptors, packet, namespace, credentials, seccomp and cleanup contracts. Toolchain versions were recorded in CI, not installed or bumped. No local builds or tests were run. Unsafe raw-kernel boundaries were source-reviewed and kernel-tested; no formal UB or production-readiness claim follows.

## Unfinished composition

The existing synthetic ssjack acceptance is not actual OpenClaw adoption. The full keeper-to-supervisor/provider route remains unaccepted. Its last composed run `41335351818` failed; the Go broker retains a five-second handshake receive timeout in its lifecycle EOF monitor and treats `EAGAIN` as fatal. This separate defect has not been fixed by the launch-language migration.

The root broker authenticates the handoff and immutable prepared artifacts; it has no keeper grant or independent secret authority. Exact references, trusted human registration/unlock and finite keeper grants remain mandatory. The supervisor still requires actual capture evidence before SSACK. Partial, cancelled or uncertain effects must retain truthful UNKNOWN/WITHHELD behavior and cannot be blindly replayed.

Other C/Python control-profile, metadata mediator, fixture and orchestration implementations remain migration debt in tasks #249/#250. Their existing direct/owning/notifier tests are not substitute evidence for full composition. No guest enrollment, production deployment, host policy change, paid provider smoke or real OpenClaw adoption was performed.

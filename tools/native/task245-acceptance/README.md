# Task 245 native supervisor acceptance

## Source scope (not execution evidence)

This Linux/amd64 worktree contains source for an authorized conductor-only overlay; no runtime, test, build, or CI result is claimed. The pinned CLI, keeper, driver, harness, and crypto sources are unchanged. The syntheticdriver compatibility path in `run.py` alters executable bytes at offsets 40–47 and 58–63; it does not change the existing file path. Runtime compatibility is unverified. Earlier parent-reported CI passed source+feature and confinement checks but failed the six-case matrix before this update; no new CI has run.

The authored composed matrix is distinct from eight direct kernel cases and real-MCP acceptance. Existing full per-send custody is unchanged. Typed outcomes must come from the unchanged pinned harness; the conductor must not synthesize them. No readiness, adoption, completion, passing-negative, or execution claim is made. Notification ID races remain a limitation.

The disposable profile retains `apparmor=unconfined`; this is not a host policy. Docker seccomp uses exact capabilities, no host binds, no network, and no-new-privileges; the inner fixture uses Landlock.

## Metadata notifier fixture preflight

The root profile runs inactive and active metadata preflights before creating the native-root fixture or beginning the real ceremony. The temporary fixture identities are `/lab/harness` and `/lab/ssjack`; the staged root fixture is synthetic and nonsecret, not the real keeper. The active regression runs the actual fork/exec client, checks its PID, `/proc` start ticks and PPID owner record, and invokes production `owner_capture` through the actual receipt snapshot path.

Active phase 0 observes the real ACK, then removes it. Phases 1/2/3 induce real kernel `EBADF` via descriptor wrappers (write, fsync, close); close `EIO` coverage is also asserted. Phases 4/5 mutate the receipt or provide wrong fault evidence and require refusal. Live-owner and ACK-absent assertions remain; no typed outcomes are fabricated. The ioctl check denies ioctl on the protected FD while ordinary ioctl remains allowed. Inactive-route exec-reservation assertions are included.

The profile's `finally` restores both the real product wrapper and keeper and verifies their hashes before binding `/lab/ssjack` read-only and starting the real ceremony. The temporary regression fixtures do not stand in for real MCP acceptance. This worktree update is source-only; no commands, builds, tests, or CI were run.

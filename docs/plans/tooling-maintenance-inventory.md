# Remaining tooling maintenance inventory

## Scope and method

This is a parent read-only metadata inventory, not an execution of the Go policy checker or a test result. It uses tracked `tools/` paths in the task251 worktree based on `fd59e08fa0fbeb9450b5110c6bd0c08a2404d280`, excluding the package being relocated from `tools/framework/` and the two superseded TypeScript license-audit implementations. Source line counts use physical working-file lines; immediate-entry counts use tracked files and derived directories, not ignored or empty directories.

The candidate has no remaining tracked implementation file above 700 physical lines under that scope. This does not establish that every changed or untracked file passes final indexed policy enforcement. The new Go license-audit module is separately source-reviewed: seven immediate entries, with its largest test file at 602 lines at the review boundary.

## Inherited directory debt

| Directory | Immediate tracked entries | Required target |
|---|---:|---:|
| `tools/checks` | 17 | 7 |
| `tools/native` | 12 | 7 |
| `tools/native/task240-native-admission` | 9 | 7 |
| `tools/dev` | 9 | 7 |
| `tools/checks/runtime` | 8 | 7 |
| `tools/checks/golden/expected` | 8 | 7 |

These counts are outstanding debt, not new exemptions or a completed migration. The immutable policy baseline `8eadbd4e8dcfac3d6e11fe5ee49525da5baa3482` is unchanged; its grandfathered ceilings remain a compatibility mechanism rather than the final seven-entry acceptance target. Final candidate counts and exact indexed blobs must be checked by public GitHub CI after integration.

## Remaining acceptance

- Relocation must preserve installed public exports, generated JavaScript/declarations, assets and checkout behavior, including already-generated checkout declarations. Moving the package is not a blanket admission of non-Go helper implementations outside `tools/`.
- The release/license Go migration needs the final `packages/clawwright` caller path, exact reviewed dependency identities, adversarial fixtures, mandatory CI callers and indexed policy enforcement. Its earlier unauthorized local formatter/test runs are not acceptance evidence for the revised source.
- Other TypeScript helper implementations remain migration work. Inventory and migrate coherent groups with their actual callers and tests; do not treat the runtime move plus one helper leaf as completion of task246.
- Regroup inherited directory debt by responsibility, without minification, arbitrary directory names, policy-baseline resets or weakened checks.
- No generated `dist`, archive, dependency cache, application state or secret-bearing artifact belongs in the source change.

All project builds, tests, parsers, typechecks, linters and application execution remain public-CI-only. Maintenance progress is not keeper composition, real OpenClaw authentication or production readiness. The native composition route remains unaccepted and frozen pending its separate product/security decision.

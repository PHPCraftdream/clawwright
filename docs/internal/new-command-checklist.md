# New command checklist

A new command or a new source module touches more registries than its own file. This
checklist is derived from the commits that added `clawwright files`: 012473f ("files:
declarative placement of files into the data directory") added the command and its runtime
modules, 09cc99e ("bridge: make the suite green on the merged features") registered
everything the first commit had missed, and 408e928 ("controls: C13 follows the recipe
mirror into runtime/files/files.ts") shows what happens when a negative control pins text
that moves.

## Adding a command

1. Write the command module under `tools/framework/commands/<group>/`. Pick the group by
   meaning — the groups live in `tools/framework/commands/interface/groups/` (`lifecycle`,
   `management`, `operate`, `orchestration`, `sets`); `files` went to
   `tools/framework/commands/management/files.ts` (012473f). Respect the layout limits of
   `tools/checks/foundation/layout.check.ts`: at most 7 direct entries per directory, at
   most 700 lines per file.
2. Register the command in the matching group table
   (`tools/framework/commands/interface/groups/openclawCommands.<group>.ts`): name, summary
   (the MCP schema summary stays at most 60 characters including its action-suffix), the
   flags the command really declares, help prose with `{--flag}` tokens — no new
   `{clawwright …}` tokens (012473f touched `openclawCommands.management.ts`).
3. Add the flags-matrix entry (`tools/checks/completeness/flags-matrix.check.ts`) and the
   effect-table entry (`tools/checks/foundation/core/command/spec/effect.check.ts`). Both
   fail a command missing from them — 09cc99e had to add the missing lines after the merge.
4. Write checks under `tools/checks/` mirroring the module by meaning, with the harness from
   `#checks/kit/harness.ts`. Checks must fail without the change. Keep the architecture prose
   ratchets flat: a spaced prose literal that reaches an assertion operand is counted
   (`tools/checks/architecture/prose-held.ts`), so compare against structured values or the
   production symbol, and measure new check files before committing. 012473f added
   `files-apply.check.ts`, `files-deployment.check.ts`, `files-fake-plan.check.ts` and
   `files-sync.check.ts` under `tools/checks/runtime/lifecycle/`.
5. If a negative control in `tools/checks/controls/controls.ts` pins text you moved or
   changed, update the control in the same commit — the `CONTROLS` table names the product
   file, the search/replace edit, the check that must fail and a fragment of the failing
   assertion name (408e928 changed only `controls.ts` for exactly this reason).
6. Run `npm run docs:commands` to regenerate the command table in `docs/guide/commands.md`
   (between `<!-- commands:begin -->` / `<!-- commands:end -->`) and the command list in
   `README.md` (between `<!-- command-list:begin -->` / `<!-- command-list:end -->`). Never
   hand-edit the marker blocks — `tools/checks/foundation/packaging/docs-commands.check.ts`
   fails a hand-edited one.
7. Run `npm run golden:update` if the goldens changed — under
   `tools/checks/golden/expected/`: `help-checkout.txt`, `help-installed.txt`,
   `completion-scripts.txt`, `advice-matrix.txt`, `mcp-tools-list.json` (all five were
   regenerated in 09cc99e).
8. If architecture ratchet numbers dropped because of the change, record the lower numbers
   in `tools/checks/architecture/baseline.json` in the same commit. Numbers may only go
   down, never up (09cc99e: `transport-read-swallow` 21 → 18, `frameLawViolations`
   198 → 192). If the change regrouped files, keep every directory within the layout limits.
9. If the command or module writes a new file into the data directory (a record, a staged
   copy, a ledger), decide its archive treatment in
   `tools/framework/service/archive/profile.ts` — kept in full and migrate archives, left out of
   share archives, or excluded everywhere for staging copies (012473f excluded
   `clawwright-files.json` from share archives there; the same file lists the staging names).
10. Gates before handover: `npm run typecheck`, `npm run lint`, then `npm run gate` — the
   orchestrator and CI run the gate ultimately.

## Adding a source module (no new command)

Put the module where similar ones live: `runtime/files/` for file placement,
`core/values/` for value types — 09cc99e's regrouping is the model. A module that a control
in `tools/checks/controls/controls.ts` pins by path or by text requires the controls
update in the same commit. Architecture baseline keys are file paths, so a moved file can
stale them — update the keys when the file moves. The layout limits force regrouping by
meaning when a directory is full, not an 8th file next to the others.

// Public, target-free set comparison API.
//
// The implementation lives with the command because it also owns artifact staging and the
// terminal renderer. Re-exporting the pure types and function here gives libraries a stable
// set/ namespace without making them depend on CLI dispatch details.

export { diffManifests } from "#src/commands/sets/set-diff.ts";
export type {
  DiffSnapshot,
  SetDiffAction,
  SetDiffChange,
  SetDiffKind,
  SetDiffResult,
} from "#src/commands/sets/set-diff.ts";

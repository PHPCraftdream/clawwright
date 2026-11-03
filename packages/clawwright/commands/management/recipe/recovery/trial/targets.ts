// The trial's target-side file inventory and the compose argv shapes against it: the
// ORIGINAL definition+override pair for read-only proofs and evidence, the PINNED merged
// document for everything that builds, starts or tears down.

import { posix } from "node:path";

export interface TrialTargets {
  readonly project: string;
  readonly home: string;
  readonly envFile: string;
  readonly overrideFile: string;
  readonly pinnedFile: string;
  readonly dataDir: string;
  readonly definitionFile: string;
}

/** The argv against the ORIGINAL definition+override pair — used only by the read-only
 *  config proofs and ps/log evidence. */
export function composeArgs(targets: TrialTargets, args: readonly string[]): string[] {
  return ["compose", "--env-file", targets.envFile, "--project-name", targets.project,
    "--file", targets.definitionFile, "--file", targets.overrideFile,
    "--project-directory", posix.dirname(targets.definitionFile), ...args];
}

/** The argv against the PINNED document — the byte-exact merged config the proof just
 *  validated, written as a JSON compose file. Build, up AND the teardown down all run
 *  against this one file. */
export function pinnedComposeArgs(targets: TrialTargets, args: readonly string[]): string[] {
  return ["compose", "--env-file", targets.envFile, "--project-name", targets.project,
    "--file", targets.pinnedFile,
    "--project-directory", posix.dirname(targets.definitionFile), ...args];
}

/** The same argv against the BASE compose file only — failure evidence must describe what
 *  the recipe itself defines, not the trial's ports-stripping override. */
export function baseComposeArgs(targets: TrialTargets, args: readonly string[]): string[] {
  return ["compose", "--env-file", targets.envFile, "--project-name", targets.project,
    "--file", targets.definitionFile,
    "--project-directory", posix.dirname(targets.definitionFile), ...args];
}

export const CONFIG_ARGS = ["config", "--format", "json"] as const;

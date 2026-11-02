// Argument shapes reused across more than one command group's entries in
// openclawCommands — split out so every fragment file can share exactly one
// definition instead of drifting into slightly different copies.

import { PROFILES } from "#src/service/archive/index.ts";
import * as kinds from "#src/core/values/kinds.ts";
import type { LockTakeover } from "#src/runtime/lock/instance-lock.ts";

export const PROFILE_ARGUMENT = {
  name: "profile",
  summary: "full, migrate or share",
  description: "full (everything), migrate (no provider keys or recipe-declared private files) or share (no keys, identity, or recipe-declared private files)",
  kind: "option",
  valueName: "profile",
  value: kinds.choice(PROFILES),
} as const;

export const FORCE_ARGUMENT = {
  name: "force",
  description: "Skip the confirmation",
  kind: "flag",
} as const;

export const BREAK_LOCK_ARGUMENT = {
  name: "break-lock",
  summary: "Take over the lock",
  description: "Take over the instance lock held by another operation",
  kind: "flag",
} as const;

/** An orphaned mutation guard whose owner is recorded on another machine — plain
 *  --break-lock refuses it forever, since a remote pid's liveness cannot be checked from
 *  here. This confirms the exact host id and records the takeover; see
 *  docs/architecture.md's instance-lock runbook. */
export const BREAK_FOREIGN_LOCK_ARGUMENT = {
  name: "break-foreign-lock",
  summary: "Lock owner's host id",
  description: "Confirm <hostId> for a recorded remote lock owner",
  kind: "option",
  valueName: "hostId",
  value: kinds.hostId(),
} as const;

/** The two lock-takeover arguments, as every locking command declares them. */
export const LOCK_TAKEOVER_ARGUMENTS = [BREAK_LOCK_ARGUMENT, BREAK_FOREIGN_LOCK_ARGUMENT] as const;

/** The takeover a call asked for, from its bound values. */
export function takeoverOf(values: { readonly "break-lock"?: boolean; readonly "break-foreign-lock"?: string }): LockTakeover {
  return { breakLock: values["break-lock"] === true, breakForeignLockHost: values["break-foreign-lock"] };
}

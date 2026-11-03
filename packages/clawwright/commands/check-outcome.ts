// One vocabulary for check outcomes, shared by everything that runs checks against a
// deployment and reports what it found (`accept`, `smoke`). Was a verdict obtained, and if
// not, why not.
//
// Four outcomes, not three-collapsed-into-one: "skipped" can mean both "nobody asked for
// this" and "we tried and got nowhere", and one label for both is how a report stops being
// trusted.
//
//   passed           a verdict was obtained, and it is good
//   failed           a verdict was obtained, and it is bad
//   not-checked      deliberately not run — decided before the attempt
//   could-not-check  attempted, no verdict obtainable — the detail says why
//
// Distinct from `StepStatus` (service/operations.ts), which records what a mutating run
// DID, not a question answered.

/** The outcome of one check, spelled the same way in every report, JSON surface and
 *  receipt that carries one. */
export type CheckOutcome = "passed" | "failed" | "not-checked" | "could-not-check";

/** Thrown by a check that deliberately does not run. Reported as not-checked: named and
 *  counted, never omitted and never held against the deployment. */
export class NotChecked extends Error {
  name = "NotChecked";
}

/** Thrown when a check got far enough to try but no verdict came out of it — the instance
 *  was unreachable, the call never answered. Reported as could-not-check: a suite that
 *  could not obtain a verdict has not earned the right to call itself passing. */
export class CouldNotCheck extends Error {
  name = "CouldNotCheck";
}

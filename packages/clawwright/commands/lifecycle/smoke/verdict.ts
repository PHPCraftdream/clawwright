// The vocabulary every smoke check shares: a check, how a call that never reached the
// instance is told apart from a verdict, and how a check's outcome becomes a SmokeResult.

import type { Context } from "#src/core/context.ts";
import { CouldNotCheck, NotChecked } from "#src/commands/check-outcome.ts";
import type { CheckOutcome } from "#src/commands/check-outcome.ts";

export interface Check {
  readonly name: string;
  readonly run: (ctx: Context) => Promise<void>;
}

/** Throws with a readable message when the condition does not hold. */
export function expect(condition: boolean, detail: string): void {
  if (!condition) throw new Error(detail);
}

/** The could-not-check wording, shared with the checks that prove it. */
export function couldNotDo(doing: string, message: string): string {
  return `could not ${doing}: ${message}`;
}

/** Runs one of the calls a check makes to reach the instance. A throw from these is not a
 *  verdict about the deployment — Docker, the transport or the container did not answer, so
 *  the property under check was never evaluated (could-not-check). Assertions made on what
 *  a call RETURNS stay outside it: those are verdicts. */
export async function reach<T>(doing: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CouldNotCheck(couldNotDo(doing, message));
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface SmokeResult {
  readonly name: string;
  readonly status: CheckOutcome;
  readonly detail?: string;
}

/** Classifies a thrown error into the shared four-outcome vocabulary. A throw a check did
 *  not classify itself (NotChecked/CouldNotCheck) stays a failure. Shared by runChecks()'s
 *  per-check loop and runArchiveChecks()'s consolidated one, so both classify identically. */
export function toResult(name: string, error: unknown): SmokeResult {
  const message = describeError(error);
  if (error instanceof NotChecked) return { name, status: "not-checked", detail: message };
  if (error instanceof CouldNotCheck) return { name, status: "could-not-check", detail: message };
  return { name, status: "failed", detail: message };
}

/** Runs one check's body and turns its outcome (return, or a throw) into a SmokeResult. */
export async function evaluate(name: string, run: () => Promise<void>): Promise<SmokeResult> {
  try {
    await run();
    return { name, status: "passed" };
  } catch (error) {
    return toResult(name, error);
  }
}

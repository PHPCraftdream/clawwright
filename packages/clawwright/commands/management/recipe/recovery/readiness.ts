// Recipe readiness probing, shared by `recipe install` (actions.ts) and `recipe trial`
// (recovery/trial/): poll per-service state until every required service is running and
// healthy, hold that verdict for a grace period, or run out the timeout.

import type { RecipeReadiness } from "#src/service/recipe.ts";
import { sleep, type Stack, type StackServiceState } from "#src/runtime/runtime.ts";
import { timeoutMessage } from "#src/commands/management/recipe/run/lifecycle.ts";

/** Grace period for the implicit readiness check on a recipe with no `readiness` declared —
 *  long enough to catch a container that starts and exits moments later, short enough that
 *  a plain recipe never waits on a service it never described. Also the minimum a stack
 *  must HOLD a ready verdict before install believes it: one ready poll says nothing about
 *  the next moment. */
export const DEFAULT_READINESS_GRACE_MS = 5000;

/** Default timeout for a recipe that declares readiness but not its own timeoutMs — long
 *  enough for a real healthcheck (a database's first boot, say) to turn healthy. */
export const DEFAULT_DECLARED_READINESS_TIMEOUT_MS = 120_000;

export const READINESS_POLL_INTERVAL_MS = 500;

export interface RecipeReadinessResult {
  readonly status: "ready" | "degraded" | "unknown";
  readonly detail: string;
  readonly services: Record<string, StackServiceState>;
}

/** Which of `required` are missing from `services` entirely, present but not running, or
 *  running with a healthcheck that has not turned healthy. */
function readinessProblems(
  services: Record<string, StackServiceState>,
  required: string[],
): { missing: string[]; notRunning: string[]; unhealthy: string[] } {
  const missing = required.filter((name) => services[name] === undefined);
  const notRunning = required.filter((name) => services[name] !== undefined && !services[name].running);
  const unhealthy = required.filter((name) => {
    const health = services[name]?.health;
    return health !== undefined && health !== "healthy";
  });
  return { missing, notRunning, unhealthy };
}

/** Joins the three problem lists into one readable detail line. */
function readinessProblemDetail(problems: { missing: string[]; notRunning: string[]; unhealthy: string[] }): string {
  return [
    problems.missing.length > 0 ? `missing: ${problems.missing.join(", ")}` : undefined,
    problems.notRunning.length > 0 ? `not running: ${problems.notRunning.join(", ")}` : undefined,
    problems.unhealthy.length > 0 ? `not healthy: ${problems.unhealthy.join(", ")}` : undefined,
  ].filter((entry): entry is string => entry !== undefined).join("; ");
}

/** Bounds one awaited operation to `budgetMs`: a hung service-state probe must not outwait
 *  the readiness deadline bounding the whole loop. The operation keeps running past the
 *  timeout (no way to cancel it), but this caller stops waiting on it. */
function bounded<T>(operation: Promise<T>, budgetMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const wait = Math.max(1, budgetMs);
    const timer = setTimeout(() => reject(new Error(timeoutMessage(label, wait))), wait);
    operation.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** Polls per-service state until every required service (declared `readiness.services`,
 *  or everything compose reports when nothing is declared) is running and healthy, KEEPS
 *  that verdict for the full grace period, or `timeoutMs` runs out. The required set
 *  freezes at the first ready answer, so a member leaving mid-window fails readiness by
 *  name instead of silently shrinking the set. */
export async function waitForRecipeReadiness(stack: Stack, readiness: RecipeReadiness | undefined, timeoutMs: number): Promise<RecipeReadinessResult> {
  const deadline = Date.now() + timeoutMs;
  // The grace floor keeps the window wide enough for at least two confirming polls.
  const graceMs = Math.max(DEFAULT_READINESS_GRACE_MS, READINESS_POLL_INTERVAL_MS * 2);
  let graceEndsAt: number | undefined;
  let required: string[] | undefined;
  let readyDetail = "";
  let lastServices: Record<string, StackServiceState> = {};

  for (;;) {
    if (graceEndsAt !== undefined && Date.now() >= graceEndsAt) {
      return { status: "ready", detail: readyDetail, services: lastServices };
    }
    const phaseEnd = graceEndsAt ?? deadline;
    let services: Record<string, StackServiceState>;
    try {
      // Grace end is the earliest acceptance time, not an earlier probe deadline.
      services = await bounded(stack.serviceStates(), Math.max(deadline, phaseEnd) - Date.now(), "the service state probe");
    } catch (error) {
      return { status: "unknown", detail: `could not read service state: ${error instanceof Error ? error.message : String(error)}`, services: lastServices };
    }
    lastServices = services;
    // Default derivation reads the COMPLETE listing (stopped containers too), so a failed
    // service joins the required set instead of shrinking it.
    const names = required ?? readiness?.services ?? Object.keys(services);
    if (names.length === 0) {
      if (Date.now() >= phaseEnd) {
        return { status: "unknown", detail: "compose reported no services for this stack", services: lastServices };
      }
    } else {
      const problems = readinessProblems(services, names);
      const ready = problems.missing.length === 0 && problems.notRunning.length === 0 && problems.unhealthy.length === 0;
      if (graceEndsAt === undefined) {
        if (ready) {
          graceEndsAt = Date.now() + graceMs;
          required = names;
          readyDetail = `required service(s) running: ${names.join(", ")}`;
        } else if (Date.now() >= deadline) {
          return { status: "degraded", detail: readinessProblemDetail(problems), services: lastServices };
        }
      } else if (!ready) {
        return {
          status: "degraded",
          detail: `left the ready state during the ${graceMs}ms grace window: ${readinessProblemDetail(problems)}`,
          services: lastServices,
        };
      }
    }
    await sleep(Math.min(READINESS_POLL_INTERVAL_MS, Math.max(0, phaseEnd - Date.now())));
  }
}

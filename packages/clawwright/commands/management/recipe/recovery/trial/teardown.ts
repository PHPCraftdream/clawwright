// The teardown scope for `recipe trial`: register-then-do steps and LIFO cleanup.
// Cancellation of an SSH client is local-only, so a signal waits a conservative full
// target watchdog duration plus the TERM/KILL grace before cleanup. A second signal skips
// cleanup and exits nonzero; unknown cancellation capability fails closed.

import { die, warn } from "#src/core/io/log.ts";
import type { TrialTargets } from "./targets.ts";

export const TRIAL_TEARDOWN_TIMEOUT_MS = 60_000;
// Test seam: checks can shorten the per-step teardown deadline without changing the product default.
export function trialTeardownTimeoutMs(): number {
  const raw = process.env.OC_TRIAL_TEARDOWN_TIMEOUT_MS;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return TRIAL_TEARDOWN_TIMEOUT_MS;
}
const TRIAL_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const SIGNAL_EXIT_CODES: Record<(typeof TRIAL_SIGNALS)[number], number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

export function abortGuard(isAborted: () => boolean, what: string): void {
  if (isAborted()) die(`recipe trial ${what} aborted by signal — the teardown scope removes every registered resource`);
}

export interface TeardownStep {
  readonly name: string;
  readonly run: () => Promise<void>;
}

async function runTeardownSteps(steps: readonly TeardownStep[], failures: string[], secondSignal: () => boolean): Promise<void> {
  const stepTimeoutMs = trialTeardownTimeoutMs();
  for (const step of [...steps].reverse()) {
    if (secondSignal()) return;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => { timedOut = true; resolve(); }, stepTimeoutMs);
    });
    const execution = Promise.resolve().then(step.run).finally(() => clearTimeout(timer));
    try {
      await Promise.race([execution, deadline]);
      if (timedOut) failures.push(`${step.name} did not finish within ${stepTimeoutMs}ms — it may remain`);
    } catch (error) {
      failures.push(`${step.name}: ${error instanceof Error ? error.message : String(error)}`);
    } finally { clearTimeout(timer); }
  }
}

export async function withTeardown(targets: TrialTargets,
  scope: (register: (step: TeardownStep) => void, isAborted: () => boolean) => Promise<void>,
  onSignal?: () => void, settleTimeoutMs = TRIAL_TEARDOWN_TIMEOUT_MS,
  cancellation: "confirmed-local" | "local-only" | "unsupported" = "unsupported",
  currentMutationActive: () => boolean = () => false,
  waitDurationMs: () => number | undefined = () => undefined,
  waitingNotice?: () => void,
  remoteLeftoverMs: () => number = () => 0): Promise<void> {
  const steps: TeardownStep[] = [];
  const failures: string[] = [];
  let signalled: (typeof TRIAL_SIGNALS)[number] | undefined;
  let aborted = false;
  let cleanupStarted = false;
  let remoteWait = false;
  let secondSignal = false;
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let settleScope = (): void => {};
  const scopeSettled = new Promise<void>((resolveSettled) => { settleScope = resolveSettled; });
  const startCleanup = (): boolean => {
    if (cleanupStarted) return false;
    cleanupStarted = true;
    return true;
  };
  const report = (): void => { for (const failure of failures) warn(failure); };
  const handlers = new Map<(typeof TRIAL_SIGNALS)[number], () => void>();
  for (const signal of TRIAL_SIGNALS) {
    const handler = (): void => {
      if (signalled !== undefined) {
        if (remoteWait) {
          secondSignal = true;
          remoteWait = false;
          if (waitTimer !== undefined) clearTimeout(waitTimer);
          warn(`second signal received; skipping wait and destructive cleanup — resources may remain for project "${targets.project}" at ${targets.home}`);
          for (const [caught, registered] of handlers) process.removeListener(caught, registered);
          process.exit(1);
        }
        return;
      }
      signalled = signal;
      aborted = true;
      const mutationActive = currentMutationActive();
      remoteWait = mutationActive && cancellation !== "confirmed-local";
      onSignal?.();
      if (!startCleanup()) return;
      void (async () => {
        if (remoteWait) {
          const waitMs = waitDurationMs();
          if (waitMs === undefined || cancellation === "unsupported") {
            warn(`target mutation cancellation cannot be confirmed; destructive cleanup skipped — project "${targets.project}", scratch home ${targets.home} may remain`);
            for (const [caught, registered] of handlers) process.removeListener(caught, registered);
            process.exit(1);
            return;
          }
          waitingNotice?.();
          await new Promise<void>((resolveWait) => {
            waitTimer = setTimeout(() => { remoteWait = false; resolveWait(); }, waitMs);
          });
          if (secondSignal) return;
        }
        const settled = await Promise.race([scopeSettled.then(() => true), new Promise<boolean>((resolve) => { settleTimer = setTimeout(() => resolve(false), settleTimeoutMs); })]);
          if (settleTimer !== undefined) clearTimeout(settleTimer);
          if (!settled) {
          warn(`recipe trial signal teardown refused cleanup: the in-flight scope did not settle within ${settleTimeoutMs}ms; resources may remain for project "${targets.project}" at ${targets.home}`);
          for (const [caught, registered] of handlers) process.removeListener(caught, registered);
          process.exit(1);
          return;
        }
        await runTeardownSteps(steps, failures, () => secondSignal);
        if (secondSignal) return;
        for (const [caught, registered] of handlers) process.removeListener(caught, registered);
        report();
        process.exit(SIGNAL_EXIT_CODES[signal]);
      })();
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  let error: unknown;
  try { await scope((step) => { steps.push(step); }, () => aborted); }
  catch (caught) { error = caught; }
  settleScope();
  if (startCleanup()) {
    // A failed or timed-out call on a local-only-cancellation transport (SSH) can leave the
    // remote command running: wait out its watchdog before cleanup. A signal during the
    // wait takes the handler's second-signal path (no destructive cleanup).
    const leftoverMs = remoteLeftoverMs();
    if (leftoverMs > 0) {
      waitingNotice?.();
      await new Promise<void>((resolveWait) => { waitTimer = setTimeout(resolveWait, leftoverMs); });
    }
    await runTeardownSteps(steps, failures, () => secondSignal);
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    report();
    if (signalled !== undefined) { process.exit(SIGNAL_EXIT_CODES[signalled]); return; }
    if (failures.length > 0) die(`recipe trial teardown left resources behind — remove them manually: project "${targets.project}", scratch home ${targets.home}`);
    if (error !== undefined) throw error;
  }
}

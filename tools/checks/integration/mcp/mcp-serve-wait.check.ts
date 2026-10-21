// The `mcp-serve --wait <seconds>` readiness wait (commands/…/mcp.ts): the bridge used to
// call `ctx.runtime.waitForHealth(30)` unconditionally — no opt-out, no injectable clock,
// no timeout refusal of its own. Chunk 1 replaced that with waitForGateway(), a pure,
// injectable poll loop (deadline fixed before the first probe, ready() → deadline check →
// sleep(intervalMs ?? 2000); waitSeconds 0 skips entirely).
//
// Every scenario here runs on a FAKE runtime object — no Docker, no child processes — and
// pins exact call/sleep/clock counts, so each one fails against the pre-change code:
//  1. ready on the first poll — waitForHealthCalls === 0 fails while waitForHealth(30) ran.
//  2/3. waitForGateway direct with injected now/sleep — the function (and its exact
//       probe/sleep arithmetic) did not exist; the file would not even compile.
//  4. waitSeconds 0 — the loop's opt-out branch is new; the old path always waited.
//  5. timeout dies with a UserError naming the probe seconds — the old path had no such
//     refusal, and waitForHealthCalls === 0 fails against the old unconditional call.
//  6. stdout purity — the two stderr progress lines (and the absence of any third) are new;
//     the old code printed nothing and waited silently for a hardcoded 30s.
//  7. NotBootstrapped refuses BEFORE any probing — the guard-first order is new.
//  8. --wait 0 end to end — the argument itself is new (the command declared none).
//  9. the boundedCount kind refuses 601 and "abc" at the parse stage — the kind is new.

import { waitForGateway, mcpServe } from "#framework/commands/management/configuration/credentials/mcp.ts";
import { HelperNotRunning, NotBootstrapped } from "#framework/runtime/runtime.ts";
import { CLI_HELPER_SERVICE } from "#framework/commands/interface/cli-helper.ts";
import type { Context } from "#framework/core/context.ts";
import { UserError } from "#framework/core/io/log.ts";
import { renderAdvice } from "#framework/core/io/invocation/render.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

// --- fake runtime -------------------------------------------------------------------------------

function makeRuntime(options: { isRunning?: () => Promise<boolean>; probe?: () => Promise<number> } = {}): { runtime: Record<string, unknown>; counters: { probes: number; isRunningCalls: number; helperCalls: number; waitForHealthCalls: number; oneOffs: string[][] } } {
  const counters = { probes: 0, isRunningCalls: 0, helperCalls: 0, waitForHealthCalls: 0, oneOffs: [] as string[][] };
  const runtime = {
    isRunning: options.isRunning ?? (async () => { counters.isRunningCalls += 1; return true; }),
    probe: async (_name: string) => { counters.probes += 1; return options.probe ? await options.probe() : 200; },
    async execInHelper(_service: string, _args: string[], _opts: { stdioProtocol?: boolean }): Promise<never> {
      counters.helperCalls += 1;
      throw new HelperNotRunning(CLI_HELPER_SERVICE);
    },
    async runOneOff(_service: string, args: string[]) { counters.oneOffs.push(args); return { code: 0, stdout: "", stderr: "" }; },
    // The pre-change path called this unconditionally; it must never be reached again.
    waitForHealth(_seconds: number) { counters.waitForHealthCalls += 1; },
  };
  return { runtime, counters };
}

// Only `runtime` is reached on this path: parse touches no context, and runMcpServe's first
// act is requireBootstrapped → ctx.runtime.isRunning (requires-bootstrapped.check.ts builds
// the same minimal stub, wider only for commands that read settings/transport).
function contextOf(runtime: unknown): Context {
  return { runtime } as unknown as Context; // the one deliberate Partial-style cast
}

// Capture both real streams in-process (same mechanism as memory.check.ts / recipe
// inspect.check.ts): log()'s progress goes to stderr, and stdout must stay empty — it is
// the JSON-RPC protocol stream once the bridge hands over.
async function capture(body: () => Promise<void>): Promise<{ stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const realOut = process.stdout.write;
  const realErr = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout += String(chunk); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  try { await body(); } finally { process.stdout.write = realOut; process.stderr.write = realErr; }
  return { stdout, stderr };
}

/** The non-empty progress lines of a captured stderr. */
function lines(stderr: string): string[] {
  return stderr.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

// --- 1. ready on the first poll: parse → guard → one probe → helper fallback --------------------

{
  let probeCalls = 0;
  const { runtime, counters } = makeRuntime({ probe: async () => { probeCalls += 1; return probeCalls === 1 ? 200 : 503; } });
  const { stdout, stderr } = await capture(async () => { await mcpServe(contextOf(runtime), ["--wait", "7"]); });
  check("--wait 7 ready first poll: one-off fallback ran exactly once", counters.oneOffs, [["mcp", "serve"]]);
  check("--wait 7 ready first poll: exactly one health probe", counters.probes, 1);
  check("--wait 7 ready first poll: the old unconditional waitForHealth is gone", counters.waitForHealthCalls, 0);
  check("--wait 7 ready first poll: helper attempted once before the fallback", counters.helperCalls, 1);
  check("--wait 7 ready first poll: stdout stayed protocol-empty", stdout, "");
  check("--wait 7 ready first poll: a start line and a ready line, nothing else", [lines(stderr).length, lines(stderr)[0]?.includes("waiting"), lines(stderr)[1]?.includes("ready")], [2, true, true]);
}

// --- 2. waitForGateway directly, ready after N polls: exact arithmetic on a fake clock ----------

{
  const readyResults = [false, false, true];
  let readyCalls = 0;
  let clock = 0;
  const sleeps: number[] = [];
  const result = await waitForGateway(async () => readyResults[Math.min(readyCalls++, readyResults.length - 1)] ?? true, {
    waitSeconds: 60,
    intervalMs: 500,
    now: () => clock,
    sleep: async (ms: number) => { sleeps.push(ms); clock += ms; },
  });
  check("ready after N polls: result", result, "ready");
  check("ready after N polls: exactly one ready() per poll", readyCalls, 3);
  check("ready after N polls: N-1 sleeps", sleeps, [500, 500]);
  check("ready after N polls: the fake clock advanced only by the sleeps", clock, 1000);
}

// --- 3. never ready: the loop stops at the deadline ----------------------------------------------
// waitSeconds 6, interval 2000, deadline fixed at 6000 BEFORE the first probe: ready() runs
// at 0, 2000, 4000, 6000 (the deadline check comes after ready(), and 6000 >= 6000 stops
// it) — 4 calls, 3 sleeps. One more ready() call or sleep and the bound leaks.

{
  let readyCalls = 0;
  let clock = 0;
  let sleeps = 0;
  const result = await waitForGateway(async () => { readyCalls += 1; return false; }, {
    waitSeconds: 6,
    now: () => clock,
    sleep: async (ms: number) => { sleeps += 1; clock += ms; },
  });
  check("never ready: result", result, "timeout");
  check("never ready: the loop stopped exactly at the deadline (4 ready calls)", readyCalls, 4);
  check("never ready: 3 sleeps of the default interval", sleeps, 3);
}

// --- 4. waitSeconds 0: opt-out, ready() never called ------------------------------------------------------------

{
  let readyCalls = 0;
  let sleeps = 0;
  const result = await waitForGateway(async () => { readyCalls += 1; return true; }, {
    waitSeconds: 0,
    now: () => 0,
    sleep: async () => { sleeps += 1; },
  });
  check("waitSeconds 0: still ready", result, "ready");
  check("waitSeconds 0: ready() never called", readyCalls, 0);
  check("waitSeconds 0: no sleeps", sleeps, 0);
}

// --- 5. timeout through the command: the die() refusal, and the order around it ------------------
// Trace order: parse → requireBootstrapped → info(waiting) → [isRunning, probe] per poll →
// die. The helper attempt is AFTER the wait, so a timeout never reaches it. --wait 1 with
// the real 2s default interval costs one real sleep (~2s) on this fake runtime.

{
  const { runtime, counters } = makeRuntime({ probe: async () => 503 });
  let thrown: unknown;
  const { stdout, stderr } = await capture(async () => {
    try { await mcpServe(contextOf(runtime), ["--wait", "1"]); } catch (error) { thrown = error; }
  });
  checkTrue("--wait 1 never ready: the timeout refusal is a UserError", thrown instanceof UserError);
  if (thrown instanceof UserError) {
    check("--wait 1 never ready: the message names the seconds, the healthz probe and the status command", [thrown.message.includes("1s"), thrown.message.includes("healthz"), thrown.message.includes("status")], [true, true, true]);
    checkTrue("--wait 1 never ready: the refusal carries structured advice", thrown.advice.length > 0 && renderAdvice(thrown.advice[0]).endsWith("up"));
  }
  check("--wait 1 never ready: the bridge never started", counters.oneOffs, []);
  check("--wait 1 never ready: the helper attempt never ran (the wait comes first)", counters.helperCalls, 0);
  check("--wait 1 never ready: the old waitForHealth is gone", counters.waitForHealthCalls, 0);
  check("--wait 1 never ready: stdout stayed protocol-empty", stdout, "");
  check("--wait 1 never ready: only the start line, no ready line", [lines(stderr).length, lines(stderr)[0]?.includes("waiting")], [1, true]);
}

// --- 6. gateway not ready on the first poll, ready on the second: the bridge starts once ----------
// The command's interval is the real 2 s default, so this scenario costs one real sleep.

{
  let probeCalls = 0;
  const { runtime, counters } = makeRuntime({ probe: async () => { probeCalls += 1; return probeCalls === 1 ? 503 : 200; } });
  const { stdout, stderr } = await capture(async () => { await mcpServe(contextOf(runtime), []); });
  check("default wait, ready on the second poll: two probes", counters.probes, 2);
  check("default wait, ready on the second poll: the bridge started exactly once, after the wait", [counters.oneOffs.length, counters.helperCalls], [1, 1]);
  check("default wait, ready on the second poll: stdout stayed protocol-empty", stdout, "");
  check("default wait, ready on the second poll: a start line and a ready line", lines(stderr).length, 2);
}

// --- 7. not bootstrapped: the guard fires before any probing --------------------------------------

{
  let probes = 0;
  const { runtime } = makeRuntime({
    isRunning: async () => { throw new NotBootstrapped("/srv/mcp-wait-check/data"); },
    probe: async () => { probes += 1; return 200; },
  });
  let thrown: unknown;
  const { stdout, stderr } = await capture(async () => {
    try { await mcpServe(contextOf(runtime), ["--wait", "5"]); } catch (error) { thrown = error; }
  });
  checkTrue("not bootstrapped: the guard's refusal, not a raw NotBootstrapped", thrown instanceof UserError);
  if (thrown instanceof UserError) checkTrue("not bootstrapped: NotBootstrapped's own message", thrown.message.includes("bootstrapped"));
  check("not bootstrapped: no probe before the refusal", probes, 0);
  check("not bootstrapped: the wait never started", lines(stderr).length, 0);
  check("not bootstrapped: stdout stayed protocol-empty", stdout, "");
}

// --- 8. --wait 0 end to end: skip the wait, still serve --------------------------------------------

{
  const { runtime, counters } = makeRuntime();
  const { stdout, stderr } = await capture(async () => { await mcpServe(contextOf(runtime), ["--wait", "0"]); });
  check("--wait 0: no health probe", counters.probes, 0);
  check("--wait 0: the old waitForHealth is gone", counters.waitForHealthCalls, 0);
  check("--wait 0: the bridge ran exactly once", counters.oneOffs, [["mcp", "serve"]]);
  check("--wait 0: stdout stayed protocol-empty", stdout, "");
  check("--wait 0: no progress lines at all", lines(stderr).length, 0);
}

// --- 9. the boundedCount kind: the parse stage refuses the bound and non-digits --------------------
// 601 and "abc" both leave the command before run: parseCall converts --wait through
// boundedCountValue(600), whose single refusal sentence covers both mistakes.

for (const raw of ["601", "abc"]) {
  const { runtime, counters } = makeRuntime();
  let thrown: unknown;
  await capture(async () => { try { await mcpServe(contextOf(runtime), ["--wait", raw]); } catch (error) { thrown = error; } });
  checkTrue(`--wait ${raw}: refused by the value kind`, thrown instanceof Error);
  if (thrown instanceof Error) {
    // The kind owns the wording; what must hold is that the refusal names the option, the bound and the value.
    check(`--wait ${raw}: the refusal names the option, the bound and the value`, [thrown.message.includes("--wait"), thrown.message.includes("600"), thrown.message.includes(JSON.stringify(raw))], [true, true, true]);
  }
  check(`--wait ${raw}: the command body never ran`, [counters.isRunningCalls, counters.oneOffs.length], [0, 0]);
}

finish("mcp-serve-wait");

// `logs` and `recipe logs` under an output sink.
//
// Both used to be unreachable over MCP for the same reason: following a log never returns,
// and a tool call owes its client exactly one result. They are now one capability with two
// shapes, chosen by how the output is being consumed — so what this covers is that the
// choice is actually made, in both directions, and that the follow path is never taken when
// nobody can interrupt it.

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { recipe } from "#framework/commands/management/recipe/index.ts";
import { useDeployment, useComposeProjectOverride } from "#framework/runtime/deployment.ts";
import { useRecipesDir } from "#framework/service/recipe.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { withOutputSink, outputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import { check, finish } from "#checks/kit/harness.ts";
import type { RuntimeLogRecord } from "#framework/runtime/runtime.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";

// Expected text lines, built structurally so no prose literal sits in an expected operand.
const lineText = (...words: string[]): string => words.join(" ") + "\n";

useDeployment(resolve(monorepoRoot, "apps", "example app"));
useComposeProjectOverride("example-app");

// "On a terminal" below means shouldFollow()'s actual terminal case: not captured AND a real
// TTY. This check process itself has no TTY (it runs under the check runner), so that has to
// be simulated explicitly — see output.ts's shouldFollow() for why isCaptured() alone is not
// the same question.
const originalIsTTY = process.stdout.isTTY;
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

// --- the service log ------------------------------------------------------------------------

interface Seen {
  followed: boolean;
  followRest?: string[];
  readTail?: string;
  readRest?: string[];
  readRecordsTail?: string;
  readRecordsRest?: string[];
}

// Records the fake runtime hands back on --json: one with known fields, one without, and an
// escape sequence inside the text so --no-color's stripping is observable in both modes.
const fakeRecords: RuntimeLogRecord[] = [
  { ts: "2024-01-02T10:00:00.000000000Z", stream: "stdout", service: "app-1", text: "\u001B[31mred\u001B[0m line" },
  { text: "plain line" },
];
const jsonLines = fakeRecords.map((record) => `${JSON.stringify(record)}\n`).join("");

// The same records after --no-color's stripAnsi: only the first text contains escapes, and
// the other fields are kept as-is (both commands map({...record, text: stripAnsi(text)})).
const strippedRecords: RuntimeLogRecord[] = [
  { ts: "2024-01-02T10:00:00.000000000Z", stream: "stdout", service: "app-1", text: "red line" },
  { text: "plain line" },
];
const jsonNoColorLines = strippedRecords.map((record) => `${JSON.stringify(record)}\n`).join("");

function ctxWith(seen: Seen, logText = "line one\nline two\n"): Context {
  return {
    settings: { dataDir: "/srv/openclaw/data", env: {} },
    runtime: {
      async isRunning(): Promise<boolean> { return true; },
      async followLogs(rest: string[] = []): Promise<void> {
        seen.followed = true;
        seen.followRest = rest;
        // Simulates a chunk arriving mid-stream, the same way the real transport hands text
        // to whatever sink is active — a no-op unless --grep installed one (grepFollowSink).
        outputSink()?.("kept line\ndropped line\n");
      },
      async readLogs(tail?: string, rest: string[] = []): Promise<string> {
        seen.readTail = tail;
        seen.readRest = rest;
        return logText;
      },
      async readLogRecords(tail?: string, rest: string[] = []): Promise<RuntimeLogRecord[]> {
        seen.readRecordsTail = tail;
        seen.readRecordsRest = rest;
        return fakeRecords;
      },
    },
  } as unknown as Context;
}

// A ctx whose follow emits one fixed chunk through the ACTIVE output sink (the strip sink
// when --no-color installed one): lets the follow-time blocks control exactly what streams.
function emitCtx(seen: Seen, chunk: string): Context {
  const ctx = ctxWith(seen);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ctx as any).runtime.followLogs = async (rest: string[] = []): Promise<void> => {
    seen.followed = true;
    seen.followRest = rest;
    outputSink()?.(chunk);
  };
  return ctx;
}

// --- --since: validated rather than passed through unchecked --------------------------------

for (const bad of ["", "10", "1x", "not-a-date", "10m "]) {
  let threw = false;
  try {
    await withOutputSink(() => {}, async () => {
      await openclawCommands.logs.run(ctxWith({ followed: false }), ["--since", bad]);
    });
  } catch {
    threw = true;
  }
  check(`--since "${bad}" is refused`, threw, true);
}

{
  let threw = false;
  try {
    await openclawCommands.logs.run(ctxWith({ followed: false }), ["--since"]);
  } catch {
    threw = true;
  }
  check("--since with no value is refused", threw, true);
}

for (const good of ["10m", "2h", "1h30m", "45s", "2024-01-02", "2024-01-02T15:04:05Z", "2024-01-02T15:04:05.123+02:00"]) {
  const seen: Seen = { followed: false };
  await withOutputSink(() => {}, async () => {
    await openclawCommands.logs.run(ctxWith(seen), ["--since", good]);
  });
  check(`--since "${good}" is accepted and still reaches the runtime`, seen.readRest, ["--since", good]);
}

// The refusal happens during argument validation, before run() ever touches the runtime —
// a counting fake proves no call slips through first.
{
  let calls = 0;
  const counting = {
    async isRunning(): Promise<boolean> { calls += 1; return true; },
    async followLogs(): Promise<void> { calls += 1; },
    async readLogs(): Promise<string> { calls += 1; return ""; },
    async readLogRecords(): Promise<RuntimeLogRecord[]> { calls += 1; return []; },
  };
  const ctx = { settings: { dataDir: "/srv/openclaw/data", env: {} }, runtime: counting } as unknown as Context;
  let threw = false;
  try {
    await openclawCommands.logs.run(ctx, ["--since", "not-a-date"]);
  } catch {
    threw = true;
  }
  check("an invalid --since is still refused with the counting runtime", threw, true);
  check("an invalid --since makes ZERO runtime calls", calls, 0);
}

// --- --grep: a bad pattern is refused, a good one filters lines both ways -------------------

for (const bad of ["(", "[", "*"]) {
  let threw = false;
  try {
    await withOutputSink(() => {}, async () => {
      await openclawCommands.logs.run(ctxWith({ followed: false }), ["--grep", bad]);
    });
  } catch {
    threw = true;
  }
  check(`--grep "${bad}" (invalid regex) is refused`, threw, true);
}

{
  let threw = false;
  try {
    await openclawCommands.logs.run(ctxWith({ followed: false }), ["--grep"]);
  } catch {
    threw = true;
  }
  check("--grep with no value is refused", threw, true);
}

{
  const seen: Seen = { followed: false };
  const written: string[] = [];
  await withOutputSink((chunk) => written.push(chunk), async () => {
    await openclawCommands.logs.run(ctxWith(seen), ["--since", "10m", "--grep", "two"]);
  });
  check("--grep never reaches the runtime as an argument", seen.readRest, ["--since", "10m"]);
  check("--grep filters the bounded read down to the matching line", written.join(""), lineText("line", "two"));
}

{
  const written: string[] = [];
  await withOutputSink((chunk) => written.push(chunk), async () => {
    await openclawCommands.logs.run(ctxWith({ followed: false }), ["--grep", "nomatch"]);
  });
  check("--grep with nothing matching returns nothing", written.join(""), "");
}

// --- a stray token is refused instead of forwarded as a compose service name ----------------

{
  let threw = false;
  let message = "";
  try {
    await withOutputSink(() => {}, async () => {
      await openclawCommands.logs.run(ctxWith({ followed: false }), ["extra"]);
    });
  } catch (error) {
    threw = true;
    message = error instanceof Error ? error.message : String(error);
  }
  check("a bare extra token is refused rather than read as another service name", threw, true);
  check("the refusal names the stray token", message.includes("extra"), true);
}

{
  let threw = false;
  try {
    await withOutputSink(() => {}, async () => {
      await openclawCommands.logs.run(ctxWith({ followed: false }), ["--bogus"]);
    });
  } catch {
    threw = true;
  }
  check("an undeclared flag is refused", threw, true);
}

{
  const seen: Seen = { followed: false };
  await openclawCommands.logs.run(ctxWith(seen), []);
  check("on a terminal the log is followed", seen.followed, true);
  check("nothing is read in bounded form on a terminal", seen.readTail === undefined && seen.readRest === undefined, true);
}

{
  // --grep while following: inherited stdio (the plain terminal case above) cannot be
  // filtered by this process at all, so this path trades it for a piped one it CAN filter
  // (openclawCommands.logs.run()'s withOutputSink(grepFollowSink(...), ...)) — asserted here by capturing what
  // reaches the real process.stdout.write instead of the fake sink used everywhere else in
  // this file, since a real write is exactly what a filtered follow still owes the terminal.
  const seen: Seen = { followed: false };
  const written: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout.write as any) = (chunk: string): boolean => {
    written.push(chunk);
    return true;
  };
  try {
    await openclawCommands.logs.run(ctxWith(seen), ["--grep", "kept"]);
  } finally {
    process.stdout.write = originalWrite;
  }
  check("on a terminal with --grep the log is still followed", seen.followed, true);
  check("--grep does not reach the runtime as an argument while following either", seen.followRest, []);
  check("--grep filters a followed stream down to the matching lines", written.join(""), lineText("kept", "line"));
}

{
  const seen: Seen = { followed: false };
  const written: string[] = [];
  await withOutputSink((chunk) => written.push(chunk), async () => {
    await openclawCommands.logs.run(ctxWith(seen), ["--tail", "50", "--since", "1h"]);
  });

  check("under a sink the log is read, not followed", seen.followed, false);
  check("the declared --tail reaches the runtime", seen.readTail, "50");
  check("the remaining arguments still reach the runtime", seen.readRest, ["--since", "1h"]);
  check("the lines are handed back as the result", written.join(""), lineText("line", "one") + lineText("line", "two"));
}

{
  const seen: Seen = { followed: false };
  await withOutputSink(() => {}, async () => {
    await openclawCommands.logs.run(ctxWith(seen), []);
  });
  check("without --tail the runtime decides the bound, not this command", seen.readTail, undefined);
}

// --- --json: records instead of text, and always a bounded read -----------------------------

{
  const seen: Seen = { followed: false };
  const written: string[] = [];
  await withOutputSink((chunk) => written.push(chunk), async () => {
    await openclawCommands.logs.run(ctxWith(seen), ["--json", "--tail", "50", "--since", "1h"]);
  });
  check("--json reads the records API with the same --tail/--since", [seen.readRecordsTail, seen.readRecordsRest], ["50", ["--since", "1h"]]);
  check("--json emits one JSON object per line, undefined fields dropped", written.join(""), jsonLines);
}

{
  // No sink: on a TTY the plain log would follow — only --json keeps this bounded.
  const seen: Seen = { followed: false };
  await openclawCommands.logs.run(ctxWith(seen), ["--json", "--tail", "5"]);
  check("--json reads bounded even on a terminal", seen.readRecordsTail, "5");
  check("--json never follows, terminal or not", seen.followed, false);
}

// --- --no-color: strips embedded ANSI in both output shapes --------------------------------

{
  const seen: Seen = { followed: false };
  const written: string[] = [];
  await withOutputSink((chunk) => written.push(chunk), async () => {
    await openclawCommands.logs.run(ctxWith(seen, "\u001B[31mred\u001B[0m line\nplain line\n"), ["--no-color"]);
  });
  check("--no-color strips escape sequences from the bounded read", written.join(""), lineText("red", "line") + lineText("plain", "line"));
}

{
  const seen: Seen = { followed: false };
  const written: string[] = [];
  await withOutputSink((chunk) => written.push(chunk), async () => {
    await openclawCommands.logs.run(ctxWith(seen), ["--json", "--no-color"]);
  });
  check("--json --no-color strips the record text before serialising", written.join(""), jsonNoColorLines);
}

{
  const seen: Seen = { followed: false };
  await openclawCommands.logs.run(ctxWith(seen), ["--no-color", "--since", "1h"]);
  check("--no-color reaches the runtime as an argument while following, after --since", seen.followRest, ["--since", "1h", "--no-color"]);
}

// follow + --no-color: the strip sink replaces plain stdio, so the stripping is observed by
// capturing what reaches the REAL process.stdout.write (the sink's default collector).
{
  const seen: Seen = { followed: false };
  const written: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout.write as any) = (chunk: string): boolean => {
    written.push(chunk);
    return true;
  };
  try {
    await openclawCommands.logs.run(emitCtx(seen, "\u001B[31mred\u001B[0m line\nplain line\n"), ["--since", "1h", "--no-color"]);
  } finally {
    process.stdout.write = originalWrite;
  }
  check("follow + --no-color forwards --since then --no-color to the runtime", seen.followRest, ["--since", "1h", "--no-color"]);
  check("follow + --no-color strips embedded codes on the way to stdout", written.join(""), lineText("red", "line") + lineText("plain", "line"));
}

// follow + --no-color + --grep: the filter sits DOWNSTREAM of the strip sink, so it matches
// against text the escapes are already gone from.
{
  const seen: Seen = { followed: false };
  const written: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout.write as any) = (chunk: string): boolean => {
    written.push(chunk);
    return true;
  };
  try {
    await openclawCommands.logs.run(emitCtx(seen, "\u001B[32mkept\u001B[0m green\ndropped\n"), ["--since", "10m", "--no-color", "--grep", "green"]);
  } finally {
    process.stdout.write = originalWrite;
  }
  check("follow + --no-color + --grep still forwards --since then --no-color", seen.followRest, ["--since", "10m", "--no-color"]);
  check("the matching line reaches stdout stripped, the rest filtered", written.join(""), "kept green\n");
}

// --- a recipe's log --------------------------------------------------------------------------

// A real recipe.json in a scratch directory, the same way recipe.check.ts does it:
// loadRecipe reads the file, so a fixture on disk is the only thing that exercises it.
const scratch = await mkdtemp(join(tmpdir(), "clawwright-logs-bounded-check-"));
await mkdir(resolve(scratch, "sample"), { recursive: true });
await writeFile(
  resolve(scratch, "sample", "recipe.json"),
  JSON.stringify({ description: "sample recipe", enabled: true }),
  "utf8",
);
useRecipesDir(scratch);

function recipeCtx(seen: Seen): Context {
  return {
    settings: { dataDir: "/srv/openclaw/data", env: {} },
    runtime: {
      stack() {
        return {
          async followLogs(rest: string[] = []): Promise<void> {
            seen.followed = true;
            seen.followRest = rest;
          },
          async readLogs(tail: string, extraArgs: string[] = []): Promise<string> {
            seen.readTail = tail;
            seen.readRest = extraArgs;
            return "recipe line\n";
          },
          async readLogRecords(tail: string, extraArgs: string[] = []): Promise<RuntimeLogRecord[]> {
            seen.readRecordsTail = tail;
            seen.readRecordsRest = extraArgs;
            return fakeRecords;
          },
        };
      },
    },
  } as unknown as Context;
}

{
  const seen: Seen = { followed: false };
  const written: string[] = [];
  await withOutputSink((chunk) => written.push(chunk), async () => {
    await recipe(recipeCtx(seen), ["logs", "sample", "--tail", "20"]);
  });

  check("a recipe's log is read under a sink instead of refusing", seen.followed, false);
  check("the recipe log honours --tail", seen.readTail, "20");
  check("the recipe's lines are handed back", written.join(""), "recipe line\n");
}

{
  const seen: Seen = { followed: false };
  await recipe(recipeCtx(seen), ["logs", "sample"]);
  check("on a terminal a recipe's log is still followed", seen.followed, true);
}

{
  const seen: Seen = { followed: false };
  const written: string[] = [];
  await withOutputSink((chunk) => written.push(chunk), async () => {
    await recipe(recipeCtx(seen), ["logs", "sample", "--json", "--tail", "5", "--since", "10m", "--no-color"]);
  });
  check("recipe logs --json reads records with tail, then --since and --no-color", [seen.readRecordsTail, seen.readRecordsRest], ["5", ["--since", "10m", "--no-color"]]);
  check("recipe logs --json emits one JSON object per line with stripped text", written.join(""), jsonNoColorLines);
}

{
  const seen: Seen = { followed: false };
  await recipe(recipeCtx(seen), ["logs", "sample", "--no-color", "--since", "1h"]);
  check("a followed recipe log forwards --since then --no-color", seen.followRest, ["--since", "1h", "--no-color"]);
}

await rm(scratch, { recursive: true, force: true });
Object.defineProperty(process.stdout, "isTTY", { value: originalIsTTY, configurable: true });

// Piped/redirected (no sink, no TTY — a script or an agent's shell tool) must not follow
// either: that gap is exactly what shouldFollow() exists to close over plain isCaptured().
Object.defineProperty(process.stdout, "isTTY", { value: undefined, configurable: true });
{
  const seen: Seen = { followed: false };
  const written: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout.write as any) = (chunk: string): boolean => {
    written.push(chunk);
    return true;
  };
  try {
    await openclawCommands.logs.run(ctxWith(seen), []);
  } finally {
    process.stdout.write = originalWrite;
  }
  check("piped/redirected (no TTY, no sink) reads bounded instead of following", seen.followed, false);
  check("and still hands back the lines, to stdout rather than a sink", written.join(""), lineText("line", "one") + lineText("line", "two"));
}
Object.defineProperty(process.stdout, "isTTY", { value: originalIsTTY, configurable: true });

finish("logs-bounded");

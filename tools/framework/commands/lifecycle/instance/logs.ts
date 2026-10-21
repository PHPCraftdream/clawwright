// `logs`: bounded read or live follow, with --tail/--since/--grep, plus --no-color and
// --json shaping of the bounded output. On a followed stream --no-color installs an
// ansiStripSink() so codes the service embedded are stripped live (compose's own --no-color
// only covers compose's colouring).

import { shouldFollow, emitRaw, withOutputSink } from "#src/core/io/output.ts";
import { requireBootstrapped, jsonLogLines } from "#src/runtime/runtime.ts";
import * as kinds from "#src/core/values/kinds.ts";
import { commandBody, type ArgumentSpec } from "#src/core/command/spec.ts";
import { stripAnsi } from "#src/runtime/docker/compose-operations.ts";

export const SINCE_ARGUMENT = { name: "since", summary: "Lines at or after this time", description: "Only lines at or after this duration/timestamp (10m, 2h, 1h30m, or RFC3339/ISO)", kind: "option", valueName: "duration|timestamp", value: kinds.since } as const satisfies ArgumentSpec;

export const NO_COLOR_ARGUMENT = { name: "no-color", summary: "Strip ANSI escape sequences", description: "Remove ANSI escape sequences (colour and cursor control) from the output, including codes embedded in the log lines themselves", kind: "flag", effect: "read" } as const satisfies ArgumentSpec;

export const JSON_ARGUMENT = { name: "json", summary: "One JSON object per line", description: "Emit each line as a JSON object (ts, service, stream when known, text) instead of plain text; reads a bounded tail even on a terminal", kind: "flag", effect: "read" } as const satisfies ArgumentSpec;

export const LOGS_ARGUMENTS = [
  { name: "tail", description: "Lines to return", kind: "option", valueName: "n", value: kinds.count("a number of lines") },
  SINCE_ARGUMENT,
  { name: "grep", description: "Only matching lines", kind: "option", valueName: "pattern", value: kinds.pattern() },
  NO_COLOR_ARGUMENT,
  JSON_ARGUMENT,
] as const satisfies readonly ArgumentSpec[];

/** One capability, two shapes. On a terminal this follows the log until interrupted; anywhere
 *  else — an MCP call, a script, a redirect — following would never return, so it reads a
 *  bounded tail instead. See shouldFollow() for why that is not simply "not captured".
 *
 *  The switch is on how output is consumed, not a separate command — recipe.ts's logs action
 *  makes the same choice. Only the validated `--since` reaches the runtime; any other token
 *  is refused, never passed to compose as a service name. `--no-color` strips ANSI codes
 *  from the followed stream too (ansiStripSink, through the output sink); `--json` always
 *  reads a bounded tail, one record per line. */
export const LOGS = commandBody({
  effect: "read",
  arguments: LOGS_ARGUMENTS,
  async run(ctx, values) {
    const { tail, since, grep } = values;
    const noColor = values["no-color"] === true;
    const json = values.json === true;
    await requireBootstrapped(ctx);
    const rest = since === undefined ? [] : ["--since", since];

    if (shouldFollow() && !json) {
      if (noColor) rest.push("--no-color");
      if (noColor) {
        // A sink makes the output captured, so the child never inherits stdio. The strip
        // sink buffers INSIDE, so the downstream grep (when present) receives complete
        // stripped lines even when an escape sequence is split across chunks.
        const sink = grep === undefined ? ansiStripSink() : ansiStripSink(grepFollowSink(grep));
        await withOutputSink(sink, () => ctx.runtime.followLogs(rest));
        return;
      }
      if (grep === undefined) {
        await ctx.runtime.followLogs(rest);
        return;
      }
      // --grep alone: exactly as before --no-color existed, a piped stdio this process can
      // filter, with no strip sink in the way.
      await withOutputSink(grepFollowSink(grep), () => ctx.runtime.followLogs(rest));
      return;
    }

    if (json) {
      const records = await ctx.runtime.readLogRecords(tail === undefined ? undefined : String(tail), rest);
      const shaped = (noColor ? records.map((record) => ({ ...record, text: stripAnsi(record.text) })) : records)
        .filter((record) => grep === undefined || grep.test(record.text));
      // JSON.stringify drops undefined keys, so ts/service/stream appear only when known.
      emitRaw(jsonLogLines(shaped));
      return;
    }

    const output = await ctx.runtime.readLogs(tail === undefined ? undefined : String(tail), rest);
    const plain = noColor ? stripAnsi(output) : output;
    emitRaw(grep === undefined ? plain : filterLines(plain, grep));
  },
});

/** Keeps only the lines `pattern` matches, preserving a trailing newline when the input had
 *  one. The bounded read arrives as one string; grepFollowSink below does the same job for a
 *  stream that never does. */
function filterLines(text: string, pattern: RegExp): string {
  const endsWithNewline = text.endsWith("\n");
  const body = endsWithNewline ? text.slice(0, -1) : text;
  if (body === "") return "";
  const kept = body.split("\n").filter((line) => pattern.test(line));
  return kept.length === 0 ? "" : kept.join("\n") + (endsWithNewline ? "\n" : "");
}

/** A withOutputSink() collector for a followed log: buffers chunks into lines (a chunk is
 *  never guaranteed to end on one) and writes only the matching lines straight to stdout. A
 *  trailing partial line with no newline yet is held back and lost if the process is killed
 *  before the next chunk arrives — the same loss a piped `| grep` would show. */
function grepFollowSink(pattern: RegExp): (chunk: string) => void {
  let pending = "";
  return (chunk: string): void => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    const kept = lines.filter((line) => pattern.test(line));
    if (kept.length > 0) process.stdout.write(`${kept.join("\n")}\n`);
  };
}

/** Stateful sink that strips ANSI codes from a streamed log before anything downstream sees
 *  them. Buffers chunks and holds back a possibly-INCOMPLETE escape sequence at the end, so
 *  a sequence split across chunks is stripped whole instead of half-stripped; the stripped
 *  safe prefix goes to `collect` (default: real stdout), which lets --grep test text that is
 *  already clean. A dangling incomplete sequence when the process ends is lost — the same
 *  trade-off as grepFollowSink's trailing partial line. */
export function ansiStripSink(collect?: (text: string) => void): (chunk: string) => void {
  const write = collect ?? ((text: string) => process.stdout.write(text));
  // A trailing ESC, optionally followed by "[", parameter bytes and intermediates — i.e. a
  // sequence whose final byte has not arrived yet. Built from a char code, not a literal:
  // oxlint denies control characters inside regex literals.
  const incomplete = new RegExp(`${String.fromCharCode(27)}\\[?[0-?]*[ -/]*$`);
  let pending = "";
  return (chunk: string): void => {
    pending += chunk;
    const tail = incomplete.exec(pending);
    const safe = tail === null ? pending : pending.slice(0, tail.index);
    pending = tail === null ? "" : tail[0];
    if (safe !== "") write(stripAnsi(safe));
  };
}

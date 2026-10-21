// The pure merge/format core behind `logs --json`: docker not on a TTY delivers stdout and
// stderr as two separate blocks, so a plain per-stream tail is not the last N by time — the
// merge must interleave on docker timestamps and tail AFTER merging. Structure is matched on
// the ANSI-stripped line, but text is cut from the ORIGINAL line, so embedded colour codes
// survive in the text.

import { check, finish } from "#checks/kit/harness.ts";
import { stripAnsi, mergeLogStreams, formatLogRecords } from "#framework/runtime/docker/compose-operations.ts";
import { jsonLogLines, type RuntimeLogRecord } from "#framework/runtime/runtime.ts";
import { ansiStripSink } from "#framework/commands/lifecycle/instance/logs.ts";

// Expected-value builders: the compose line shape ("<service>  | <text>") and one NDJSON
// line, derived structurally so no prose literal sits in an expected operand.
const composeLine = (service: string, text: string): string => [service, text].join("  | ");
const barePrefix = (service: string): string => [service, "|"].join("  ");
const spaced = (...words: string[]): string => words.join(" ");
const jsonLine = (record: RuntimeLogRecord): string => JSON.stringify(record);
const cyan = "\u001B[36m";
const reset = "\u001B[0m";

// --- layout A (compose): interleaving and prefix handling ------------------------------------

{
  const merged = mergeLogStreams(
    "app-1  | 2024-01-02T10:00:00.000000000Z oldA\napp-1  | 2024-01-02T10:00:02.000000000Z oldC\n",
    "app-1  | 2024-01-02T10:00:01.000000000Z b\n",
  );
  check("interleaving orders across streams and strips the docker timestamp", merged.map((r) => r.text), [composeLine("app-1", "oldA"), composeLine("app-1", "b"), composeLine("app-1", "oldC")]);
  check("interleaved compose records carry the parsed service", merged.map((r) => r.service), ["app-1", "app-1", "app-1"]);
  check("interleaved records carry their stream", merged.map((r) => r.stream), ["stdout", "stderr", "stdout"]);
}

{
  const merged = mergeLogStreams(`${cyan}app-1${reset}  | 2024-01-02T10:00:00.000000000Z x\n`, "");
  check("an ANSI-coloured prefix is still parsed as the service", merged[0]?.service, "app-1");
  check("the colour codes stay in the text, docker timestamp removed", merged[0]?.text, [[cyan, "app-1", reset].join(""), "x"].join("  | "));
  const bare = mergeLogStreams(`${cyan}app-1${reset}  | 2024-01-02T10:00:00.000000000Z\n`, "");
  check("a prefix+timestamp-only line keeps the (stripped, trimmed) prefix as text", bare[0]?.text, barePrefix("app-1"));
}

{
  const merged = mergeLogStreams("app-1  | 2024-01-02T10:00:00.000000000Z\n", "");
  check("a prefix+timestamp-only line keeps the prefix, trailing space trimmed", merged[0]?.text, barePrefix("app-1"));
}

// --- layout B (plain `docker logs`) -----------------------------------------------------------

{
  const merged = mergeLogStreams("2024-01-02T10:00:00.000000000Z INFO boot\n", "");
  check("a plain docker line keeps the text without a service", [merged[0]?.service, merged[0]?.text], [undefined, spaced("INFO", "boot")]);
}

{
  const merged = mergeLogStreams("2024-01-02T10:00:00.000000000Z INFO 2024-01-02T10:00:05.000000000Z inner\n", "");
  check("a second (application) timestamp inside the text survives", merged[0]?.text, spaced("INFO", "2024-01-02T10:00:05.000000000Z", "inner"));
}

{
  const merged = mergeLogStreams("app-1  | 2024-01-02T10:00:00.000000000Z boot 2024-01-02T10:00:05.000000000Z inner\n", "");
  check("only the FIRST timestamp is docker's; a later one belongs to the text", merged[0]?.text, spaced(barePrefix("app-1"), "boot", "2024-01-02T10:00:05.000000000Z", "inner"));
}

// --- tail is applied AFTER merging, not per stream ---------------------------------------------

{
  const merged = mergeLogStreams(
    "2024-01-02T10:00:03.000000000Z app-1  | C3\n2024-01-02T10:00:01.000000000Z app-2  | A1\n",
    "2024-01-02T10:00:02.000000000Z app-3  | B2\n",
  );
  check("stdout-before-stderr input order is not kept: the merge orders by timestamp", merged.map((r) => r.text), [composeLine("app-2", "A1"), composeLine("app-3", "B2"), composeLine("app-1", "C3")]);
}

{
  const merged = mergeLogStreams(
    "2024-01-02T10:00:03.000000000Z app-1  | C3\n2024-01-02T10:00:01.000000000Z app-2  | A1\n",
    "2024-01-02T10:00:02.000000000Z app-3  | B2\n",
    1,
  );
  check("tail 1 after merging keeps the chronologically newest record, from stdout", merged.map((r) => [r.text, r.stream]), [[composeLine("app-1", "C3"), "stdout"]]);
}

{
  const merged = mergeLogStreams(
    "2024-01-02T10:00:00.000000000Z app-1  | old1\n2024-01-02T10:00:01.000000000Z app-1  | old2\n2024-01-02T10:00:02.000000000Z app-1  | old3\n",
    "2024-01-02T10:59:00.000000000Z app-1  | fresh\n",
    2,
  );
  check("tail keeps the last N after merging, not per stream", merged.map((r) => r.text), [composeLine("app-1", "old3"), composeLine("app-1", "fresh")]);
  check("the fresh line tail kept is the stderr one", merged[1]?.stream, "stderr");
}

{
  const zero = mergeLogStreams("2024-01-02T10:00:00.000000000Z app-1  | a\n", "", 0);
  check("tail 0 yields nothing", zero, []);
  const all = mergeLogStreams("2024-01-02T10:00:00.000000000Z app-1  | a\n", "2024-01-02T10:00:01.000000000Z app-1  | b\n");
  check("no tail keeps every merged record", all.map((r) => r.text), [composeLine("app-1", "a"), composeLine("app-1", "b")]);
}

// --- sub-millisecond and offset ordering --------------------------------------------------------

{
  const merged = mergeLogStreams(
    "app-1  | 2024-01-02T10:00:00.622100Z later\n",
    "app-1  | 2024-01-02T10:00:00.622092Z earlier\n",
  );
  check("same-millisecond timestamps order by the fractional digits", merged.map((r) => r.text), [composeLine("app-1", "earlier"), composeLine("app-1", "later")]);
}

{
  const merged = mergeLogStreams(
    "app-1  | 2024-01-02T13:26:49.5+02:00 offset\n",
    "app-1  | 2024-01-02T11:26:48.622092Z utc\n",
  );
  // 13:26:49.5+02:00 is the same instant as 11:26:49.5Z — half a second AFTER the utc line.
  check("an offset timestamp is compared by instant, not as a raw string", merged.map((r) => r.text), [composeLine("app-1", "utc"), composeLine("app-1", "offset")]);
}

{
  // No fractional seconds: 12:00:00+02:00 is 10:00:00Z, EARLIER than 11:00:00Z (raw-string order says the opposite).
  const merged = mergeLogStreams(
    "app-1  | 2024-01-02T11:00:00Z late\n",
    "app-1  | 2024-01-02T12:00:00+02:00 early\n",
  );
  check("a timestamp without a fraction is ordered by instant across offsets", merged.map((r) => r.text), [composeLine("app-1", "early"), composeLine("app-1", "late")]);
}

{
  // Mixed precision: none, 3 digits, 9 digits; ties on the leading digits break on the later ones.
  const merged = mergeLogStreams(
    "app-1  | 2024-01-02T10:00:00.123Z b\napp-1  | 2024-01-02T10:00:00.123000001Z c\n",
    "app-1  | 2024-01-02T10:00:00.122999999Z a\napp-1  | 2024-01-02T10:00:00Z z\n",
  );
  check("missing, 3-digit and 9-digit fractions order together", merged.map((r) => r.text), ["z", "a", "b", "c"].map((t) => composeLine("app-1", t)));
}

// --- stable sort on ties and inherited timestamps -----------------------------------------------

{
  const merged = mergeLogStreams(
    "2024-01-02T10:00:00.000000000Z app-1  | s\n",
    "2024-01-02T10:00:00.000000000Z app-1  | e\n",
  );
  check("equal timestamps put stdout first", merged.map((r) => r.stream), ["stdout", "stderr"]);
}

{
  const merged = mergeLogStreams(
    "2024-01-02T10:00:00.000000000Z a\ncontinuation\n",
    "2024-01-02T10:00:01.000000000Z app-1  | b\n",
  );
  check("an untimestamped line keeps its position next to its neighbour", merged.map((r) => r.text), ["a", "continuation", composeLine("app-1", "b")]);
  check("an untimestamped line inherits the previous ts (orders before 10:00:01)", merged[1]?.ts, "2024-01-02T10:00:00.000000000Z");

  const leading = mergeLogStreams("untimestamped\n", "2024-01-02T10:00:00.000000000Z app-1  | b\n");
  check("a stream starting untimestamped (ts \"\") sorts before a timestamped one", leading.map((r) => r.text), ["untimestamped", composeLine("app-1", "b")]);
}

// --- stripping and formatting --------------------------------------------------------------------

check("stripAnsi removes colour and cursor-control sequences", stripAnsi("\u001B[31mred\u001B[0m plain \u001B[1Kmore"), spaced("red", "plain", "more"));
check("stripAnsi leaves text without escapes unchanged", stripAnsi("plain text"), spaced("plain", "text"));

check("formatLogRecords of nothing is empty", formatLogRecords([]), "");
check("formatLogRecords joins with newlines and one trailing newline", formatLogRecords([{ text: "x" }, { text: "y" }]), "x\ny\n");

// Through the PRODUCTION serialiser, on real merge output — the shaped records the --json
// branch actually emits, undefined fields dropped by JSON.stringify.
{
  const merged: RuntimeLogRecord[] = mergeLogStreams(
    "app-1  | 2024-01-02T10:00:00.000000000Z hi\n",
    "2024-01-02T10:00:01.000000000Z plain\n",
  );
  check("jsonLogLines serialises merged records as NDJSON, undefined fields dropped", jsonLogLines(merged),
    [jsonLine({ ts: "2024-01-02T10:00:00.000000000Z", stream: "stdout", service: "app-1", text: "app-1  | hi" }), jsonLine({ ts: "2024-01-02T10:00:01.000000000Z", stream: "stderr", text: "plain" })].join("\n") + "\n");
}

// --- ansiStripSink: the follow-time stripper ------------------------------------------------------

{
  const collected: string[] = [];
  const sink = ansiStripSink((text) => collected.push(text));
  sink("a\u001B[3");
  sink("1mred\u001B[0mb\n");
  check("ansiStripSink reassembles an escape sequence split across chunks and strips it", collected.join(""), ["ared", "b", "\n"].join(""));
}

{
  const collected: string[] = [];
  const sink = ansiStripSink((text) => collected.push(text));
  sink("safe\u001B[3");
  check("a trailing incomplete escape sequence is held back, not emitted", collected.join(""), "safe");
}

{
  const collected: string[] = [];
  const sink = ansiStripSink((text) => collected.push(text));
  sink("keep this\u001B[31m coloured\n");
  check("a downstream filter (e.g. --grep) receives already-stripped text", collected.join(""), spaced("keep", "this", "coloured") + "\n");
}

finish("log-merge");

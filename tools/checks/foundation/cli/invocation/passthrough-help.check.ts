// Checks that `./clawwright cli --help` shows this framework's own help, like every other
// command, and that only a `--help` placed after a bare `--` reaches the wrapped tool.
//
// U7 (docs/internal/review-2026-09-29-round-13.md): `cli --help` used to always reach
// OpenClaw's own --help unconditionally (the removed passesThroughHelp flag), which meant a
// fresh, never-bootstrapped deployment answered "never been bootstrapped" instead of a help
// screen. requestsHelp (entry/cli.ts) now draws the same before-the-first-`--` boundary
// host's own parser (parseHostArgs) already drew.

import { defineApp } from "#framework/core/app.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { runApp, requestsHelp, requestsShortHelp } from "#framework/entry/cli.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { missingArgumentMessage } from "#framework/core/command/index.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

checkTrue("--help alone requests our own help", requestsHelp(["--help"]));
checkTrue("--help before a later -- still requests our own help", requestsHelp(["--help", "--", "x"]));
check("--help after a -- is the wrapped tool's own, not ours", requestsHelp(["--", "--help"]), false);
check("no --help anywhere requests nothing", requestsHelp(["config", "get", "x"]), false);

// The short spelling is ours only for the commands that pass nothing through (gate commands,
// control-mcp), through requestsShortHelp, and shares the same before-the-first-`--` boundary:
// `-h` after a bare `--` belongs to the wrapped tool's own parser. A deployment command keeps
// a literal `-h` (`exec df -h`): requestsHelp never reads it.
checkTrue("`-h` alone requests a pass-through-free command's own help", requestsShortHelp(["-h"]));
checkTrue("`-h` before a later -- still requests that help", requestsShortHelp(["-h", "--", "x"]));
check("`-h` after a `--` is the wrapped tool's own, not ours", requestsShortHelp(["--", "-h"]), false);
check("a deployment command passes `-h` through (exec df -h): requestsHelp ignores it", requestsHelp(["exec", "df", "-h"]), false);

const app = defineApp({ name: "passthrough-help-check", description: "fixture", commands: openclawCommands });

let output = "";
await withOutputSink((chunk) => { output += chunk; }, () => runApp(app, ["cli", "--help"]));
check("./clawwright cli --help prints our own summary, not OpenClaw's", output.includes(openclawCommands.cli.summary), true);

// Empty argv is refused by the parser — the verbatim variadic is declared required — so the
// refusal is the parser's own voice on every path, not a hand-written usage branch in the
// command body.
for (const name of ["cli", "exec"] as const) {
  let refused = "";
  try {
    await withOutputSink((chunk) => { refused += chunk; }, () => runApp(app, [name]));
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
  }
  check(`./clawwright ${name} with no arguments is refused by the parser`,
    refused.includes(missingArgumentMessage(name, "<args…>")), true);
}

finish("passthrough-help");

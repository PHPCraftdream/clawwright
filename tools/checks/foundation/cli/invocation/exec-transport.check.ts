// The staging copy `clawwright cli --file` leaves on the target never travels in an archive, and
// the transport's terminal-streaming decision is independent of finite input (a --stdin run
// still streams its output to the terminal).

import { excludesFor } from "#framework/service/archive/index.ts";
import { PRIVATE_STAGING_MARKER } from "#framework/runtime/transport/quoting.ts";
import { terminalStreaming } from "#framework/runtime/transport/exec.ts";
import { regexEscape } from "#framework/core/io/log.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

// --- the terminal-streaming decision, as a pure truth table ----------------------------------------------

{
  const facts = { protocol: false, stream: true, hasSink: false, stdoutTty: true, stderrTty: true };
  const cases: [string, Partial<typeof facts>, boolean][] = [
    ["a streaming request on a real terminal streams", {}, true],
    ["no stream request does not stream", { stream: false }, false],
    ["an output sink captures instead of streaming", { hasSink: true }, false],
    ["a piped stdout does not stream", { stdoutTty: false }, false],
    ["a piped stderr does not stream", { stderrTty: false }, false],
    ["the stdio protocol never streams", { protocol: true }, false],
  ];
  for (const [name, change, expected] of cases) check(name, terminalStreaming({ ...facts, ...change }), expected);
}

// --- the staging family never travels in archives -----------------------------------------------------------

{
  // tar itself applies these globs at run time and the framework keeps no matcher of its own
  // (neighbouring archive checks pin the pattern lists with membership), so both halves are
  // pinned: the new literal family is present in every profile's exclusion list, the marker
  // families (an interrupted publish's temp siblings) stay excluded, and a staged entry's
  // real name is matched by the family under tar's glob semantics, where a `*` crosses `/`.
  const stagedEntry = "data/config/clawwright-cli-input-0123456789abcdef";
  const markerEntry = `data/config/clawwright-cli-input-0123456789abcdef${PRIVATE_STAGING_MARKER}fedcba9876543210`;
  const family = (dataName: string): string => `${dataName}/*${PRIVATE_STAGING_MARKER}*`;
  const tarGlob = (pattern: string, name: string): boolean =>
    new RegExp(`^${regexEscape(pattern).replaceAll("\\*", ".*")}$`).test(name);
  for (const profile of ["full", "migrate", "share"] as const) {
    checkTrue(`the cli-input family is excluded (${profile})`, excludesFor(profile, "data").includes("data/config/clawwright-cli-input-*"));
    checkTrue(`the staging marker families stay excluded (${profile})`, excludesFor(profile, "data").includes(family("data")));
    checkTrue(`a staged payload entry matches the cli-input family (${profile})`, tarGlob("data/config/clawwright-cli-input-*", stagedEntry));
    checkTrue(`an interrupted publish's temp sibling matches the marker family (${profile})`, tarGlob(family("data"), markerEntry));
  }
}

finish("exec transport");

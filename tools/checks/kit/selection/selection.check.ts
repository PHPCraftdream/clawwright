// Meta-check for the related-selection data: every rule and always filter must name real check
// files, the glob matcher must behave, and — the ratchet — every check file must be either
// reachable in the real import graph (from some non-check source file) or selected by a rule;
// whatever is neither must appear in UNREACHABLE, an explicit allowlist with a reason per entry.
// The allowlist may only shrink: entries that become reachable are removed by this check, and
// adding a new invisible check requires naming it here with its reason.

import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { buildImportGraph, selectRelatedChecks } from "./import-graph.ts";
import { discoverChecks } from "#checks/kit/run.ts";
import { RULES, matchGlob } from "./rules.ts";
import { alwaysFilters } from "./always.ts";

// --- glob matcher -------------------------------------------------------------------------------

check("glob.star.within.segment", matchGlob("docs/*.md", "docs/readme.md"), true);
checkTrue("glob.star.does.not.cross.slash", !matchGlob("docs/*.md", "docs/sub/readme.md"));
check("glob.double.star.crosses.segments", matchGlob("docs/**/*.md", "docs/a/b/readme.md"), true);
check("glob.double.star.crosses.segments", matchGlob("docs/**/*.md", "docs/a/b/readme.md"), true);
check("glob.double.star.also.matches.zero.directories", matchGlob("docs/**/*.md", "docs/readme.md"), true);
checkTrue("glob.dir.double.star.matches.deep", matchGlob("packages/clawwright/**", "packages/clawwright/core/env.ts"));
checkTrue("glob.dir.double.star.matches.file.at.root.of.dir", matchGlob("packages/clawwright/**", "packages/clawwright/index.ts"));
check("glob.question.mark.single.char", matchGlob("check-?.ts", "check-1.ts"), true);
checkTrue("glob.question.mark.rejects.two.chars", !matchGlob("check-?.ts", "check-12.ts"));
checkTrue("glob.question.mark.does.not.cross.slash", !matchGlob("a/?", "a/b/c"));
check("glob.exact.path", matchGlob("package.json", "package.json"), true);
checkTrue("glob.exact.path.rejects.prefix", !matchGlob("package.json", "x/package.json"));
checkTrue("glob.literal.dot.is.literal", !matchGlob("a.b", "aXb"));
checkTrue("glob.rejects.unrelated", !matchGlob("docs/**", "src/readme.md"));

// --- rules and always filters name real checks ---------------------------------------------------

const discovered = await discoverChecks();
const labels = discovered.map((entry) => entry.label);

for (const rule of RULES) {
  for (const filter of rule.select) {
    check(
      `rule.filter.matches.a.check: ${filter}`,
      labels.some((label) => label.includes(filter)),
      true,
    );
  }
  check(`rule.changed.has.patterns: ${rule.select[0]}`, rule.changed.length > 0, true);
}
for (const entry of alwaysFilters()) {
  check(`always.filter.matches.a.check: ${entry.filter}`, labels.some((label) => label.includes(entry.filter)), true);
}

// --- coverage ratchet -----------------------------------------------------------------------------

// Check files the real import graph reaches from any non-check source file under tools/.
const graph = buildImportGraph();
const nonCheckSources = [...graph.keys()].filter((file) => !file.endsWith(".check.ts"));
const reachable = selectRelatedChecks(graph, nonCheckSources).reachableChecks;

// Rule-selected check files, for the same label set.
const ruleSelected = new Set<string>();
for (const rule of RULES) {
  for (const filter of rule.select) {
    for (const label of labels) if (label.includes(filter)) ruleSelected.add(label);
  }
}

/** Check files that are neither graph-reachable nor rule-selected — each with its reason for
 *  staying invisible. Ratchet: entries must be removed once reachable; new entries need a reason. */
const UNREACHABLE: readonly { readonly label: string; readonly reason: string }[] = [];

const missing = labels
  .filter((label) => !reachable.has("tools/checks/" + label) && !ruleSelected.has(label))
  .filter((label) => !UNREACHABLE.some((entry) => entry.label === label));
check("coverage.every.unreachable.check.is.in.the.allowlist", missing, []);

// The allowlist must stay honest: no entry may have become reachable or rule-selected, and every
// entry must still name an existing check.
const stale = UNREACHABLE
  .filter((entry) => reachable.has("tools/checks/" + entry.label) || ruleSelected.has(entry.label))
  .map((entry) => entry.label);
check("coverage.allowlist.has.no.stale.entries", stale, []);
const gone = UNREACHABLE.filter((entry) => !labels.includes(entry.label)).map((entry) => entry.label);
check("coverage.allowlist.names.existing.checks", gone, []);
check("coverage.allowlist.entries.carry.reasons", UNREACHABLE.every((entry) => entry.reason.length > 0), true);

finish("kit-selection-rules");

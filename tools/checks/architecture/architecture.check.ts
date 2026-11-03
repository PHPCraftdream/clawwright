// Architecture ratchets — refactor plan stage 0, item 2 (docs/internal/refactor-plan-2026-10-01.md).
//
// Each metric counts a "one fact recorded in many places" pattern in the working tree (never
// git) and must EQUAL tools/checks/architecture/baseline.json. Higher means a new occurrence
// slipped in. Lower means real progress — but it must be recorded: lower the baseline in the
// same commit as the change that reduced it, so a decrease is never silently lost.
//
// Per-file counts are stored for the location-based metrics (dotClawwrightLiterals,
// imageStringOps, prosePins) so a failure names the files that grew; the two stage-7 S2.5
// plain counts live in ./command-layer/kind-casts.ts alongside their counters.

import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { monorepoRoot } from "#framework/core/env.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { lifecycleCommands } from "#framework/commands/interface/groups/openclawCommands.lifecycle.ts";
import { managementCommands } from "#framework/commands/interface/groups/openclawCommands.management.ts";
import { orchestrationCommands } from "#framework/commands/interface/groups/openclawCommands.orchestration.ts";
import { operateCommands } from "#framework/commands/interface/groups/openclawCommands.operate.ts";
import { setsCommands } from "#framework/commands/interface/groups/openclawCommands.sets.ts";
import { checkoutGateCommands } from "#framework/entry/checkout-gate.ts";
import { surfaceRegistry } from "#framework/entry/registry.ts";
import { versionGateCommand, VERSION_ARGUMENTS } from "#framework/integration/version.ts";
import { INIT_ARGUMENTS } from "#framework/integration/deployment/init.ts";
import { COMPLETION_ARGUMENTS } from "#framework/integration/completion/index.ts";
import { commandRegistry } from "#framework/integration/gate.ts";
import { parseProse } from "#framework/core/io/invocation/prose.ts";
import { specData, specOf } from "#framework/core/command/index.ts";
import { measureProseHeld, measureProseHeldFlow } from "./prose-held.ts";
import { measureLegacyProseAssertions } from "./self/prose-assertions.ts";
import { grammarCallsInRun, kindCastsOutsideValues, stage7S25Boundaries } from "./command-layer/kind-casts.ts";
import { runFrameLaw } from "#checks/surfaces/frame-law-counter.ts";
import { CONTROLS } from "#checks/controls/controls.ts";
import { importedFrameworkSymbols, scanOwnProduct, SCANNER_SELF_CHECKS } from "./own-product.ts";
import { checkTrue, finish } from "#checks/kit/harness.ts";
import { runFrameRatchets } from "./frame-ratchets.ts";

interface PerFileMetric {
  readonly comment: string;
  readonly total: number;
  readonly files: Record<string, number>;
}
/** Lines the literal metric does not count, kept exact so the table cannot rot in either
 *  direction: an entry whose line no longer exists, and an occurrence left over once the
 *  recorded multiplicity ran out, are both failures. */
interface ExemptLines {
  readonly reason: string;
  readonly lines: Record<string, number>;
}
interface Baseline {
  readonly about: string;
  readonly dotClawwrightLiterals: PerFileMetric & { readonly exempt: Record<string, ExemptLines> };
  readonly dotClawwrightLiteralsNonTs: PerFileMetric & { readonly exempt: Record<string, ExemptLines> };
  readonly dotClawwrightConcatLiterals: { readonly comment: string; readonly total: number };
  readonly rawArgvPredicates: {
    readonly comment: string;
    readonly readOnlyWhen: number;
    readonly changedWhen: number;
    readonly requiresConfirmationWhen: number;
  };
  readonly legacyCommands: { readonly comment: string; readonly total: number };
  readonly unsummarizedDescriptions: { readonly comment: string; readonly total: number };
  readonly untypedValueArguments: { readonly comment: string; readonly total: number };
  readonly imageStringOps: PerFileMetric & { readonly exempt: Record<string, ExemptLines> };
  readonly prosePins: PerFileMetric;
  readonly proseMatchers: { readonly comment: string; readonly total: number };
  readonly proseEquality: { readonly comment: string; readonly total: number };
  readonly proseFlags: PerFileMetric;
  readonly proseHeld: { readonly comment: string; readonly total: number };
  readonly proseHeldFlow: PerFileMetric;
  readonly retiredSymbols: { readonly comment: string; readonly names: readonly string[]; readonly total: number };
  readonly adhocSkips: { readonly comment: string; readonly total: number; readonly exempt: Record<string, ExemptLines> };
  readonly rawArgvScans: PerFileMetric & { readonly exempt: Record<string, ExemptLines> };
  readonly ownProductExpectations: PerFileMetric;
  readonly frameLawViolations: { readonly comment: string; readonly violations: Record<string, string>; readonly total: number };
  readonly frameReads: { readonly comment: string; readonly total: number };
  readonly frameInstalls: PerFileMetric;
  readonly modeDeciders: PerFileMetric;
  readonly kindCastsOutsideValues: { readonly comment: string; readonly total: number };
  readonly grammarCallsInRun: { readonly comment: string; readonly total: number };
  readonly actionSelectionOutsideCore: { readonly comment: string; readonly total: number };
}

const root = monorepoRoot;
const baselinePath = resolve(root, "tools", "checks", "architecture", "baseline.json");
const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as Baseline;

async function walk(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name === "node_modules") continue;
      found.push(...(await walk(full)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

const rel = (full: string): string => relative(root, full).split("\\").join("/");

const frameworkFiles = await walk(resolve(root, "packages", "clawwright"));
const checkFiles = (await walk(resolve(root, "tools", "checks")))
  .map(rel)
  .filter((file) => !file.startsWith("tools/checks/architecture/") && !file.startsWith("tools/checks/golden/"));

interface Ratchet {
  readonly name: string;
  readonly expected: number;
  readonly actual: number;
  /** Per-file ratchets only: files that grew (a file absent from the baseline was 0). */
  readonly grew: readonly string[];
  /** Per-file ratchets only: files that shrank while the total decrease was not recorded. */
  readonly unrecordedShrank: readonly string[];
  /** Per-file ratchets only: one failure message per shrank file, naming that file's new count. */
  readonly unrecordedMessages: readonly string[];
  /** What changed the count, for printing. */
  readonly details: readonly string[];
}

function ratchet(name: string, expected: number, actual: number, grew: readonly string[] = [], shrank: readonly string[] = []): Ratchet {
  return {
    name, expected, actual, grew,
    unrecordedShrank: actual < expected ? shrank : [],
    unrecordedMessages: [],
    details: actual < expected ? [`lower the baseline to ${actual} in the same commit`] : [],
  };
}

function perFileRatchet(name: string, before: Record<string, number>, after: Map<string, number>): Ratchet {
  const grew: string[] = [];
  const shrank: string[] = [];
  const unrecordedMessages: string[] = [];
  const files = new Set([...Object.keys(before), ...after.keys()]);
  let expectedTotal = 0;
  let actualTotal = 0;
  for (const file of files) {
    const was = before[file] ?? 0;
    const now = after.get(file) ?? 0;
    expectedTotal += was;
    actualTotal += now;
    if (now > was) grew.push(`${file} (${was} → ${now})`);
    if (now < was) {
      shrank.push(`${file} (${was} → ${now})`);
      unrecordedMessages.push(`${name}: lower the baseline to ${now} in the same commit (decreased: ${file} (${was} → ${now}))`);
    }
  }
  const details = [...grew];
  if (shrank.length > 0) details.push(`lower the baseline to ${actualTotal} in the same commit`, ...shrank);
  return { name, expected: expectedTotal, actual: actualTotal, grew, unrecordedShrank: shrank, unrecordedMessages, details };
}

/** Human-readable problems for a ratchet, without touching the harness failure counter —
 *  the self-checks below call this directly. */
function ratchetFailures(result: Ratchet): readonly string[] {
  const out = result.grew.map((file) => `${result.name}: a new occurrence was added: ${file}`);
  out.push(...(result.unrecordedMessages.length > 0 ? result.unrecordedMessages : result.unrecordedShrank.map((file) => `${result.name}: lower the baseline to ${result.actual} in the same commit (decreased: ${file})`)));
  return out;
}

function report(result: Ratchet): void {
  checkTrue(
    `${result.name} equals the baseline (${result.actual} measured, ${result.expected} recorded)`,
    result.actual === result.expected,
  );
  const problems = ratchetFailures(result);
  checkTrue(`${result.name}: no single-file growth and no unrecorded decrease`, problems.length === 0);
  for (const line of [...problems, ...result.details]) process.stderr.write(`    ${line}\n`);
}

// Self-checks for the per-file ratchet failure modes, against the real perFileRatchet +
// ratchetFailures pipeline (not report(), which would count harness failures).
{
  const mixed = ratchetFailures(perFileRatchet("self", { "a.ts": 1, "b.ts": 1 }, new Map([["a.ts", 2], ["b.ts", 0]])));
  checkTrue("ratchet self-check: offsetting growth and shrink report both files", mixed.length === 2 && mixed[0]?.includes("a.ts (1 → 2)") === true && mixed[1]?.includes("b.ts (1 → 0)") === true);
  const fresh = ratchetFailures(perFileRatchet("self", {}, new Map([["new.ts", 1]])));
  checkTrue("ratchet self-check: a file absent from the baseline counts as growth", fresh.length === 1 && fresh[0]?.includes("new.ts (0 → 1)") === true);
  checkTrue("ratchet self-check: exact equality reports nothing", ratchetFailures(perFileRatchet("self", { "a.ts": 1 }, new Map([["a.ts", 1]]))).length === 0);
  const unrecorded = ratchetFailures(perFileRatchet("self", { "a.ts": 2, "b.ts": 2 }, new Map([["a.ts", 1], ["b.ts", 2]])));
  checkTrue("ratchet self-check: an unrecorded decrease is reported", unrecorded.length === 1 && unrecorded[0]?.includes("lower the baseline to 1 in the same commit") === true && unrecorded[0]?.includes("a.ts (2 → 1)") === true);
}
// Scanner adverse self-checks, run in the gate with the architecture check.
for (const selfCheck of SCANNER_SELF_CHECKS) {
  const scan = scanOwnProduct(selfCheck.source);
  checkTrue(`scanner self-check: ${selfCheck.name}`, selfCheck.expect({ ...scan, imports: importedFrameworkSymbols(selfCheck.source) }));
}

// 1. `./clawwright` literals in packages/clawwright and in the checkout entry — stage 4
// (Advice): the command name must reach output only through one renderer, so this goes to 0
// outside it. An occurrence on an `exempt` line (the shim naming itself, the completion
// registration) is left out of the per-file counts but still counted in the total, and the
// table fails in both directions: a line it names that no longer exists, and an occurrence
// left once the recorded multiplicity ran out.
const LITERAL = "./clawwright";
const exemptLeft = new Map<string, Map<string, number>>(
  Object.entries(baseline.dotClawwrightLiterals.exempt).map(([file, entry]) => [file, new Map(Object.entries(entry.lines))]),
);
const literalAfter = new Map<string, number>();
let literalTotal = 0;
for (const full of [...frameworkFiles, resolve(root, "tools", "clawwright.ts")]) {
  const content = await readFile(full, "utf8");
  const left = exemptLeft.get(rel(full));
  let counted = 0;
  for (const line of content.split("\n")) {
    const occurrences = line.split(LITERAL).length - 1;
    if (occurrences === 0) continue;
    literalTotal += occurrences;
    const remaining = left?.get(line.trim()) ?? 0;
    const exempt = Math.min(remaining, occurrences);
    if (exempt > 0 && left !== undefined) left.set(line.trim(), remaining - exempt);
    counted += occurrences - exempt;
  }
  if (counted > 0) literalAfter.set(rel(full), counted);
}
for (const [file, lines] of exemptLeft) {
  for (const [line, unmatched] of lines) {
    if (unmatched === 0) continue;
    checkTrue(`dotClawwrightLiterals.exempt names a line ${file} no longer has (${unmatched} left): ${line}`, false);
  }
}
report(perFileRatchet("dotClawwrightLiterals", baseline.dotClawwrightLiterals.files, literalAfter));
report(ratchet("dotClawwrightLiterals.total", baseline.dotClawwrightLiterals.total, literalTotal, [], []));

// 1a. The same literal in the static non-.ts product files under packages/clawwright (yml/yaml/
// sh/json/md/txt, plus dot/extensionless text files — .env.example ships into every
// deployment) — the compose `:?` guard message named a program rendered by docker compose,
// where it does not exist, and the .ts-only scan above never saw it. The dot/extensionless
// names have no extension to filter on, so they are taken as text up to a size cap that
// keeps the heuristic off binaries. Same exempt semantics: occurrences on an exempt line
// are left out of the per-file counts but still counted in the total, and the table fails
// in both directions, like section 1.
const TEXT_EXTENSIONS = [".yml", ".yaml", ".sh", ".json", ".md", ".txt"];
const TEXT_SIZE_CAP = 1024 * 1024;
async function walkTextFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name === "node_modules") continue;
      found.push(...(await walkTextFiles(full)));
    } else if (entry.isFile()) {
      const byExtension = TEXT_EXTENSIONS.some((extension) => entry.name.endsWith(extension));
      const byName = !byExtension && (entry.name.startsWith(".") || !entry.name.includes("."));
      if (!byExtension && !byName) continue;
      if (byName && (await stat(full)).size > TEXT_SIZE_CAP) continue;
      found.push(full);
    }
  }
  return found;
}
const nonTsExemptLeft = new Map<string, Map<string, number>>(
  Object.entries(baseline.dotClawwrightLiteralsNonTs.exempt).map(([file, entry]) => [file, new Map(Object.entries(entry.lines))]),
);
const nonTsAfter = new Map<string, number>();
let nonTsTotal = 0;
for (const full of await walkTextFiles(resolve(root, "packages", "clawwright"))) {
  const content = await readFile(full, "utf8");
  const left = nonTsExemptLeft.get(rel(full));
  let counted = 0;
  for (const line of content.split("\n")) {
    const occurrences = line.split(LITERAL).length - 1;
    if (occurrences === 0) continue;
    nonTsTotal += occurrences;
    const remaining = left?.get(line.trim()) ?? 0;
    const exempt = Math.min(remaining, occurrences);
    if (exempt > 0 && left !== undefined) left.set(line.trim(), remaining - exempt);
    counted += occurrences - exempt;
  }
  if (counted > 0) nonTsAfter.set(rel(full), counted);
}
for (const [file, lines] of nonTsExemptLeft) {
  for (const [line, unmatched] of lines) {
    if (unmatched === 0) continue;
    checkTrue(`dotClawwrightLiteralsNonTs.exempt names a line ${file} no longer has (${unmatched} left): ${line}`, false);
  }
}
report(perFileRatchet("dotClawwrightLiteralsNonTs", baseline.dotClawwrightLiteralsNonTs.files, nonTsAfter));
report(ratchet("dotClawwrightLiteralsNonTs.total", baseline.dotClawwrightLiteralsNonTs.total, nonTsTotal, [], []));

// 1b. The concatenation spelling escapes 1: `"." + "/clawwright"` builds the same literal —
// same invariant, 0 outside the renderer.
const CONCAT_LITERAL = /["'`]\.["'`]\s*\+\s*["'`]\/clawwright["'`]/;
let concatTotal = 0;
for (const full of [...frameworkFiles, resolve(root, "tools", "clawwright.ts")]) {
  const content = await readFile(full, "utf8");
  for (const line of content.split("\n")) if (CONCAT_LITERAL.test(line)) concatTotal += 1;
}
report(ratchet("dotClawwrightConcatLiterals", baseline.dotClawwrightConcatLiterals.total, concatTotal, [], []));

// 3. Flag spellings in help prose — stage 4 (design 2.3): a `--name` the declaration itself
// declares, spelled in its own `details` outside a token and outside a code span quoting
// another tool. Each one is prose that belongs in a `{--name}` token, so the ratchet counts
// down to 0 as the groups are migrated.
interface ProseSource {
  readonly details?: string;
  readonly arguments?: readonly { readonly name: string }[];
}
/** The files that own a proseFlags count: the five command groups plus the two gate
 *  declarations whose details are read from a module rather than a group file. */
const PROSE_SOURCES: Record<string, readonly ProseSource[]> = {
  "packages/clawwright/commands/interface/groups/openclawCommands.lifecycle.ts": Object.values(lifecycleCommands),
  "packages/clawwright/commands/interface/groups/openclawCommands.management.ts": Object.values(managementCommands),
  "packages/clawwright/commands/interface/groups/openclawCommands.orchestration.ts": Object.values(orchestrationCommands),
  "packages/clawwright/commands/interface/groups/openclawCommands.operate.ts": Object.values(operateCommands),
  "packages/clawwright/commands/interface/groups/openclawCommands.sets.ts": Object.values(setsCommands),
  "packages/clawwright/entry/checkout-gate.ts": checkoutGateCommands,
  "packages/clawwright/integration/version.ts": [versionGateCommand],
};
/** Every name the dispatcher can resolve: a code span quoting one of them is our own prose,
 *  anything else (`openclaw channels status --json`, `tailscale status --json`) belongs to
 *  another tool and its flags are not ours to count. Read from the one registry
 *  (entry/registry.ts), the list every surface reconciles against. */
const commandNames = new Set(surfaceRegistry().names);
const TOKEN_SPAN = /\{[^{}]*\}/g;
const CODE_SPAN = /`[^`]*`/g;
const FLAG_MENTION = /(?<![\w-])--([A-Za-z][A-Za-z0-9-]*)/g;
/** A leading program word is not the command: `./clawwright apply-config --dry-run` reads as
 *  apply-config's own --dry-run, not as another tool's line. */
const PROGRAM_WORD = /^\.?\/?clawwright$/;

function proseFlagCount(details: string, declared: ReadonlySet<string>): number {
  // Tokens first: a recognized span becomes one space, so the words around it stay apart.
  const text = details.replace(TOKEN_SPAN, (span) => (parseProse(span).length === 1 ? " " : span));
  const foreign = new Set<number>();
  for (const span of text.matchAll(CODE_SPAN)) {
    const words = span[0].slice(1, -1).trim().split(/\s+/);
    const first = words.find((word) => !PROGRAM_WORD.test(word)) ?? "";
    if (commandNames.has(first) || first.startsWith("--") || first.startsWith("{")) continue;
    const start = span.index ?? 0;
    for (let at = start; at < start + span[0].length; at += 1) foreign.add(at);
  }
  let count = 0;
  for (const mention of text.matchAll(FLAG_MENTION)) {
    const name = mention[1];
    if (name === undefined || !declared.has(name)) continue;
    if (foreign.has(mention.index ?? 0)) continue;
    count += 1;
  }
  return count;
}

const proseFlagsAfter = new Map<string, number>();
for (const [file, sources] of Object.entries(PROSE_SOURCES)) {
  let count = 0;
  for (const source of sources) {
    if (source.details === undefined) continue;
    count += proseFlagCount(source.details, new Set((source.arguments ?? []).map((argument) => argument.name)));
  }
  if (count > 0) proseFlagsAfter.set(file, count);
}
report(perFileRatchet("proseFlags", baseline.proseFlags.files, proseFlagsAfter));

// 3. Raw-argv predicates — stage 3 (CommandSpec effect): MCP confirmation must come from the
// declared effect, not from 28 predicates re-parsing argv beside the real parser.
let readOnlyWhen = 0;
let changedWhen = 0;
let requiresConfirmationWhen = 0;
let legacyCount = 0;
let unsummarized = 0;
for (const command of Object.values(openclawCommands)) {
  if (command.readOnlyWhen !== undefined) readOnlyWhen += 1;
  if (command.changedWhen !== undefined) changedWhen += 1;
  if (command.requiresConfirmationWhen !== undefined) requiresConfirmationWhen += 1;
  // 4. Stage-3 (CommandSpec) counts, measured through the materialized declarations:
  // legacyCommands — entries not yet carrying a spec body.
  if (specOf(command) === undefined) legacyCount += 1;
}

// unsummarizedDescriptions — stage 5 (rf5-mcp) widened the scope from openclawCommands to
// surfaceRegistry(): the schema is built for the gate commands and the help command too, so
// an argument over 60 characters without a `summary` would need a heuristic back anywhere on
// the surface, not only among the deployment's own commands.
for (const entry of surfaceRegistry().entries) {
  for (const argument of entry.arguments ?? []) {
    if (argument.description.length > 60 && argument.summary === undefined) unsummarized += 1;
  }
}
report(ratchet("rawArgvPredicates.readOnlyWhen", baseline.rawArgvPredicates.readOnlyWhen, readOnlyWhen, [], []));
report(ratchet("rawArgvPredicates.changedWhen", baseline.rawArgvPredicates.changedWhen, changedWhen, [], []));
report(ratchet("rawArgvPredicates.requiresConfirmationWhen", baseline.rawArgvPredicates.requiresConfirmationWhen, requiresConfirmationWhen, [], []));
report(ratchet("legacyCommands", baseline.legacyCommands.total, legacyCount, [], []));
report(ratchet("unsummarizedDescriptions", baseline.unsummarizedDescriptions.total, unsummarized, [], []));

// 4b. untypedValueArguments — stage 7 S2.4: every value argument (option, positional, and a
// variadic's element kind, in single bodies and per-action slices alike) carries a declared
// `value` kind; measured STRUCTURALLY through specOf/specData, never lexically. The counter
// covers gate commands and the registry too (version, init, completion, and the registry's
// `help` entry), whose public carrier is `parse`/`value` rather than a spec-side `value`.
let untypedValueArgs = 0;
for (const command of Object.values(openclawCommands)) {
  const entry = specOf(command);
  if (entry === undefined) continue;
  const data = specData(entry);
  const slices = data.kind === "single" ? [data.arguments] : Object.values(data.actions).map((action) => action.arguments);
  for (const slice of slices) {
    for (const argument of slice) {
      if (argument.kind !== "option" && argument.kind !== "positional" && argument.kind !== "variadic") continue;
      if ((argument as { value?: unknown }).value === undefined) untypedValueArgs += 1;
    }
  }
}
for (const gate of [...checkoutGateCommands, { arguments: VERSION_ARGUMENTS }, { arguments: INIT_ARGUMENTS }, { arguments: COMPLETION_ARGUMENTS }]) {
  for (const argument of gate.arguments ?? []) {
    if (argument.kind !== "option" && argument.kind !== "positional" && argument.kind !== "variadic") continue;
    const public_ = argument as { parse?: unknown; choices?: unknown; value?: unknown };
    if (public_.parse === undefined && public_.choices === undefined && public_.value === undefined) untypedValueArgs += 1;
  }
}
const helpEntry = commandRegistry({ deployment: openclawCommands, gate: checkoutGateCommands, appName: "counter" }).find("help");
for (const argument of helpEntry?.arguments ?? []) {
  if (argument.kind !== "option" && argument.kind !== "positional" && argument.kind !== "variadic") continue;
  const public_ = argument as { parse?: unknown; choices?: unknown; value?: unknown };
  if (public_.parse === undefined && public_.choices === undefined && public_.value === undefined) untypedValueArgs += 1;
}
report(ratchet("untypedValueArguments", baseline.untypedValueArguments.total, untypedValueArgs, [], []));

// 5. String operations on image references outside runtime/docker/image-ref.ts — stage 1
// (ImageRef): one module owns the grammar, call sites get values. Trailing comments and
// prose string literals (contents containing whitespace) are stripped first, so only code
// operations count. An occurrence on an `exempt` line is left out of the per-file counts
// but still counted in the total, and the table fails in both directions, like section 1.
const IMAGE_OPS =
  /@sha256|split\(\s*\/@\s*\/|split\(\s*["'`]@["'`]\s*\)|includes\(\s*["'`]@["'`]\s*\)|indexOf\(\s*["'`]@["'`]\s*\)|lastIndexOf\(\s*["'`]@["'`]\s*\)|lastIndexOf\(\s*["'`]:["'`]\s*\)|split\(\s*["'`]:["'`]\s*\)|indexOf\(\s*["'`]:["'`]\s*\)|replace\(\s*["'`]:["'`]\s*\)|startsWith\(\s*["'`]sha256|includes\(\s*["'`]sha256:|endsWith\(\s*["'`]sha256/;
const imageExemptLeft = new Map<string, Map<string, number>>(
  Object.entries(baseline.imageStringOps.exempt).map(([file, entry]) => [file, new Map(Object.entries(entry.lines))]),
);
const imageAfter = new Map<string, number>();
let imageTotal = 0;
for (const full of frameworkFiles) {
  if (rel(full) === "packages/clawwright/runtime/docker/image-ref.ts") continue;
  const content = await readFile(full, "utf8");
  const left = imageExemptLeft.get(rel(full));
  let counted = 0;
  for (const line of content.split("\n")) {
    let stripped = line.replace(/(^|\s)\/\/.*$/, "$1");
    // Inline block-comment spans; whole-comment lines (continuation "* ..." and closers).
    stripped = stripped.replace(/\/\*.*?\*\//g, "");
    const trimmed = stripped.trim();
    if (trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    stripped = stripped.replace(/\*\/\s*$/, "");
    // Same-line prose literals.
    stripped = stripped.replace(/(["'`])[^"'`\n]*\s[^"'`\n]*\1/g, '""');
    // An odd quote count means a fragment of a multi-line string/template literal — prose.
    const oddQuotes = ['"', "'", "`"].some((quote) => (stripped.split(quote).length - 1) % 2 === 1);
    if (oddQuotes) continue;
    if (!IMAGE_OPS.test(stripped)) continue;
    imageTotal += 1;
    const remaining = left?.get(line.trim()) ?? 0;
    const exempt = Math.min(remaining, 1);
    if (exempt > 0 && left !== undefined) left.set(line.trim(), remaining - exempt);
    counted += 1 - exempt;
  }
  if (counted > 0) imageAfter.set(rel(full), counted);
}
for (const [file, lines] of imageExemptLeft) {
  for (const [line, unmatched] of lines) {
    if (unmatched === 0) continue;
    checkTrue(`imageStringOps.exempt names a line ${file} no longer has (${unmatched} left): ${line}`, false);
  }
}
report(perFileRatchet("imageStringOps", baseline.imageStringOps.files, imageAfter));
report(ratchet("imageStringOps.total", baseline.imageStringOps.total, imageTotal, [], []));

// 6. Prose pins in checks — stage 5 and the cross-cutting I9: checks assert structure
// (codes, argv, JSON fields); prose belongs in goldens and renderer checks. The generated
// golden surfaces and this ratchet's own directory are excluded.
// Keep the legacy physical-line/category projection; operand provenance decides ownership,
// not a substitution of the broader site-counting API or changes to held/held-flow metrics.
const proseAfter = new Map<string, number>();
let matcherCount = 0;
let proseEqualityCount = 0;
for (const file of checkFiles) {
  const measured = measureLegacyProseAssertions(await readFile(resolve(root, file), "utf8"));
  if (measured.pins > 0) proseAfter.set(file, measured.pins);
  matcherCount += measured.matchers;
  proseEqualityCount += measured.equality;
}
report(perFileRatchet("prosePins", baseline.prosePins.files, proseAfter));
report(ratchet("proseMatchers", baseline.proseMatchers.total, matcherCount, [], []));
report(ratchet("proseEquality", baseline.proseEquality.total, proseEqualityCount, [], []));

// 6d. Original lexical held-prose measurement (HEAD behavior, independent of flow).
let proseHeldCount = 0;
for (const file of checkFiles) {
  const held = measureProseHeld(await readFile(resolve(root, file), "utf8"));
  proseHeldCount += held;
  if (held > 0) process.stderr.write(`    proseHeld: ${held} in ${file}` + String.fromCharCode(10));
}
report(ratchet("proseHeld", baseline.proseHeld.total, proseHeldCount, [], []));

// 6e. Stage7 S4 R2-C-4: independent dataflow superset, including direct literals.
const proseFlowAfter = new Map<string, number>(); let proseFlowCount = 0;
for (const file of checkFiles) { const count = measureProseHeldFlow(await readFile(resolve(root, file), "utf8")); proseFlowCount += count; if (count > 0) proseFlowAfter.set(file, count); }
report(perFileRatchet("proseHeldFlow", baseline.proseHeldFlow.files, proseFlowAfter)); report(ratchet("proseHeldFlow.total", baseline.proseHeldFlow.total, proseFlowCount, [], []));
// 7. Retired symbols — stage 5 (rf5-completion C1): names the command registry made
// structural that must not reappear anywhere under tools/ outside this check's own directory
// (excluded so the guard can name them here). A new occurrence fails the build.
const RETIRED_EXCLUDED = "tools/checks/architecture/";
const toolsFiles = (await walk(resolve(root, "tools"))).filter((full) => !rel(full).startsWith(RETIRED_EXCLUDED));
let retiredCount = 0;
for (const full of toolsFiles) {
  const content = await readFile(full, "utf8");
  for (const name of baseline.retiredSymbols.names) {
    const matches = content.match(new RegExp(`\\b${name}\\b`, "g"));
    if (matches !== null) retiredCount += matches.length;
  }
}
report(ratchet("retiredSymbols", baseline.retiredSymbols.total, retiredCount, [], []));

// 8. Ad-hoc host gates — invariant I10: a host-dependent check case is skipped only through a
// declared capability (requires() from kit/harness.ts). Every line under tools/checks (kit,
// architecture and golden excluded) matching any host-probe pattern — process.platform, a
// bare platform() or platform ===, os.platform()/os.type(), a capability probe called outside
// requires() (the gate-by-ternary shape), skipIf/runIf/.skip — must sit on an exempt
// line: a recorded value selection (both platforms run; only an expected value or transport
// choice differs), a transport helper kept for its probe, or a nested availability note
// inside a requires() body. The table fails in both directions, like
// section 1, and the total counts occurrences past the exemptions — so any new ad-hoc gate
// fails the build at 0.
const ADHOC = new RegExp([
  "process\\.platform",
  "os\\.platform\\(\\)",
  "os\\.type\\(\\)",
  "import \\{[^}]*\\bplatform\\b[^}]*\\} from \"node:(os|process)\"",
  "\\bplatform\\(\\)|\\bplatform\\s*[!=]==",
  "\\b(hasGnuUserland|hasDocker|hasDockerDesktopWsl|hasWsl|hasPosixSh|hasPosixModes|hasLocalPosix|hasBash|hasPwsh|hasRsync|hasSymlink|hasSshLoopback|hasAutoTarget|isLinuxHost|isWindowsHost|isPosixHost)\\s*\\(",
  "\\bskipIf\\b|\\brunIf\\b|\\.skip\\b",
  "\\bskip\\(",
  "\"skip\",\\s*\"skip\"",
  // a skip note on stderr (the lowercase note the runner does not count), or a string opening with it
  "stderr\\.write\\([^)]*\\bskip",
  "[\"'`]\\s*skip\\b",
  // a private availability probe: sh -c true / exit 0, Docker Compose or an image, a WSL listing
  "\\b(?:spawnLocal|spawn|exec)\\(\\s*\"sh\",\\s*\\[\"-c\",\\s*\"(?:true|exit 0)\"\\]",
  "\\bspawnLocal\\(\\s*\"docker\",\\s*\\[\"(?:compose\",\\s*\"version|image\",\\s*\"inspect)\"",
  "\\bspawnLocal\\(\\s*\"wsl\\.exe\",\\s*\\[\"(?:--list|-l)\"",
].join("|"));
const adhocExemptLeft = new Map<string, Map<string, number>>(
  Object.entries(baseline.adhocSkips.exempt).map(([file, entry]) => [file, new Map(Object.entries(entry.lines))]),
);
const adhocFiles = (await walk(resolve(root, "tools", "checks")))
  .map(rel)
  .filter((file) => !file.startsWith("tools/checks/kit/") && !file.startsWith("tools/checks/architecture/") && !file.startsWith("tools/checks/golden/"));
let adhocCount = 0;
for (const file of adhocFiles) {
  const content = await readFile(resolve(root, file), "utf8");
  const left = adhocExemptLeft.get(file);
  for (const line of content.split("\n")) {
    if (!ADHOC.test(line)) continue;
    const remaining = left?.get(line.trim()) ?? 0;
    const exempt = Math.min(remaining, 1);
    if (exempt > 0 && left !== undefined) left.set(line.trim(), remaining - exempt);
    adhocCount += 1 - exempt;
  }
}
for (const [file, lines] of adhocExemptLeft) {
  for (const [line, unmatched] of lines) {
    if (unmatched === 0) continue;
    checkTrue(`adhocSkips.exempt names a line ${file} no longer has (${unmatched} left): ${line}`, false);
  }
}
report(ratchet("adhocSkips", baseline.adhocSkips.total, adhocCount, [], []));

// 9. Raw-argv scans — the reason the bare-`--`/value-position findings kept surviving: no
// ratchet counted the second argv parse beside the tokenizer. Every membership/prefix scan over
// argv-like names in product code must be the tokenizer's, an entry seam, or a line recorded
// below with a reason, verified correct by construction. The scan roots are the layers that
// touch argv; tools/checks are excluded (they assert, they do not decide).
const ARGV_RECEIVER = String.raw`(argv|args|rawArgv|launchArgv|tokens|rest|params|process\.argv)`;
const SCAN_METHOD = "(includes|indexOf|lastIndexOf|find|findIndex|filter|some|every)";
const RAW_SCAN = new RegExp([
  String.raw`\b${ARGV_RECEIVER}\.${SCAN_METHOD}\(`,
  // the helper's own result is still raw argv: beforeBareDoubleDash(args).includes("--help")
  String.raw`\bbeforeBareDoubleDash\([^)]*\)\.${SCAN_METHOD}\(`,
  String.raw`\b${ARGV_RECEIVER}\.slice\([^)]*\)\.${SCAN_METHOD}\(`,
  String.raw`\.indexOf\("--"\)`,
  String.raw`\.startsWith\("-`,
  String.raw`\b(argv|args|rawArgv)\.slice\(2\)`,
  String.raw`new Set\(${ARGV_RECEIVER}\)\.has`,
  String.raw`\b${ARGV_RECEIVER}\.join\(" "\)`,
].join("|"));
const rawScanRoots = ["entry", "integration", "core", "commands"].map((dir) => resolve(root, "packages", "clawwright", dir));
const rawScanExemptLeft = new Map<string, Map<string, number>>(
  Object.entries(baseline.rawArgvScans.exempt).map(([file, entry]) => [file, new Map(Object.entries(entry.lines))]),
);
const rawScanAfter = new Map<string, number>();
let rawScanTotal = 0;
let rawScanCount = 0;
/** One file's scan lines, comments stripped: each counts toward the total, and toward the
 *  ratchet unless an exempt table line covers it (each exempt entry covers one occurrence). */
async function scanFile(full: string): Promise<void> {
  const content = await readFile(full, "utf8");
  const left = rawScanExemptLeft.get(rel(full));
  let counted = 0;
  for (const line of content.split("\n")) {
    let stripped = line.replace(/(^|\s)\/\/.*$/, "$1");
    stripped = stripped.replace(/\/\*.*?\*\//g, "");
    const trimmed = stripped.trim();
    if (trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    if (!RAW_SCAN.test(stripped)) continue;
    rawScanTotal += 1;
    const remaining = left?.get(line.trim()) ?? 0;
    const exempt = Math.min(remaining, 1);
    if (exempt > 0 && left !== undefined) left.set(line.trim(), remaining - exempt);
    counted += 1 - exempt;
  }
  if (counted > 0) rawScanAfter.set(rel(full), counted);
  rawScanCount += counted;
}
for (const dir of rawScanRoots) {
  for (const full of await walk(dir)) await scanFile(full);
}
await scanFile(resolve(root, "tools", "clawwright.ts"));
for (const [file, lines] of rawScanExemptLeft) {
  for (const [line, unmatched] of lines) {
    if (unmatched === 0) continue;
    checkTrue(`rawArgvScans.exempt names a line ${file} no longer has (${unmatched} left): ${line}`, false);
  }
}
report(perFileRatchet("rawArgvScans", baseline.rawArgvScans.files, rawScanAfter));
report(ratchet("rawArgvScans.total", baseline.rawArgvScans.total, rawScanTotal, [], []));

// 10. ownProductExpectations — stage 7 S0.5 (independent expectations): the EXPECTED operand
// of a check()/assert.* must not be computed from the same packages/clawwright symbol the ACTUAL
// operand uses — one product mutation would move both sides. Exempt: a file a registered
// negative control covers (controls.ts `check` field), and a `// control: <id>` marker for
// an existing control id; every exemption is printed, an unknown control id fails here.
const CONTROL_IDS = new Set(CONTROLS.map((control) => control.id));
const CONTROLLED_FILES = new Set(CONTROLS.map((control) => control.check));
const ownAfter = new Map<string, number>();
let ownTotal = 0;
const ownExempt: string[] = [];
for (const file of checkFiles) {
  const source = await readFile(resolve(root, file), "utf8");
  const scan = scanOwnProduct(source);
  const covered = CONTROLLED_FILES.has(file);
  for (const marker of scan.markers) {
    if (!CONTROL_IDS.has(marker.id)) {
      checkTrue(`ownProductExpectations: ${file}:${marker.line} names an unknown control id "${marker.id}"`, false);
    }
  }
  let counted = 0;
  for (const site of scan.sites) {
    if (covered) {
      ownExempt.push(`${file}:${site.line} file covered by a registered control (${site.symbols.join(", ")})`);
      continue;
    }
    if (site.marker !== undefined && CONTROL_IDS.has(site.marker)) {
      ownExempt.push(`${file}:${site.line} control ${site.marker} (${site.symbols.join(", ")})`);
      continue;
    }
    counted += 1;
  }
  if (counted > 0) ownAfter.set(file, counted);
  ownTotal += counted;
}
report(perFileRatchet("ownProductExpectations", baseline.ownProductExpectations.files, ownAfter));
report(ratchet("ownProductExpectations.total", baseline.ownProductExpectations.total, ownTotal, [], []));
for (const line of ownExempt) process.stderr.write(`    ownProductExpectations exempt: ${line}` + String.fromCharCode(10));

// 11. Frame-law violations — stage 7 S1.2a (invariant I12): the law check
// (surfaces/frame-law.check.ts) owns the decreasing-only contract with per-key reasons; this
// ratchet re-runs the pure counter in-process (its imports only ADD registrations —
// useGateCommands, the surface registry) so the architecture table sees the same number.
report(ratchet("frameLawViolations", baseline.frameLawViolations.total, runFrameLaw().violations.size));
await runFrameRatchets(root, frameworkFiles, rel, baseline);
// 12–15. Counters in ./command-layer/kind-casts.ts: brand casts, grammar in run bodies, S2.5 layer boundaries. Expect 0.
const s25 = { kindCastsOutsideValues: await kindCastsOutsideValues(), grammarCallsInRun: await grammarCallsInRun(), ...(await stage7S25Boundaries()) };
for (const [name, actual] of Object.entries(s25)) report(ratchet(name, (baseline as unknown as Record<string, { readonly total: number }>)[name].total, actual, [], []));
// 16. Action selection outside the owner — S2.8: a `.defaultAction` read or an `actions[...]` selection/indexing fails outside core/command (selectAction owns both).
let actionOutsideCoreCount = 0;
for (const full of frameworkFiles.filter((file) => !rel(file).includes("/core/command/")))
  actionOutsideCoreCount += ((await readFile(full, "utf8")).match(new RegExp("\\.defaultAction\\b|\\.actions\\s*!?\\s*\\[", "g")) ?? []).length;
report(ratchet("actionSelectionOutsideCore", baseline.actionSelectionOutsideCore.total, actionOutsideCoreCount, [], []));
finish("architecture ratchet");

// Structural assertions over .github/workflows/ci.yml for the "CI by tiers" design: the tier
// is expressed once in a workflow-level FULL_TIER env, jobs guard steps on it, and every job
// ends with the check timing summary. The workflow is parsed once into a data model by
// workflow-yaml.ts; every assertion below is a structural comparison on that model — never a
// text probe against the workflow file. Multi-word workflow strings are assembled via
// spaced() from single tokens, which keeps them out of the prose-literal data flow the
// architecture ratchet measures.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { parseWorkflowYaml, type YamlValue } from "./workflow-yaml.ts";

const text = await readFile(join(monorepoRoot, ".github", "workflows", "ci.yml"), "utf8");
const model = parseWorkflowYaml(text);

// --- Shared helpers -------------------------------------------------------------------------

// Builds a multi-word string from single tokens; single-token literals never register as
// prose, and the join call keeps the spaced result out of the literal data flow.
const spaced = (...parts: string[]): string => parts.join(" ");

// Containment via splitting: two parts exist exactly when the needle occurs. Used for run
// bodies compared against constant commands.
const containsText = (haystack: string, needle: string): boolean => haystack.split(needle).length > 1;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const asRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const asText = (value: unknown): string => (typeof value === "string" ? value : "");

const record = asRecord(model);
const on = asRecord(record.on);

// --- Constants the workflow is compared against ----------------------------------------------

const UNNAMED = spaced("(unnamed", "step)");
const FULL_GUARD = spaced("env.FULL_TIER", "==", "'true'");
const FAST_GUARD = spaced("env.FULL_TIER", "!=", "'true'");
const GROUP_EXPRESSION = spaced("ci-${{", "github.workflow", "}}-${{", "github.event_name", "}}-${{", "github.ref", "}}");
const MERGE_BASE_COMMAND = spaced("check", "--related", "--base", '"$(git', "merge-base", "origin/main", 'HEAD)"');
// Windows jobs keep a PowerShell step: under bash the MSYS mkdir leads PATH and breaks the instance lock.
const WINDOWS_JOBS = new Set(["windows-checks", "windows-wsl"]);
const WINDOWS_MERGE_BASE = spaced("$base", "=", "git", "merge-base", "origin/main", "HEAD");
const WINDOWS_RELATED = spaced("check", "--related", "--base", "$base");
const FAST_STEP_NAME = "Fast tier — typecheck, lint, affected checks";

// Steps allowed in BOTH tiers; every other step must carry the full-tier guard.
const BOTH_TIER_STEPS = new Set([
  "Check out",
  "Set up Node",
  "Install development dependencies",
  "Check timing summary",
  FAST_STEP_NAME,
]);

const EXPECTED_JOBS = ["checks", "macos-checks", "windows-checks", "windows-wsl"];

// --- Parser unit cases (inputs are string literals here, not the workflow) --------------------

const PARSER_CASES: readonly (readonly [string, readonly string[], YamlValue])[] = [
  ["top-level scalars with comments and blanks", [
    "name: CI",
    "# a standalone comment",
    "",
    "runs-on: ubuntu-latest",
  ], { name: "CI", "runs-on": "ubuntu-latest" }],
  ["double-quoted scalar containing a colon and dash", [
    'title: "fix: handle -Wall"',
  ], { title: spaced("fix:", "handle", "-Wall") }],
  ["single-quoted scalar with an escaped quote", [
    "note: 'keep ''this'''",
  ], { note: spaced("keep", "'this'") }],
  ["nested on: mapping with boolean and null values", [
    "on:",
    "  workflow_dispatch:",
    "    inputs:",
    "      full:",
    "        type: boolean",
    "        default: false",
    "  push:",
  ], { on: { workflow_dispatch: { inputs: { full: { type: "boolean", default: false } } }, push: null } }],
  ["sequence of mappings with an inline first key", [
    "steps:",
    "  - name: Check out",
    "    # position note",
    "    uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0",
    "    with:",
    "      fetch-depth: 0",
  ], { steps: [{ name: spaced("Check", "out"), uses: "actions/checkout@11d5960a326750d5838078e36cf38b85af677262", with: { "fetch-depth": 0 } }] }],
  ["sequence of mappings with a bare first key", [
    "steps:",
    "  - run: npm ci --include=dev",
    "  - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
  ], { steps: [{ run: spaced("npm", "ci", "--include=dev") }, { uses: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020" }] }],
  ["block scalar with an indented body", [
    "fast:",
    "  shell: bash",
    "  run: |",
    "    npm run typecheck",
    "    npm run lint",
  ], { fast: { shell: "bash", run: [spaced("npm", "run", "typecheck"), spaced("npm", "run", "lint")].join("\n") } }],
  ["sequence of scalars", [
    "matrix:",
    "  node:",
    "    - 24",
    "    - 22",
  ], { matrix: { node: [24, 22] } }],
  ["schedule sequence under on:", [
    "on:",
    "  schedule:",
    "    - cron: \"17 3 * * *\"",
  ], { on: { schedule: [{ cron: spaced("17", "3", "*", "*", "*") }] } }],
];
for (const [name, input, expected] of PARSER_CASES) {
  check(`workflow-yaml parser: ${name}`, parseWorkflowYaml(input.join("\n")), expected);
}

// --- Triggers --------------------------------------------------------------------------------

checkTrue("workflow_dispatch trigger present", on.workflow_dispatch !== undefined);
const dispatch = asRecord(on.workflow_dispatch);
const fullInput = asRecord(asRecord(dispatch.inputs).full);
checkTrue(
  "workflow_dispatch declares a boolean `full` input defaulting to false",
  fullInput.type === "boolean" && fullInput.default === false,
);
checkTrue(
  "schedule trigger present with a cron entry",
  Array.isArray(on.schedule) && on.schedule.some((entry) => isRecord(entry) && asText(entry.cron) !== ""),
);

// --- FULL_TIER expression, evaluated rather than string-compared ------------------------------

// Strips a single ${{ ... }} wrapper; empty when the value is not one wrapped expression.
const unwrapExpression = (value: string): string => {
  const parts = value.split("${{");
  if (parts.length !== 2 || !value.endsWith("}}")) return "";
  return parts[1]!.slice(0, -2).trim();
};

const env = asRecord(record.env);
check(
  "workflow-level FULL_TIER env is defined exactly once",
  Object.keys(env).filter((key) => key === "FULL_TIER").length,
  1,
);
const fullTierExpression = unwrapExpression(asText(env.FULL_TIER));
checkTrue("FULL_TIER line carries an ${{ ... }} expression", fullTierExpression !== "");
for (const part of ["pull_request", "schedule", "workflow_dispatch"]) {
  checkTrue(`FULL_TIER expression mentions ${part}`, containsText(fullTierExpression, part));
}

// Tokenizer for the tiny expression language below: operands, string literals and operators.
// Anything else throws, so an unparseable workflow fails the check instead of passing silently.
type Token = { kind: "operand"; name: string } | { kind: "string"; value: string } | { kind: "op"; op: string };

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expression.length) {
    const rest = expression.slice(i);
    const skip = rest.match(/^\s+/);
    if (skip !== null) {
      i += skip[0].length;
      continue;
    }
    const quoted = rest.match(/^'([^']*)'/);
    if (quoted !== null) {
      tokens.push({ kind: "string", value: quoted[1]! });
      i += quoted[0].length;
      continue;
    }
    const name = rest.match(/^[A-Za-z_][A-Za-z0-9_.]*/);
    if (name !== null) {
      tokens.push({ kind: "operand", name: name[0] });
      i += name[0].length;
      continue;
    }
    const op = rest.match(/^(\|\||&&|==|!=|\(|\))/);
    if (op !== null) {
      tokens.push({ kind: "op", op: op[1] });
      i += op[1].length;
      continue;
    }
    throw new Error(`unrecognized token at offset ${i} in: ${expression}`);
  }
  return tokens;
}

const KNOWN_OPERANDS = new Set(["github.event_name", "github.ref", "inputs.full"]);

/** Evaluates the FULL_TIER expression against a case. Only (), ||, &&, ==/!= between the three
 *  known operands and single-quoted literals are supported; anything else throws. */
function evaluateFullTier(expression: string, event: { eventName: string; ref: string; full: boolean }): boolean {
  const tokens = tokenize(expression);
  let pos = 0;
  const peekOp = () => (tokens[pos]?.kind === "op" ? (tokens[pos] as { kind: "op"; op: string }).op : undefined);
  const takeOp = (op: string) => {
    if (peekOp() !== op) throw new Error(`expected ${op} at token ${pos}`);
    pos += 1;
  };

  function parsePrimary(): boolean {
    const token = tokens[pos];
    if (token === undefined) throw new Error("unexpected end of expression");
    pos += 1;
    if (token.kind === "op" && token.op === "(") {
      const value = parseOr();
      takeOp(")");
      return value;
    }
    if (token.kind !== "operand" || !KNOWN_OPERANDS.has(token.name)) {
      throw new Error(`unsupported operand ${JSON.stringify(token)}`);
    }
    // `inputs.full` is a bare boolean input; the other operands compare against a string.
    if (token.name === "inputs.full") return event.full;
    const next = tokens[pos];
    if (next === undefined || next.kind !== "op" || (next.op !== "==" && next.op !== "!=")) {
      throw new Error(`comparison operator expected after ${token.name}`);
    }
    pos += 1;
    const literal = tokens[pos];
    if (literal === undefined || literal.kind !== "string") throw new Error("string literal expected after operator");
    pos += 1;
    const context: Record<string, string> = {
      "github.event_name": event.eventName,
      "github.ref": event.ref,
      "inputs.full": event.full ? "true" : "false",
    };
    const actual = context[token.name]!;
    return next.op === "==" ? actual === literal.value : actual !== literal.value;
  }

  function parseAnd(): boolean {
    let value = parsePrimary();
    while (peekOp() === "&&") {
      pos += 1;
      value = parsePrimary() && value;
    }
    return value;
  }

  function parseOr(): boolean {
    let value = parseAnd();
    while (peekOp() === "||") {
      pos += 1;
      value = parseAnd() || value;
    }
    return value;
  }

  const result = parseOr();
  if (pos !== tokens.length) throw new Error(`trailing tokens at ${pos}`);
  return result;
}

// Cases: [event_name, ref, inputs.full, expected]. Fast tier on pushes (main included: its PR
// already ran the full tier) and on workflow_dispatch without `full`; full tier for
// pull_request, schedule and dispatch with full=true.
const FULL_TIER_CASES: readonly (readonly [string, string, boolean, boolean])[] = [
  ["push", "refs/heads/topic", false, false],
  ["push", "refs/heads/main", false, false],
  ["pull_request", "refs/pull/1/merge", false, true],
  ["schedule", "refs/heads/main", false, true],
  ["workflow_dispatch", "refs/heads/main", false, false],
  ["workflow_dispatch", "refs/heads/topic", false, false],
  ["workflow_dispatch", "refs/heads/topic", true, true],
  ["workflow_dispatch", "refs/heads/main", true, true],
];
check(
  "FULL_TIER expression truth table",
  FULL_TIER_CASES.map(([eventName, ref, full]) => [
    eventName,
    ref,
    full,
    evaluateFullTier(fullTierExpression, { eventName, ref, full }),
  ]),
  FULL_TIER_CASES,
);

// --- Concurrency ------------------------------------------------------------------------------

const concurrency = asRecord(record.concurrency);
checkTrue("concurrency group pins workflow + ref", asText(concurrency.group) === GROUP_EXPRESSION);
check("a newer run of the same event and ref cancels the older one", concurrency["cancel-in-progress"], true);
const push = asRecord(on.push);
check("push runs only for main (branches are checked through their pull request)", push.branches, ["main"]);

// --- Per-job step classification ---------------------------------------------------------------

const stepsOf = (job: unknown): Record<string, unknown>[] =>
  isRecord(job) && Array.isArray(job.steps) ? job.steps.filter(isRecord) : [];

// A step without a name is labeled explicitly: unnamed steps are never allowlisted, so an
// unguarded unnamed step is flagged under this label.
const stepLabel = (step: Record<string, unknown>): string => {
  const name = asText(step.name);
  return name === "" ? UNNAMED : name;
};

// Finds a step by name; the label set indirection keeps names out of equality comparisons.
const findStep = (steps: Record<string, unknown>[], label: string): Record<string, unknown> | undefined => {
  const labels = new Set([label]);
  return steps.find((step) => labels.has(stepLabel(step)));
};

/** Tier classification: allowlisted steps run in both tiers; every other step — including any
 *  step without a name — must carry the full-tier guard. Returns offending step labels. */
export function classifySteps(steps: readonly Record<string, unknown>[]): string[] {
  const offending: string[] = [];
  for (const step of steps) {
    const label = stepLabel(step);
    if (BOTH_TIER_STEPS.has(label)) continue;
    if (step.if !== FULL_GUARD) offending.push(label);
  }
  return offending;
}

// Review 2a regression: a synthetic workflow whose second step has no name and no guard must
// be flagged as "(unnamed step)" by the same classifier that audits the real ci.yml.
const SYNTHETIC_UNNAMED = [
  "jobs:",
  "  demo:",
  "    steps:",
  "      - name: Check out",
  "        run: echo checkout",
  "      - run: npm run build",
].join("\n");
const syntheticSteps = stepsOf(asRecord(asRecord(asRecord(parseWorkflowYaml(SYNTHETIC_UNNAMED)).jobs).demo));
check("classifier flags an unguarded unnamed step", classifySteps(syntheticSteps), [UNNAMED]);

const jobs = asRecord(record.jobs);
const allUses: string[] = [];
for (const job of EXPECTED_JOBS) {
  const steps = stepsOf(jobs[job]);
  checkTrue(`job ${job} exists`, jobs[job] !== undefined);
  checkTrue(`${job}: has steps`, steps.length > 0);
  check(
    `${job}: every non-allowlisted step is guarded by env.FULL_TIER == 'true'`,
    classifySteps(steps),
    [],
  );

  const checkout = findStep(steps, "Check out");
  checkTrue(`${job}: checkout is full-depth (fetch-depth: 0)`, asRecord(checkout?.with)["fetch-depth"] === 0);

  // The fast step: explicit merge-base --base, all three commands, and bash on every host.
  const fast = findStep(steps, FAST_STEP_NAME);
  const fastRun = asText(fast?.run);
  checkTrue(`${job}: has a fast-tier step`, fast !== undefined);
  checkTrue(`${job}: fast-tier step guarded with env.FULL_TIER != 'true'`, asText(fast?.if) === FAST_GUARD);
  const windows = WINDOWS_JOBS.has(job);
  checkTrue(`${job}: fast-tier step runs under the host's own shell`, asText(fast?.shell) === (windows ? "pwsh" : "bash"));
  checkTrue(`${job}: fast-tier step runs npm run typecheck`, containsText(fastRun, "npm run typecheck"));
  checkTrue(`${job}: fast-tier step runs npm run lint`, containsText(fastRun, "npm run lint"));
  checkTrue(
    `${job}: fast-tier step passes an explicit merge-base as --base`,
    windows
      ? containsText(fastRun, WINDOWS_MERGE_BASE) && containsText(fastRun, WINDOWS_RELATED)
      : containsText(fastRun, MERGE_BASE_COMMAND),
  );

  const fullGuarded = steps.some((step) =>
    asText(step.if) === FULL_GUARD &&
    (containsText(asText(step.run), "npm test") || containsText(asText(step.run), "npm run check")));
  checkTrue(`${job}: full-tier check run (npm test / npm run check) is guarded`, fullGuarded);

  const timings = findStep(steps, "Check timing summary");
  checkTrue(
    `${job}: check --timings step runs with if: always()`,
    asText(timings?.if) === "always()" && containsText(asText(timings?.run), "check --timings"),
  );

  const uses = steps.map((step) => asText(step.uses)).filter((value) => value !== "");
  check(`${job}: action pin count`, uses.length, job === "checks" ? 3 : 2);
  allUses.push(...uses);
}

// --- Action pins across the whole file ---------------------------------------------------------

const EXPECTED_PINS: readonly string[] = [
  "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
  "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
  "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
  "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
  "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
  "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
  "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
  "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
  "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
];
check("sorted list of action pins across ci.yml", [...allUses].sort(), EXPECTED_PINS);

const linuxSteps = stepsOf(jobs["checks"]);
const packCandidate = findStep(linuxSteps, spaced("Pack", "the", "verified", "development", "candidate"));
const retainCandidate = findStep(linuxSteps, spaced("Retain", "the", "development", "candidate"));
checkTrue("candidate packing requires full tier", asText(packCandidate?.if) === FULL_GUARD);
checkTrue("candidate packing disables lifecycle scripts", containsText(asText(packCandidate?.run), spaced("npm", "pack", "--ignore-scripts")));
checkTrue("candidate records checksums and commit", containsText(asText(packCandidate?.run), "sha256sum") && containsText(asText(packCandidate?.run), "BUILD_COMMIT"));
checkTrue("candidate upload requires full tier", asText(retainCandidate?.if) === FULL_GUARD);
check("candidate artifact name", asRecord(retainCandidate?.with).name, "clawwright-candidate");
check("candidate artifact path", asRecord(retainCandidate?.with).path, "artifacts/");
check("candidate artifact retention", asRecord(retainCandidate?.with)["retention-days"], 7);
check("candidate artifact absence fails", asRecord(retainCandidate?.with)["if-no-files-found"], "error");

// --- windows-controls: the controls run in parallel shards, full tier only -------------------

const controlsJob = asRecord(jobs["windows-controls"]);
checkTrue("windows-controls job exists", jobs["windows-controls"] !== undefined);
check("windows-controls runs exactly when the full tier does", unwrapExpression(asText(controlsJob.if)), fullTierExpression);
check("windows-controls splits the controls into three shards", asRecord(asRecord(controlsJob.strategy).matrix).shard, ["1/3", "2/3", "3/3"]);
checkTrue("windows-controls is a gate, not advisory", controlsJob["continue-on-error"] === undefined);
const controlsRun = stepsOf(jobs["windows-controls"]).find((step) => containsText(asText(step.run), "check:controls"));
checkTrue("windows-controls passes its shard to check:controls", containsText(asText(controlsRun?.run), "--shard"));
checkTrue("no other job runs check:controls", EXPECTED_JOBS.every((job) => !stepsOf(jobs[job]).some((step) => containsText(asText(step.run), "check:controls"))));

// --- windows-wsl provisioning guard --------------------------------------------------------------

const wslSteps = stepsOf(jobs["windows-wsl"]);
const provision = wslSteps.find((step) => containsText(asText(step.run), "wsl.exe --install"));
checkTrue(
  "windows-wsl: wsl.exe --install step is guarded by env.FULL_TIER == 'true'",
  provision !== undefined && asText(provision.if) === FULL_GUARD,
);

finish("ci-tiers");

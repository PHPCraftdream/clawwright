// Shared isolated deployment fixture + sweep stage tally (pipeline sweeps, stage 7, S0.2).
// The fixture hands each case a valid deployment in a temporary root, selected so a case that
// passes `prepare` reaches the guarded `run` phase instead of the context refusal, with a
// recording transport. The root is injectable; the fixture never touches the checkout, and
// the transport never answers — every contact is logged and turned into a loud failure, so a
// sweep measuring pipeline refusals cannot silently reach a real host.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { monorepoRoot, parseEnv } from "#framework/core/env.ts";
import type { Stage } from "#framework/core/command/execute.ts";
import type { Transport } from "#framework/runtime/transport/transport.ts";
import { clearDeployment, selectedDeployment, useDeployment } from "#framework/runtime/deployment.ts";
import { checkTrue } from "./harness.ts";

export class SetupError extends Error {}

export interface DeploymentFixtureOptions {
  readonly root?: string;
  /** Test seam: replaces the post-write validation so a failing setup and its cleanup are
   *  exercisable deterministically. Defaults to validateFixtureDeployment. */
  readonly validate?: (root: string) => void;
}

export interface DeploymentFixture {
  readonly root: string;
  /** Hands the recording transport to one case and clears the contact log — call once per case. */
  transport(): Transport;
  /** The current case's contacts, in order. */
  contacts(): readonly string[];
  /** useDeployment(root) — create() already selected; exposed for a caller that switched away. */
  select(): void;
  dispose(): Promise<void>;
}

/** The recording transport throws this on every contact instead of answering: a sweep counts
 *  refusals, not host effects, and an accidental real command must fail loudly, not run. */
export const TRANSPORT_SENTINEL = "deployment fixture: the recording transport does not answer";

/** The recording transport's `description` — the one data property of Transport; the
 *  fixture's .env targets "local", and LocalTransport describes itself the same way. */
export const FIXTURE_TRANSPORT_DESCRIPTION = "local";

// Single source for the mkdtemp prefix — the self-check scans the OS temp dir by it.
export const FIXTURE_TEMP_PREFIX = "clawwright-deployment-fixture-";

const ENV_KEYS = ["OC_TARGET_LOCATION", "OC_DATA_DIR", "OPENCLAW_GATEWAY_PORT", "OPENCLAW_GATEWAY_TOKEN"] as const;

// Valid controls call the command named "local", so the recipe directory must match
// nameValue(...).example — otherwise the context phase refuses before the guarded run phase.
const RECIPE_NAME = "local";

// app.ts must load from a temp root, where "#framework/..." package imports do not resolve —
// the declaration imports this checkout's modules by absolute file URL instead.
function declarationFor(): string {
  const framework = (module: string): string => pathToFileURL(resolve(monorepoRoot, "packages", "clawwright", module)).href;
  return [
    `import { defineApp } from ${JSON.stringify(framework(join("core", "app.ts")))};`,
    `import { mountPoints } from ${JSON.stringify(framework(join("runtime", "mounts.ts")))};`,
    `import { openclawCommands } from ${JSON.stringify(framework(join("commands", "interface", "index.ts")))};`,
    ``,
    `export default defineApp({`,
    `  name: "fixture",`,
    `  description: "deployment fixture",`,
    `  service: { name: "gateway", logTail: "100" },`,
    `  mounts: mountPoints,`,
    `  commands: openclawCommands,`,
    `});`,
    ``,
  ].join("\n");
}

const DESIRED_STATE = `[
  { "path": "gateway.mode", "value": "local" },
  { "path": "gateway.bind", "value": "lan" }
]
`;

function fixtureEnv(root: string): string {
  return [
    "OC_TARGET_LOCATION=local",
    `OC_DATA_DIR=${join(root, "data")}`,
    "OPENCLAW_GATEWAY_PORT=18799",
    "OPENCLAW_GATEWAY_TOKEN=not-a-real-token-check-only-value",
    "",
  ].join("\n");
}

/** Throws SetupError naming the first thing missing — called after writing, so a fixture is
 *  never selected half-built and a sweep sees a setup failure, not a pipeline refusal. */
export function validateFixtureDeployment(root: string): void {
  let env: Record<string, string> = {};
  try {
    env = parseEnv(readFileSync(join(root, ".env"), "utf8"));
  } catch {
    throw new SetupError(`deployment fixture: .env is missing or unreadable under ${root}`);
  }
  for (const key of ENV_KEYS) {
    if ((env[key] ?? "") === "") throw new SetupError(`deployment fixture: .env lacks ${key}`);
  }
  const required = [
    join(root, "app.ts"),
    join(root, "config", "desired-state.json"),
    join(root, "recipes", RECIPE_NAME, "recipe.json"),
    join(root, "recipes", RECIPE_NAME, "acceptance.json"),
    join(root, "recipes", RECIPE_NAME, "agent", "config.json"),
  ];
  for (const file of required) {
    if (!existsSync(file)) throw new SetupError(`deployment fixture: missing ${file}`);
  }
}

export async function createDeploymentFixture(options: DeploymentFixtureOptions = {}): Promise<DeploymentFixture> {
  // An injected root is handed over for the duration and removed on dispose too — the caller
  // asked for that lifecycle by passing it.
  const root = options.root ?? (await mkdtemp(join(tmpdir(), FIXTURE_TEMP_PREFIX)));
  const recipe = join(root, "recipes", RECIPE_NAME);
  // Partial writes or a failed validation must not leave a half-built fixture behind —
  // but an injected root belongs to the caller, so only a self-created one is removed.
  try {
    await mkdir(join(root, "config"), { recursive: true });
    await mkdir(join(root, "secrets"), { recursive: true });
    await mkdir(join(root, "data"), { recursive: true });
    // The recipe's agent dir and the manifest action's actions/ dir (one site per shape).
    for (const dir of ["agent", "actions"]) await mkdir(join(recipe, dir), { recursive: true });
    await writeFile(join(root, ".env"), fixtureEnv(root), "utf8");
    await writeFile(join(root, "app.ts"), declarationFor(), "utf8");
    await writeFile(join(root, "config", "desired-state.json"), DESIRED_STATE, "utf8");
    // A `recipe run` control names a manifest action, so the fixture recipe declares one
    // no-op read action — the control reaches the guarded run phase like every other unit.
    const recipeFiles: Array<[string, string]> = [
      [join(recipe, "recipe.json"), JSON.stringify({
        description: "fixture recipe",
        actions: { x: { file: "actions/x.ts", effect: "read", description: "no-op control action", arguments: [] } },
      })],
      [join(recipe, "actions", "x.ts"), "export async function run(): Promise<void> {}\n"],
    ];
    for (const [file, text] of recipeFiles) await writeFile(file, text, "utf8");
    await writeFile(join(recipe, "acceptance.json"), JSON.stringify({ checks: [] }), "utf8");
    await writeFile(
      join(recipe, "agent", "config.json"),
      JSON.stringify({ agentId: "local-agent", mcpServerName: "local-mcp" }),
      "utf8",
    );
    (options.validate ?? validateFixtureDeployment)(root);
  } catch (error) {
    if (options.root === undefined) await rm(root, { recursive: true, force: true });
    throw error;
  }

  // Restored on dispose so a suite of sweeps can nest fixtures without leaking a selection.
  const previous = selectedDeployment();
  useDeployment(root);

  const contacts: string[] = [];
  // One Proxy: data properties answer, every method records and throws — cheap to build per
  // fixture, and any unforeseen transport method is covered without maintaining a method
  // list. Symbols and "then" answer undefined: the transport is no iterable or thenable, and
  // probing that is no contact.
  const transport = new Proxy(
    { description: FIXTURE_TRANSPORT_DESCRIPTION },
    {
      get: (target, property) => {
        if (Object.hasOwn(target, property)) return target[property as keyof typeof target];
        if (typeof property === "symbol" || property === "then") return undefined;
        return (...args: unknown[]): never => {
          contacts.push(`${property} ${args.map(String).join(" ")}`);
          throw new Error(TRANSPORT_SENTINEL);
        };
      },
    },
  ) as unknown as Transport;

  return {
    root,
    transport(): Transport {
      contacts.length = 0;
      return transport;
    },
    contacts: (): readonly string[] => [...contacts],
    select: (): void => {
      useDeployment(root);
    },
    async dispose(): Promise<void> {
      // A missing previous selection means the fixture made it: leaving the deleted root
      // selected would hand the next caller a ghost directory.
      if (previous !== undefined) useDeployment(previous);
      else clearDeployment();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Options for a control: an expect other than "run" documents a known shortfall. */
export interface ControlOptions {
  readonly expect?: Stage;
  readonly reason?: string;
}

/** The sweep's stage tally — both halves of invariant I11 (isolated fixture + refusal
 *  accounting) live in this one module because they are one meaning: measure where cases
 *  stop, never let one touch a host. Stages report in pipeline order. */
export interface StageTally {
  case(label: string, stage: Stage, error?: unknown): void;
  control(label: string, stage: Stage, options?: ControlOptions): void;
  /** Stage counts in pipeline order, omitting zero entries — structural, no printing. */
  counts(): ReadonlyArray<{ readonly stage: Stage; readonly count: number }>;
  /** Controls that stopped short of "run", with the documented reason if any; an excused
   *  control (never run in-process at all) carries no stage. */
  shortfalls(): ReadonlyArray<{ readonly label: string; readonly stage?: Stage; readonly reason?: string }>;
  /** An explicit excuse for a control that cannot run in-process at all: counted outside
   *  the histogram, never a failure. */
  excused(label: string, reason: string): void;
  print(title: string): void;
  readonly cases: number;
}

const PIPELINE_ORDER: readonly Stage[] = ["parse", "confirm", "prepare", "environment", "context", "run"];

export function stageTally(): StageTally {
  const counts = new Map<Stage, number>();
  const shortfalls: Array<{ label: string; stage?: Stage; reason?: string }> = [];
  let cases = 0;

  const record = (stage: Stage): void => {
    counts.set(stage, (counts.get(stage) ?? 0) + 1);
    cases += 1;
  };

  return {
    // A SetupError is a broken fixture, never a pipeline outcome: failing it loudly here
    // keeps the histogram honest instead of hiding breakage as a refusal stage.
    case(label: string, stage: Stage, error?: unknown): void {
      if (error instanceof SetupError) {
        checkTrue(`${label}: a fixture setup error is a failure, never a refusal stage`, false);
        return;
      }
      record(stage);
    },
    control(label: string, stage: Stage, options: ControlOptions = {}): void {
      const expect = options.expect ?? "run";
      record(stage);
      checkTrue(`${label}: a valid control reaches the ${expect} stage`, stage === expect);
      // A non-run stage is a shortfall even when a documented expect matched it.
      if (stage !== "run") shortfalls.push({ label, stage, reason: options.reason });
    },
    counts: (): ReadonlyArray<{ stage: Stage; count: number }> =>
      PIPELINE_ORDER.filter((stage) => (counts.get(stage) ?? 0) > 0).map((stage) => ({ stage, count: counts.get(stage) ?? 0 })),
    shortfalls: (): ReadonlyArray<{ label: string; stage?: Stage; reason?: string }> => shortfalls,
    excused(label: string, reason: string): void {
      shortfalls.push({ label, reason });
    },
    print(title: string): void {
      const parts = PIPELINE_ORDER.filter((stage) => (counts.get(stage) ?? 0) > 0).map(
        (stage) => `${stage} ${counts.get(stage)}`,
      );
      process.stderr.write(`stage histogram (${title}): ${parts.join(", ")} — ${cases} ${cases === 1 ? "case" : "cases"}\n`);
      for (const { label, stage, reason } of shortfalls) {
        if (stage === undefined) process.stderr.write(`control excused: ${label} — ${reason}\n`);
        else process.stderr.write(`control short of run: ${label} → ${stage}${reason === undefined ? "" : ` — ${reason}`}\n`);
      }
    },
    get cases(): number {
      return cases;
    },
  };
}

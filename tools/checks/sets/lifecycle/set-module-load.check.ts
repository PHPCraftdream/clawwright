// Each module in a known import cycle loads on its own, whichever the entry: a cycle entered
// from the other side fails with a TDZ error only when that module is the first import
// (set.ts once read set-try.ts's argument tables through such a cycle). Two static runtime
// cycles exist today (verified over the import graph, type-only and lazy dynamic imports
// excluded): the lifecycle/restore state helpers and the artifact install → provision-agent
// → orchestration loop. The `set` actions cycle was broken in 6c43b01 and must not return.

import { tmpdir } from "node:os";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { monorepoRoot } from "#framework/core/env.ts";
import { check, finish, isolatedAppsRoot } from "#checks/kit/harness.ts";
import { runProcess } from "#checks/kit/spawn.ts";

const framework = (...parts: string[]) => resolve(monorepoRoot, "packages", "clawwright", ...parts);
const CYCLES: Record<string, string[]> = {
  // load.ts owns loading and integrity; install.ts imports it and must never be reached by
  // it — not even transitively (load.ts loads the acceptance grammar lazily for this reason).
  "set load ↔ artifact install": ["set/load.ts", "set/artifacts/install.ts"],
  "lifecycle state ↔ restore": ["commands/lifecycle/state.ts", "commands/management/configuration/secrets.ts", "commands/lifecycle/restore/index.ts"],
  "artifact install ↔ provision-agent ↔ orchestration": [
    "set/artifacts/install.ts",
    "commands/management/provision-agent/index.ts",
    "commands/management/provision-agent/reconcile.ts",
    "commands/orchestration/accept.ts",
    "commands/orchestration/inspect/gather.ts",
    "commands/orchestration/inspect/live.ts",
    "commands/orchestration/inspect/declared.ts",
  ],
};

const apps = await isolatedAppsRoot("set-module-load");
try {
for (const [cycle, modules] of Object.entries(CYCLES)) {
  for (const relative of modules) {
    const file = framework(relative);
    const script = `await import(${JSON.stringify(pathToFileURL(file).href)});`;
    const result = await runProcess(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", script],
      { cwd: tmpdir(), timeoutMs: 60_000 },
    );
    check(`${relative} loads as the first import (${cycle})`, result.code === 0, true);
    if (result.code !== 0) process.stderr.write(`    ${result.output.split("\n").filter((line) => /Error/.test(line)).slice(0, 2).join("\n    ")}\n`);
  }
}
} finally { await apps.dispose(); }

// A cycle that happens to load is still a cycle: load.ts must not statically reach install.ts.
// Type-only and dynamic imports are excluded, as in the cycle census above.
async function staticReach(from: string, target: string): Promise<string[] | undefined> {
  const queue: string[][] = [[from]];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const path = queue.shift() as string[];
    const file = path[path.length - 1] as string;
    if (file === target) return path;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = await readFile(file, "utf8").catch(() => "");
    for (const match of source.matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gmu)) {
      const spec = match[1] as string;
      const next = spec.startsWith("#src/") ? framework(spec.slice(5)) : spec.startsWith(".") ? resolve(dirname(file), spec) : undefined;
      if (next !== undefined) queue.push([...path, next]);
    }
  }
  return undefined;
}
const loadToInstall = await staticReach(framework("set/load.ts"), framework("set/artifacts/install.ts"));
check("set/load.ts never statically reaches set/artifacts/install.ts", loadToInstall === undefined, true);
if (loadToInstall !== undefined) process.stderr.write(`    ${loadToInstall.map((file) => file.replace(framework(), "")).join(" -> ")}\n`);

finish("cycle module load order");

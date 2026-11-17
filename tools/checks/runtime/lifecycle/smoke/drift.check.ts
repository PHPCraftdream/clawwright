// A failed drift cleanup must remain a failed verdict and name the repair.

import { checks, runChecks } from "#framework/commands/lifecycle/smoke/index.ts";
import type { Context } from "#framework/core/context.ts";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useDeployment, deploymentDir } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { asDirectTest } from "#checks/kit/deployment-fixture.ts";

// --- drift cleanup is a restore after the verdict --------------------------------------------

{
  const root = await mkdtemp(join(tmpdir(), "clawwright-smoke-drift-"));
  let previous: string | undefined;
  try { previous = deploymentDir(); } catch { /* no deployment selected in this check */ }
  try {
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config", "desired-state.json"), JSON.stringify([
      { path: "agents.defaults.model.primary", value: "fixture-model" },
    ]));
    useDeployment(root);

    // The first patch restores the declaration; the check then observes deliberate drift on
    // its second read, so the cleanup patch is real work and its injected failure is exercised.
    let liveReads = 0;
    let batchCalls = 0;
    let setCalls = 0;
    const files = new Map<string, string>();
    const dirs = new Set<string>();
    const dataDir = "/srv/clawwright";
    files.set(`${dataDir}/config/openclaw.json`, JSON.stringify({ agents: { defaults: { model: { primary: "fixture-model" } } } }));
    const ctx = {
      settings: { dataDir },
      transport: {
        async exec(rawCommand: string, rawArgs: string[]) {
          const { command, args } = asDirectTest(rawCommand, rawArgs);
          if (command === "mkdir") {
            const target = args[args.length - 1];
            if (dirs.has(target)) return { code: 1, stdout: "", stderr: "File exists" };
            dirs.add(target);
            return { code: 0, stdout: "", stderr: "" };
          }
          // Model the instance-lock marker moves so the restore can claim again.
          if (command === "mv") {
            const source = args[args.length - 2];
            const destination = args[args.length - 1];
            if (source !== undefined && destination !== undefined && files.has(source)) {
              if (files.has(destination)) return { code: 1, stdout: "", stderr: "File exists" };
              const content = files.get(source)!;
              files.delete(source);
              files.set(destination, content);
              return { code: 0, stdout: "", stderr: "" };
            }
            if (source === undefined || destination === undefined || !dirs.has(source)) {
              return { code: 1, stdout: "", stderr: "No such file or directory" };
            }
            dirs.delete(source);
            dirs.add(destination);
            return { code: 0, stdout: "", stderr: "" };
          }
          if (command === "ln") {
            const [source, destination] = args;
            if (source === undefined || destination === undefined || !files.has(source)) return { code: 1, stdout: "", stderr: "No such file or directory" };
            if (files.has(destination) || dirs.has(destination)) return { code: 1, stdout: "", stderr: "File exists" };
            files.set(destination, files.get(source)!);
            return { code: 0, stdout: "", stderr: "" };
          }
          if (command === "rmdir" || command === "rm") {
            const target = args[args.length - 1];
            for (const dir of dirs) {
              if (dir === target || dir.startsWith(`${target}/`)) dirs.delete(dir);
            }
            return { code: 0, stdout: "", stderr: "" };
          }
          if (command === "test" && args[0] === "-d") {
            return { code: dirs.has(args[1] ?? "") ? 0 : 1, stdout: "", stderr: "" };
          }
          if (command === "test") return { code: 1, stdout: "", stderr: "" };
          return { code: 0, stdout: "", stderr: "" };
        },
        async readFile(path: string): Promise<string> {
          const content = files.get(path);
          if (content === undefined) { const error = new Error(`no such file: ${path}`); (error as NodeJS.ErrnoException).code = "ENOENT"; throw error; }
          if (path === `${dataDir}/config/openclaw.json` && ++liveReads === 2) {
            const drifted = { agents: { defaults: { model: { primary: "manual-drift" } } } };
            files.set(path, JSON.stringify(drifted));
            return JSON.stringify(drifted);
          }
          return content;
        },
        async exists(path: string): Promise<boolean> { return files.has(path); },
        async writeFile(path: string, content: string): Promise<void> {
          files.set(path, content);
        },
        async remove(path: string): Promise<void> {
          files.delete(path);
          dirs.delete(path);
        },
        async listFiles(path: string): Promise<string[]> {
          const prefix = `${path}/`;
          return [...files.keys()].filter((entry) => entry.startsWith(prefix)).map((entry) => entry.slice(prefix.length));
        },
      },
      paths: { toContainer: (path: string) => path },
      runtime: {
        async isRunning() { return true; },
        async runOneOff(_service: string, args: string[]) {
          const patchAt = args.indexOf("config");
          if (patchAt >= 0 && args[patchAt + 1] === "set") {
            setCalls += 1;
            files.set(`${dataDir}/config/openclaw.json`, JSON.stringify({ agents: { defaults: { model: { primary: JSON.parse(args[patchAt + 3]!) } } } }));
          }
          if (patchAt >= 0 && args[patchAt + 1] === "patch" && args[patchAt + 2] === "--file") {
            batchCalls += 1;
            if (batchCalls === 1) {
              const stagedPath = args[patchAt + 3]!;
              const staged = files.get(stagedPath);
              if (staged === undefined) throw new Error(`missing staged patch: ${stagedPath}`);
              const patch = JSON.parse(staged) as { agents?: { defaults?: { model?: { primary?: unknown } } } };
              check("the first patch restores fixture-model", patch.agents?.defaults?.model?.primary, "fixture-model");
              files.set(`${dataDir}/config/openclaw.json`, JSON.stringify({ agents: { defaults: { model: { primary: "fixture-model" } } } }));
            } else if (batchCalls === 2) throw new Error("docker unreachable");
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    } as unknown as Context;

    const drift = checks.find((entry) => entry.name === "desired state overrides manual drift");
    if (drift === undefined) throw new Error("smoke.ts no longer has the drift check under its documented name");

    const summary = await withOutputSink(() => {}, () => runChecks(ctx, [drift], () => {}));
    check("apply sets the live primary once before patching", setCalls, 1);
    check("the setup drove both non-noop applyConfig calls — the verdict came from the first", batchCalls, 2);
    check("a restore that fails after the verdict stays a failed check", summary.results.map((result) => result.status), ["failed"]);
    check("saying the instance may still hold the drifted value", summary.results[0].detail?.includes("may still hold the drifted value"), true);
    check("naming the path it could not restore", summary.results[0].detail?.includes("agents.defaults.model.primary"), true);
    check("naming the repair", summary.results[0].detail?.includes("apply-config"), true);
  } finally {
    if (previous === undefined) useDeployment(root);
    else useDeployment(previous);
    await rm(root, { recursive: true, force: true });
  }
}

finish("smoke drift");

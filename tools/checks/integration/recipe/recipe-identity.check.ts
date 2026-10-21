// Ownership is a consumer safety boundary, including read-only and malformed-manifest probes.
import { createHash } from "node:crypto";
import { UserError } from "#framework/core/io/log.ts";
import type { Advice } from "#framework/core/io/invocation/advice.ts";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { buildStack } from "#framework/runtime/docker/side-stack/index.ts";
import { LocalPathBridge } from "#framework/core/paths.ts";
import { toSettings } from "#framework/core/env.ts";
import { useDeployment, useComposeProjectOverride, composeProjectOverride, selectedDeployment } from "#framework/runtime/deployment.ts";
import { recipeProjectName, recipeStack, clearRecipesDir, useRecipesDir } from "#framework/service/recipe.ts";
import { runningRecipeStacks } from "#framework/commands/management/recipe/index.ts";
import type { Context } from "#framework/core/context.ts";
import type { Transport } from "#framework/runtime/transport/transport.ts";
import { finish } from "#checks/kit/harness.ts";

const root = await mkdtemp(resolve(tmpdir(), "recipe-identity-check-"));
const previousRoot = selectedDeployment();
const previousOverride = composeProjectOverride();
const fileA = resolve(root, "a", "deployment", "recipes", "cache", "compose.yml");
const fileB = resolve(root, "b", "deployment", "recipes", "cache", "compose.yml");
// Local manifests remain Windows-readable; Docker labels use the real POSIX target seam.
const targetFile = (file: string) => `/tmp/recipe-identity/${file.slice(root.length).replaceAll("\\", "/").replace(/^\//, "")}`;
const records = new Map<string, { id: string; file: string; running: boolean }>();
const volumes = new Set<string>();
const targetFiles = new Map<string, string>();
const targetDirectories = new Set<string>();
const snapshot = (excludedProjects: readonly string[] = []) => structuredClone({
  records: [...records].filter(([project]) => !excludedProjects.includes(project)),
  volumes: [...volumes].filter((project) => !excludedProjects.includes(project)),
  targetFiles: [...targetFiles],
  targetDirectories: [...targetDirectories],
});
const unchanged = async <T>(operation: () => Promise<T>, excludedProjects: readonly string[] = []): Promise<T> => {
  const before = snapshot(excludedProjects);
  const result = await operation();
  assert.deepEqual(snapshot(excludedProjects), before, "operation preserves all unrelated fixture bytes and state");
  return result;
};
const containerId = (name: string) => createHash("sha256").update(name).digest("hex");
const ownershipRefusal = (error: unknown, named = true): boolean => {
  assert.ok(error instanceof UserError);
  assert.equal(error.cause, undefined, "ownership refusals do not retain raw daemon failures");
  if (named) {
    assert.deepEqual(error.advice, [
      { kind: "clawwright", argv: ["recipe", "inspect", "cache"] },
      { kind: "clawwright", argv: ["recipe", "migrate", "cache"] },
    ] satisfies Advice[]);
  } else {
    assert.equal(error.advice.length, 1);
    const advice: Advice | undefined = error.advice[0];
    assert.equal(advice?.kind, "manual");
    assert.ok(advice?.kind === "manual" && advice.text.trim().length > 0);
  }
  return true;
};
let wrappedQueries = 0;
let mutations = 0;
const transport: Transport = {
  description: "fixture:POSIX-Docker",
  async readFile(path) {
    const content = targetFiles.get(path);
    if (content === undefined) throw new Error(`missing target file ${path}`);
    return content;
  },
  async writeFile(path, content) { targetFiles.set(path, typeof content === "string" ? content : Buffer.from(content).toString("utf8")); },
  async exists(path) { return targetFiles.has(path) || targetDirectories.has(path); },
  async mkdirp(path) { targetDirectories.add(path); },
  async remove(path) {
    for (const name of targetFiles.keys()) if (name === path || name.startsWith(`${path}/`)) targetFiles.delete(name);
    for (const name of targetDirectories) if (name === path || name.startsWith(`${path}/`)) targetDirectories.delete(name);
  },
  async listFiles(directory) {
    return [...targetFiles.keys()].filter((name) => name.startsWith(`${directory}/`)).map((name) => name.slice(directory.length + 1));
  },
  clientInvocation(entryPath, args) { return { command: "node", args: [entryPath, ...args] }; },
  async exec(command: string, incoming: string[], options) {
    const wrapped = command === "sh";
    if (wrapped) {
      assert.equal(incoming[0], "-c");
      assert.equal(incoming[2], "recipe-docker");
      assert.ok(incoming[1]?.endsWith('docker "$@"'));
      assert.equal(options?.allowFailure, true);
      assert.equal(options?.stream, false);
      wrappedQueries++;
    } else assert.equal(command, "docker");
    const args = wrapped ? incoming.slice(3) : incoming;
    let stdout = "";
    if (args[0] === "ps") {
      const project = args.find((arg) => arg.startsWith("label="))?.split("=").at(-1) ?? "";
      const record = records.get(project);
      if (record && (args.includes("--all") || record.running)) stdout = record.id;
    } else if (args[0] === "inspect") {
      stdout = JSON.stringify([...records].filter(([, value]) => args.includes(value.id)).map(([project, value]) => ({
        Id: value.id,
        Image: `sha256:${containerId("image")}`,
        State: { Status: value.running ? "running" : "exited", ExitCode: 0, Error: "", OOMKilled: false, Paused: false, Restarting: false },
        Mounts: [],
        HostConfig: { RestartPolicy: { Name: "no" }, Privileged: false, Devices: [], VolumesFrom: [], Tmpfs: {} },
        Config: { Env: [], Labels: {
          "com.docker.compose.service": "cache",
          "com.docker.compose.project": project,
          "com.docker.compose.project.working_dir": value.file.slice(0, value.file.lastIndexOf("/")),
          "com.docker.compose.project.config_files": value.file,
        } },
      })));
    } else if (args[0] === "compose") {
      const project = args[args.indexOf("--project-name") + 1]!;
      if (args.includes("down")) {
        records.delete(project);
        if (args.includes("--volumes")) volumes.delete(project);
        mutations += 1;
      } else if (args.includes("logs")) stdout = records.get(project)?.id ?? "";
      else if (args.includes("up")) {
        records.set(project, { id: containerId(args[args.indexOf("--file") + 1]!), file: args[args.indexOf("--file") + 1]!, running: true });
        volumes.add(project);
        mutations += 1;
      } else if (args.includes("build")) mutations += 1;
    } else throw new Error(`unexpected command ${args[0]}`);
    return { code: 0, stdout, stderr: "" };
  },
};
const settings = toSettings({ OC_DATA_DIR: "/tmp/recipe-identity-check-data" });
const paths = new LocalPathBridge([]);
paths.toTarget = async (path: string) => targetFile(path);
const ctx = { runtime: {
  stack(project: string, definition: string, ownership?: { verifyOwnership: boolean; legacyProjects?: readonly string[]; recipeName?: string }) {
    assert.ok(["cache", "cache-recipe-worker", "worker"].includes(ownership?.recipeName ?? ""), "recipeStack forwards the real recipe name on positive and refusal paths");
    return buildStack(transport, paths, () => settings, (action) => action("/tmp/check.env"), project, definition, ownership);
  },
} } as unknown as Context;
try {
  useDeployment(resolve(root, "a", "deployment"));
  useComposeProjectOverride("team-a");
  const projectA = recipeProjectName("cache");
  records.set(projectA, { id: containerId("container-A"), file: targetFile(fileA), running: true });
  assert.equal((await unchanged(() => recipeStack(ctx, "cache", fileA).readLogs("10"))).trim(), containerId("container-A"));
  assert.deepEqual((await unchanged(() => recipeStack(ctx, "cache", fileA).inspect!())).namespaces, [
    { project: projectA, status: "present" },
    { project: "team-a-recipe-cache", status: "absent" },
    { project: "deployment-recipe-cache", status: "absent" },
  ]);
  useDeployment(resolve(root, "b", "deployment"));
  useComposeProjectOverride("team-b");
  const projectB = recipeProjectName("cache");
  records.set(projectB, { id: containerId("container-B"), file: targetFile(fileB), running: true });
  assert.equal((await unchanged(() => recipeStack(ctx, "cache", fileB).readLogs("10"))).trim(), containerId("container-B"));

  useDeployment(resolve(root, "a", "deployment"));
  useComposeProjectOverride("team-a");
  records.delete(projectA);
  const recipeDir = dirname(fileA);
  await mkdir(recipeDir, { recursive: true });
  await writeFile(resolve(recipeDir, "recipe.json"), "{broken");
  useRecipesDir(dirname(recipeDir));
  assert.deepEqual(await unchanged(() => runningRecipeStacks(ctx)), []);
  records.set(projectA, { id: containerId("container-A"), file: targetFile(fileA), running: true });
  await unchanged(() => assert.rejects(() => runningRecipeStacks(ctx), Error));
  assert.equal(mutations, 0);

  records.set(projectA, { id: containerId("foreign"), file: targetFile(fileB), running: false });
  const foreign = recipeStack(ctx, "cache", fileA);
  const foreignEvidence = await unchanged(() => foreign.inspect!());
  assert.deepEqual(foreignEvidence.unknown, [], "foreign refusal has a valid inventory");
  assert.equal(foreignEvidence.containers[0]?.provenance, "foreign");
  for (const operation of [() => foreign.isRunning(), () => foreign.readLogs("10"), () => foreign.down(true), () => foreign.up(), () => foreign.serviceStates()]) {
    await unchanged(() => assert.rejects(operation, ownershipRefusal));
  }
  assert.equal(mutations, 0);
  assert.equal(records.get(projectA)?.id, containerId("foreign"));
  const unnamed = buildStack(transport, paths, () => settings, (action) => action("/tmp/check.env"), projectA, fileA,
    { verifyOwnership: true, legacyProjects: ["team-a-recipe-cache", "deployment-recipe-cache"] });
  await unchanged(() => assert.rejects(() => unnamed.down(true), (error) => ownershipRefusal(error, false)));
  assert.equal(mutations, 0);
  assert.equal(records.get(projectA)?.id, containerId("foreign"));
  records.delete(projectA);

  // Both stopped predecessor schemes refuse all adoption, including default deployments.
  for (const legacy of ["team-a-recipe-cache", "deployment-recipe-cache"]) {
    records.set(legacy, { id: containerId("legacy"), file: targetFile(fileA), running: false });
    const evidence = await unchanged(() => recipeStack(ctx, "cache", fileA).inspect!());
    assert.deepEqual(evidence.unknown, [], "legacy refusal has a valid inventory, not a malformed fixture");
    assert.equal(evidence.containers[0]?.provenance, "legacy");
    assert.deepEqual(evidence.namespaces, [
      { project: projectA, status: "absent" },
      { project: "team-a-recipe-cache", status: legacy === "team-a-recipe-cache" ? "present" : "absent" },
      { project: "deployment-recipe-cache", status: legacy === "deployment-recipe-cache" ? "present" : "absent" },
    ]);
    await unchanged(() => assert.rejects(() => recipeStack(ctx, "cache", fileA).build(), ownershipRefusal));
    await unchanged(() => assert.rejects(() => runningRecipeStacks(ctx), ownershipRefusal));
    assert.equal(mutations, 0);
    assert.equal(records.get(legacy)?.id, containerId("legacy"));
    records.delete(legacy); // Explicit operator cutover, not a framework alias.
  }
  useComposeProjectOverride(undefined);
  const defaultProject = recipeProjectName("cache");
  records.set(defaultProject, { id: containerId("default"), file: targetFile(fileA), running: true });
  const single = recipeStack(ctx, "cache", fileA);
  assert.equal(await unchanged(() => single.isRunning()), true);
  await unchanged(() => single.down(true), [defaultProject]);
  assert.equal(records.has(defaultProject), false);
  assert.equal(records.get(projectB)?.id, containerId("container-B"));

  // Report pair: exercise two real stack objects through creation, logs, reinstall and removal.
  useDeployment(resolve(root, "app-a"));
  useComposeProjectOverride("team");
  const pairA = recipeStack(ctx, "cache-recipe-worker", fileA);
  const keyA = recipeProjectName("cache-recipe-worker");
  await unchanged(() => pairA.up(), [keyA]);
  useDeployment(resolve(root, "app-b"));
  useComposeProjectOverride("team-recipe-cache");
  const pairB = recipeStack(ctx, "worker", fileB);
  const keyB = recipeProjectName("worker");
  await unchanged(() => pairB.up(), [keyB]);
  assert.equal((await unchanged(() => pairA.readLogs("10"))).trim(), containerId(targetFile(fileA)));
  assert.equal((await unchanged(() => pairB.readLogs("10"))).trim(), containerId(targetFile(fileB)));
  await unchanged(() => pairB.up(), [keyB]);
  await unchanged(() => pairA.down(true), [keyA]);
  assert.equal(records.has(keyA), false);
  assert.equal(volumes.has(keyA), false);
  assert.equal(volumes.has(keyB), true);
  assert.equal(await unchanged(() => pairB.isRunning()), true);
  assert.equal((await unchanged(() => pairB.readLogs("10"))).trim(), containerId(targetFile(fileB)));
  assert.ok(wrappedQueries > 0, "ownership and running queries use the isolated sh Docker wrapper");

} finally {
  clearRecipesDir();
  useComposeProjectOverride(previousOverride);
  if (previousRoot !== undefined) useDeployment(previousRoot);
  await rm(root, { recursive: true, force: true });
}
finish("recipe-identity");

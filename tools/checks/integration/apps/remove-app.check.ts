// `./clawwright remove-app` — packages/clawwright/integration/deployment/remove.ts's removeApp().
//
// A scratch apps/ this file builds and owns, never the real one (mirrors list.check.ts):
// dry run lists and removes nothing, --yes removes for real, a bootstrapped instance
// (running or stopped) refuses either way, and name/symlink refusals never touch the
// filesystem at all.

import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { removeApp, NOTHING_REMOVED, notPresent, bootstrappedRefusal, instanceStateRefusal } from "#framework/integration/deployment/remove.ts";
import { invalidNameMessage, readName } from "#framework/core/values/names.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { NotBootstrapped } from "#framework/runtime/runtime.ts";
import type { Context } from "#framework/core/context.ts";
import type { AppDefinition } from "#framework/core/app.ts";
import type { DeploymentSummary } from "#framework/integration/list.ts";
import { check, finish } from "#checks/kit/harness.ts";

const root = await mkdtemp(join(tmpdir(), "clawwright-remove-app-check-"));

const FIXTURE_APP =
  'export default { name: "fixture", description: "fixture", service: { name: "gateway" }, ' +
  'commands: { noop: { summary: "noop", run: async () => {} } } };\n';

async function writeDeployment(name: string, port: number, withOwnGit = false): Promise<string> {
  const directory = resolve(root, name);
  await mkdir(resolve(directory, "config"), { recursive: true });
  await mkdir(resolve(directory, "secrets"), { recursive: true });
  await writeFile(resolve(directory, ".env"), `OC_DATA_DIR=/srv/${name}/data\nOC_TARGET_LOCATION=local\nOPENCLAW_GATEWAY_PORT=${port}\n`, "utf8");
  await writeFile(resolve(directory, "app.ts"), FIXTURE_APP, "utf8");
  if (withOwnGit) await mkdir(resolve(directory, ".git"), { recursive: true });
  return directory;
}

function stubContext(isRunning: () => Promise<boolean>): Context {
  return { runtime: { isRunning }, transport: { description: "local" } } as unknown as Context;
}

async function buildContext(_app: AppDefinition, directory: string): Promise<Context> {
  const name = directory.split(/[/\\]/).pop() ?? "";
  if (name.startsWith("running")) return stubContext(async () => true);
  if (name.startsWith("stopped")) return stubContext(async () => false);
  if (name.startsWith("error")) throw new Error("target unreachable");
  return stubContext(async () => { throw new NotBootstrapped(`/srv/${name}/data`); });
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

async function captured(body: () => Promise<number>): Promise<{ code: number; text: string }> {
  let text = "";
  const code = await withOutputSink((chunk) => { text += chunk; }, body);
  return { code, text };
}

// --- dry run: lists what would go, removes nothing -------------------------------------------

{
  const directory = await writeDeployment("fresh-app", 18101, true);
  const { code, text } = await captured(() => removeApp(readName("deployment", "fresh-app"), false, { appsRoot: root, buildContext }));
  check("dry run exits 0", code, 0);
  check("the directory is untouched", await exists(directory), true);
  check("it names the directory", text.includes(directory), true);
  check("it lists top-level entries", [".env", "app.ts", "config", "secrets"].every((entry) => text.includes(entry)), true);
  check("it warns about the deployment's own git history", text.includes(".git"), true);
  check("it says nothing was removed", text.includes(NOTHING_REMOVED), true);
}

// --- --yes: removes for real -------------------------------------------------------------------

{
  const directory = await writeDeployment("to-remove", 18102);
  const { code } = await captured(() => removeApp(readName("deployment", "to-remove"), true, { appsRoot: root, buildContext }));
  check("a real run exits 0", code, 0);
  check("the directory is gone", await exists(directory), false);
}

// An unreachable target is not proof that local configuration is safe to delete.
{
  const directory = await writeDeployment("error-target", 18106);
  const secretFile = resolve(directory, "secrets", "token.txt");
  await writeFile(secretFile, "fixture-secret-sentinel", "utf8");
  const message = await withOutputSink(() => {}, async () => {
    try { await removeApp(readName("deployment", "error-target"), true, { appsRoot: root, buildContext }); return ""; }
    catch (error) { return (error as Error).message; }
  });
  check("an unreachable target blocks removal", message.includes(instanceStateRefusal("error-target", "error")), true);
  check("local secret survives an unreachable target", await readFile(secretFile, "utf8"), "fixture-secret-sentinel");
}

for (const state of ["unchecked", "missing"] as const) {
  const name = `${state}-state`;
  const directory = await writeDeployment(name, 18107);
  const secretFile = resolve(directory, "secrets", "token.txt");
  await writeFile(secretFile, "fixture-secret-sentinel", "utf8");
  const listDeployments = async (): Promise<DeploymentSummary[]> => state === "missing" ? [] : [{ name, state: "unchecked" } as DeploymentSummary];
  const message = await withOutputSink(() => {}, async () => {
    try { await removeApp(readName("deployment", name), true, { appsRoot: root, buildContext, listDeployments }); return ""; }
    catch (error) { return (error as Error).message; }
  });
  check(`${state} state blocks removal`, message.includes(`state is ${state === "missing" ? "unknown" : "unchecked"}`), true);
  check(`${state} state preserves local secrets`, await readFile(secretFile, "utf8"), "fixture-secret-sentinel");
}

// --- refuses while the instance is still bootstrapped ------------------------------------------

{
  const directory = await writeDeployment("running-app", 18103);
  const message = await withOutputSink(() => {}, async () => {
    try { await removeApp(readName("deployment", "running-app"), true, { appsRoot: root, buildContext }); return ""; }
    catch (error) { return (error as Error).message; }
  });
  check("a running instance is refused", message.includes(bootstrappedRefusal("running-app", "running")), true);
  check("the directory survives the refusal", await exists(directory), true);
}

{
  const directory = await writeDeployment("stopped-app", 18104);
  const message = await withOutputSink(() => {}, async () => {
    try { await removeApp(readName("deployment", "stopped-app"), true, { appsRoot: root, buildContext }); return ""; }
    catch (error) { return (error as Error).message; }
  });
  check("a stopped-but-bootstrapped instance is refused the same way", message.includes(bootstrappedRefusal("stopped-app", "stopped")), true);
  check("the directory survives the refusal", await exists(directory), true);
}

{
  // Dry run is refused too — the state check runs before the --yes branch, not instead of it.
  const directory = await writeDeployment("running-dry", 18105);
  const message = await withOutputSink(() => {}, async () => {
    try { await removeApp(readName("deployment", "running-dry"), false, { appsRoot: root, buildContext }); return ""; }
    catch (error) { return (error as Error).message; }
  });
  check("a running instance is refused even for a dry run", message.includes(bootstrappedRefusal("running-dry", "running")), true);
  check("directory untouched", await exists(directory), true);
}

// --- refuses a name that is not a plain deployment name, before touching the filesystem -------

{
  const message = await withOutputSink(() => {}, async () => {
    try { await removeApp(readName("deployment", "../escape"), false, { appsRoot: root, buildContext }); return ""; }
    catch (error) { return (error as Error).message; }
  });
  check("a traversal name is refused", message.includes(invalidNameMessage("deployment", "../escape")), true);
}

{
  const message = await withOutputSink(() => {}, async () => {
    try { await removeApp(readName("deployment", "Not_Valid"), false, { appsRoot: root, buildContext }); return ""; }
    catch (error) { return (error as Error).message; }
  });
  check("an uppercase/underscore name is refused, same as new-app", message.includes(invalidNameMessage("deployment", "Not_Valid")), true);
}

// --- refuses a directory that does not exist ----------------------------------------------------

{
  const message = await withOutputSink(() => {}, async () => {
    try { await removeApp(readName("deployment", "no-such-deployment"), false, { appsRoot: root, buildContext }); return ""; }
    catch (error) { return (error as Error).message; }
  });
  const missing = resolve(root, "no-such-deployment");
  check("a missing deployment is refused, not silently a no-op", message.includes(notPresent(missing)), true);
}

// --- refuses a symlinked deployment directory (skipped where this host cannot create one) ------

{
  const elsewhere = resolve(root, "elsewhere-target");
  await mkdir(elsewhere, { recursive: true });
  const linkPath = resolve(root, "linked-app");
  let linked = false;
  try {
    await symlink(elsewhere, linkPath, "junction");
    linked = true;
  } catch {
    // No symlink privilege on this host (e.g. Windows without Developer Mode) — the guard
    // itself is asserted wherever it can actually be exercised, not faked here.
  }
  if (linked) {
    const message = await withOutputSink(() => {}, async () => {
      try { await removeApp(readName("deployment", "linked-app"), true, { appsRoot: root, buildContext }); return ""; }
      catch (error) { return (error as Error).message; }
    });
    check("a symlinked deployment directory is refused", message.includes("symlink"), true);
    check("the real directory it points at is untouched", await exists(elsewhere), true);
  }
}

await rm(root, { recursive: true, force: true });

finish("remove-app");

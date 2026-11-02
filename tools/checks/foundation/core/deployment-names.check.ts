// Checks the deployment directory layout and the name guard that protects it.
//
// No instance and no target: deployment.ts is module-level state set by useDeployment(),
// and names.ts is a pure function. The "never called" case is run in its own child process
// regardless — even though every check file already gets one of its own (kit/spawn.ts) —
// because the assertion is specifically about a process that never called useDeployment()
// at all, not just this file's own fresh module registry.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  deploymentDir,
  deploymentName,
  desiredStateFile,
  envFile,
  recipesDir,
  secretsDir,
  secretsTemplateFile,
  secretStoreFile,
  selectedDeployment,
  useDeployment,
  composeProjectName,
  useComposeProjectOverride,
  composeProjectOverride,
} from "#framework/runtime/deployment.ts";
import { readName, safeName } from "#framework/core/values/names.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { check, finish } from "#checks/kit/harness.ts";

function checkThrows(name: string, fn: () => unknown, messageIncludes: string[]): void {
  try {
    fn();
    check(name, "no throw", "a throw");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missing = messageIncludes.filter((needle) => !message.includes(needle));
    check(name, missing, []);
  }
}

// --- deploymentDir() before useDeployment() has ever been called -------------
// Run in a fresh process so this is a real assertion regardless of what already ran
// earlier in this suite.

async function checkNeverSelectedThrows(): Promise<void> {
  const deploymentUrl = pathToFileURL(resolve(monorepoRoot, "packages", "clawwright", "runtime", "deployment.ts")).href;
  const script = [
    `import { deploymentDir } from ${JSON.stringify(deploymentUrl)};`,
    "try {",
    "  deploymentDir();",
    '  process.stdout.write("NO_THROW");',
    "} catch (error) {",
    '  process.stdout.write(`THROW:${error instanceof Error ? error.message : String(error)}`);',
    "}",
  ].join("\n");

  const scratch = await mkdtemp(join(tmpdir(), "clawwright-deployment-names-"));
  const scriptFile = join(scratch, "deployment-dir-guard.ts");
  await writeFile(scriptFile, script, "utf8");
  try {
    const { stdout } = await new Promise<{ code: number | null; stdout: string }>((resolvePromise) => {
      const proc = spawn(process.execPath, ["--experimental-strip-types", scriptFile], {
        cwd: scratch,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      proc.stdout.on("data", (chunk) => {
        out += String(chunk);
      });
      proc.on("close", (code) => resolvePromise({ code, stdout: out }));
    });
    check(
      "deploymentDir() before useDeployment() throws, in a process where it was never called",
      stdout,
      "THROW:no deployment selected — the entry point must call useDeployment()",
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

await checkNeverSelectedThrows();

check("selectedDeployment() answers undefined rather than throwing, before useDeployment()", selectedDeployment(), undefined);

// --- deployment.ts, once a deployment is selected -----------------------------

const dir = resolve("apps", "example app");
useDeployment(dir);

check("deploymentDir() returns what useDeployment() set", deploymentDir(), dir);
check("selectedDeployment() agrees, without throwing", selectedDeployment(), dir);
check("deploymentName() is the directory's basename", deploymentName(), "example app");
check("envFile() resolves under the deployment", envFile(), resolve(dir, ".env"));
check(
  "desiredStateFile() resolves under config/",
  desiredStateFile(),
  resolve(dir, "config", "desired-state.json"),
);
check(
  "secretsTemplateFile() resolves under config/",
  secretsTemplateFile(),
  resolve(dir, "config", "secrets.template.env"),
);
check("recipesDir() resolves under the deployment", recipesDir(), resolve(dir, "recipes"));
check("secretsDir() resolves under the deployment", secretsDir(), resolve(dir, "secrets"));

check(
  "secretStoreFile() resolves a valid name under secrets/",
  secretStoreFile(readName("store", "local")),
  resolve(dir, "secrets", "local.env"),
);

checkThrows("secretStoreFile() rejects a traversal attempt", () => secretStoreFile(readName("store", "../../etc")), [
  "store",
  "../../etc",
]);
checkThrows("secretStoreFile() rejects an uppercase name", () => secretStoreFile(readName("store", "Foo")), [
  "store",
  "Foo",
]);
checkThrows("secretStoreFile() rejects a name with a space", () => secretStoreFile(readName("store", "a b")), [
  "store",
  "a b",
]);

// A traversal name must not actually land outside secrets/, even though the guard should
// have already thrown before resolve() ever ran.
check(
  "secrets/ stays a real prefix of the deployment directory",
  secretsDir().startsWith(dir + sep),
  true,
);

// --- composeProjectName() override: an instance under a name the directory itself cannot use

check("with no override, composeProjectName() is still the directory's basename", composeProjectName(), "example app");
check("and composeProjectOverride() reports none is set", composeProjectOverride(), undefined);

useComposeProjectOverride("open_claw");
check("an override is returned instead of the basename", composeProjectName(), "open_claw");
check("composeProjectOverride() reports the raw value", composeProjectOverride(), "open_claw");
check("the directory itself is untouched by the override", deploymentDir(), dir);
// The whole point of separating the two: deploy's remote apps/<name> path, archive names,
// a built set's default name — everything that reads deploymentName() — must never see a
// compose-only override. This is the specific bug the separation exists to prevent.
check("deploymentName() itself is never affected by the compose override", deploymentName(), "example app");

useComposeProjectOverride(undefined);
check("clearing the override reverts to the basename", composeProjectName(), "example app");

checkThrows(
  "an override with an uppercase letter is refused — Docker's own rule, not safeName's",
  () => useComposeProjectOverride("Open_Claw"),
  ["OC_COMPOSE_PROJECT", "Open_Claw"],
);
checkThrows(
  "an override starting with a hyphen is refused",
  () => useComposeProjectOverride("-open_claw"),
  ["OC_COMPOSE_PROJECT"],
);
useComposeProjectOverride("open_claw");
check("an override may contain an underscore — Docker accepts it even though safeName does not", composeProjectName(), "open_claw");
useComposeProjectOverride(undefined);

// --- names.ts: safeName() directly --------------------------------------------

check("safeName() accepts a plain name", safeName("app", "openclaw"), "openclaw");
check("safeName() accepts dashes and digits", safeName("app", "my-app-2"), "my-app-2");
check("safeName() accepts a single letter", safeName("app", "a"), "a");

checkThrows("safeName() rejects an empty string", () => safeName("app", ""), ["app"]);
checkThrows("safeName() rejects uppercase letters", () => safeName("app", "UPPER"), [
  "app",
  "UPPER",
]);
checkThrows("safeName() rejects a leading digit", () => safeName("app", "1start"), [
  "app",
  "1start",
]);
checkThrows("safeName() rejects a space", () => safeName("app", "has space"), [
  "app",
  "has space",
]);
checkThrows("safeName() rejects a traversal attempt", () => safeName("app", "../escape"), [
  "app",
  "../escape",
]);
checkThrows("safeName() rejects an embedded slash", () => safeName("app", "a/b"), ["app", "a/b"]);
checkThrows(
  "safeName() rejects a name over 64 characters",
  () => safeName("app", "a".repeat(65)),
  ["app"],
);

finish("deployment-names");

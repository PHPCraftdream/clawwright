// The published package, installed the way an operator installs it, running a command.
//
// Everything else in this suite tests the sources. This packs the real tarball, puts it in a
// directory that looks exactly like what `npm init -y` leaves behind, runs `clawwright init`
// there and then runs a command through the installed entry point. That path had never been
// covered, and it is where a release-blocking defect lived: `npm init -y` writes an explicit
// "type": "commonjs", under which Node refuses the ESM app.ts that init writes, so every
// command — bootstrap and both MCP servers included — died at the first import with "Cannot
// use import statement outside a module". Sources, typecheck, lint and pack:check were all
// green while the thing being shipped did not start.
//
// Dependencies are copied from this repository's own node_modules rather than installed:
// the point here is the packed tarball and the consumer's package.json, not npm's resolver,
// and a check that needs the registry cannot run on a machine without one.

import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, cp, access, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { monorepoRoot } from "#framework/core/env.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { runProcess } from "#checks/kit/spawn.ts";
import { maskSecrets } from "#framework/core/io/log.ts";

interface Run {
  code: number;
  output: string;
}

/** spawnLocal has no cwd, and every step here is about which directory it runs in. */
async function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<Run> {
  // runProcess runs npm.cmd through a shell on Windows, the command itself unquoted.
  const result = await runProcess(command, args, { cwd, env });
  return { code: result.error === undefined ? (result.code ?? -1) : -1, output: result.output };
}

// What `npm init -y` writes, verbatim in shape — including the "main" naming a file it does
// not create, and the "type" that used to make the deployment unloadable.
const DEFAULT_CONSUMER_PACKAGE = {
  name: "cf-consumer",
  version: "1.0.0",
  main: "index.js",
  scripts: { test: 'echo "Error: no test specified" && exit 1' },
  keywords: [] as string[],
  author: "",
  license: "ISC",
  type: "commonjs",
};

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const base = await mkdtemp(join(tmpdir(), "clawwright-installed-check-"));
// Declared here so the finally can clean up even when the failure happens before the
// assignment inside the try block.
let packRoot: string | undefined;

try {
  // --- pack the real thing from a temp copy of the packing tree ---------------------------
  // npm runs the package's prepack, which builds dist/. Packing a temp copy (same layout as
  // system-install.check.ts) means that dist/ lands in the temp tree, never in the checkout.
  packRoot = await mkdtemp(join(tmpdir(), "clawwright-pack-"));
  await mkdir(join(packRoot, "tools"), { recursive: true });
  await mkdir(join(packRoot, "packages"), { recursive: true });
  await cp(resolve(monorepoRoot, "packages", "clawwright"), join(packRoot, "packages", "clawwright"), {
    recursive: true,
    filter: (entry) => {
      const name = basename(entry);
      return name !== "dist" && name !== "node_modules";
    },
  });
  await cp(resolve(monorepoRoot, "tsconfig.json"), join(packRoot, "tsconfig.json"));
  await cp(resolve(monorepoRoot, "tools", "build-framework-package.ts"), join(packRoot, "tools", "build-framework-package.ts"));
  await symlink(resolve(monorepoRoot, "node_modules"), join(packRoot, "node_modules"), "junction"); // type is used on Windows only, ignored elsewhere
  const packed = await run(npm, ["pack", "--pack-destination", base], join(packRoot, "packages", "clawwright"));
  const tarballs = packed.code === 0 ? (await readdir(base)).filter((entry) => entry.endsWith(".tgz")) : [];

  if (tarballs.length === 0) {
    process.stderr.write(`    ${packed.output.trim().split("\n").slice(-3).join("\n    ")}\n`);
  }
  check("npm pack produces a tarball", tarballs.length > 0, true);
  if (tarballs.length > 0) {
    const extracted = join(base, "extracted");
    await mkdir(extracted, { recursive: true });
    // Relative paths, with the working directory doing the work: GNU tar reads `D:\x` as a
    // remote host spec ("Cannot connect to D") and bsdtar has no --force-local to turn that
    // off, so no absolute Windows path is handed to it at all.
    const untarred = await run("tar", ["-xzf", tarballs[0], "-C", "extracted"], base);
    check("the tarball unpacks", untarred.code === 0 ? 0 : untarred.output.trim(), 0);
    const unpackedPackage = join(extracted, "package");
    for (const file of ["README.md", "LICENSE", "LICENSE-MIT", "LICENSE-APACHE", "NOTICE", "THIRD_PARTY_NOTICES.md", "package.json"]) {
      const source = resolve(monorepoRoot, "packages", "clawwright", file);
      const packedFile = resolve(unpackedPackage, file);
      const [sourceBytes, packedBytes] = await Promise.all([readFile(source), readFile(packedFile)]);
      check(`packed file bytes match checkout: ${file}`, packedBytes.equals(sourceBytes), true);
    }
    const packedManifest = JSON.parse(await readFile(resolve(unpackedPackage, "package.json"), "utf8")) as { bin?: Record<string, string>; exports?: Record<string, unknown>; files?: string[] };
    check("packed bin declaration points at the compiled entry", packedManifest.bin?.clawwright, "dist/entry/bin.js");
    async function inventory(root: string, dir = root): Promise<string[]> {
      const entries = await readdir(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) files.push(...await inventory(root, path));
        else files.push(path.slice(root.length + 1).replaceAll("\\", "/"));
      }
      return files.sort();
    }
    const builtDist = resolve(packRoot, "packages", "clawwright", "dist");
    const builtFiles = await inventory(builtDist);
    check("the builder emits the package assets", [builtFiles.includes(".env.example"), builtFiles.includes("docker-compose.yml")], [true, true]);
    const expectedArchiveFiles = [
      ...(packedManifest.files ?? []).filter((path) => path !== "dist"),
      "package.json",
      ...builtFiles.map((path) => `dist/${path}`),
    ].sort();
    const archiveFiles = await inventory(unpackedPackage);
    check("packed archive has exactly the manifest allowlist and package.json", JSON.stringify(archiveFiles), JSON.stringify(expectedArchiveFiles));
    for (const path of builtFiles) {
      const builtBytes = await readFile(resolve(builtDist, path));
      const archiveBytes = await readFile(resolve(unpackedPackage, "dist", path));
      check(`packed dist bytes match the temp prepack build: ${path}`, archiveBytes.equals(builtBytes), true);
    }

    // --- a consumer directory exactly as npm leaves it --------------------------------------
    const consumer = join(base, "consumer");
    await mkdir(join(consumer, "node_modules", "@phpcraftdream"), { recursive: true });
    await writeFile(resolve(consumer, "package.json"), `${JSON.stringify(DEFAULT_CONSUMER_PACKAGE, undefined, 2)}\n`, "utf8");
    await cp(join(extracted, "package"), join(consumer, "node_modules", "@phpcraftdream", "clawwright"), { recursive: true });
    await cp(resolve(monorepoRoot, "node_modules", "json5"), join(consumer, "node_modules", "json5"), { recursive: true });

    for (const specifier of ["@phpcraftdream/clawwright/app", "@phpcraftdream/clawwright/mounts", "@phpcraftdream/clawwright/commands", "@phpcraftdream/clawwright/recipe-kit", "@phpcraftdream/clawwright/private-config"]) {
      const imported = await run(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(specifier)})`], consumer);
      check(`installed public import resolves from node_modules: ${specifier}`, imported.code, 0);
    }

    const entry = join(consumer, "node_modules", "@phpcraftdream", "clawwright", "dist", "entry", "bin.js");
    check("the packed entry point is where the bin field says it is", await access(entry).then(() => true, () => false), true);

    // --- init, then a command, both through the installed entry point -----------------------
    const initialised = await run(process.execPath, ["--experimental-strip-types", entry, "init"], consumer);
    check("init succeeds in a default consumer directory", initialised.code, 0);
    check("init's commit advice names mcp-launch.mjs, not a single file", initialised.output.includes("mcp-launch.mjs") && !initialised.output.includes("only framework-adjacent"), true);

    const consumerPackage = JSON.parse(await readFile(resolve(consumer, "package.json"), "utf8")) as { type?: string };
    check("and leaves the directory loadable as ESM", consumerPackage.type, "module");
    check("app.ts is written", await access(resolve(consumer, "app.ts")).then(() => true, () => false), true);
    check("and so is the ./clawwright shim", await access(resolve(consumer, "clawwright")).then(() => true, () => false), true);

    // The generated declaration is also the public API's compile-time contract. Assert a
    // concrete callback type and reject `any`, so a present-but-empty declaration cannot pass.
    await writeFile(resolve(consumer, "typecheck.ts"), `import app from "./app.ts";
import { defineApp, type AppDefinition } from "@phpcraftdream/clawwright/app";

type IsAny<T> = 0 extends (1 & T) ? true : false;
type AssertFalse<T extends false> = T;
type SummaryIsTyped = AssertFalse<IsAny<typeof app.commands.bootstrap.summary>>;
const typedApp: AppDefinition = defineApp({
  name: "typed-consumer",
  description: "type check",
  commands: {
    ping: {
      summary: "ping",
      run: async (ctx, args) => {
        type ContextIsTyped = AssertFalse<IsAny<typeof ctx>>;
        type ArgsIsTyped = AssertFalse<IsAny<typeof args>>;
        const code: number = (await ctx.transport.exec("true", [])).code;
        const first: string | undefined = args[0];
        const contextTypeGuard: ContextIsTyped = false;
        const argsTypeGuard: ArgsIsTyped = false;
        void code;
        void first;
        void contextTypeGuard;
        void argsTypeGuard;
      },
    },
  },
});
void typedApp;
const summaryTypeGuard: SummaryIsTyped = false;
void summaryTypeGuard;
`, "utf8");
    await writeFile(resolve(consumer, "tsconfig.json"), `${JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        allowImportingTsExtensions: true,
        strict: true,
        skipLibCheck: false,
        noEmit: true,
      },
      include: ["app.ts", "typecheck.ts"],
    }, undefined, 2)}\n`, "utf8");
    const tsgo = join(monorepoRoot, "node_modules", "@typescript", "native-preview", "bin", "tsgo");
    const typed = await run(process.execPath, ["--experimental-strip-types", tsgo, "--project", "tsconfig.json"], consumer);
    check("generated app.ts typechecks against the public API", typed.code, 0);
    if (typed.code !== 0) process.stderr.write(`    ${typed.output.trim().split("\n").slice(0, 8).join("\n    ")}\n`);

    // The decisive one: bin.js dynamically imports the deployment's own app.ts, which is what
    // the consumer's package.json decides how to read.
    const helped = await run(process.execPath, ["--experimental-strip-types", entry, "help"], consumer);
    check("a command runs against the installed package", helped.code, 0);
    check("and the deployment's own commands are what it lists", helped.output.includes("bootstrap"), true);
    if (helped.code !== 0) process.stderr.write(`    ${helped.output.trim().split("\n").slice(0, 5).join("\n    ")}\n`);

    // Exercise the shipped loader with a consumer-owned TypeScript graph, not source files.
    const hookDir = join(consumer, "recipes", "hook-check");
    await mkdir(hookDir, { recursive: true });
    await writeFile(join(hookDir, "helper.ts"), 'export const value: string = "first";\n', "utf8");
    await writeFile(join(hookDir, "verify.ts"), 'import { value } from "./helper.ts";\nexport function verify(): string { return value; }\n', "utf8");
    await writeFile(join(consumer, "hook-check.mjs"), `import { strict as assert } from "node:assert";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { importHookModule } from "./node_modules/@phpcraftdream/clawwright/dist/commands/management/recipe/hook-runtime.js";
const hook = fileURLToPath(new URL("./recipes/hook-check/verify.ts", import.meta.url));
assert.equal((await importHookModule(hook)).verify(), "first");
await writeFile(new URL("./recipes/hook-check/helper.ts", import.meta.url), 'export const value: string = "second";\\n');
assert.equal((await importHookModule(hook)).verify(), "second");
`, "utf8");
    const hookResult = await run(process.execPath, ["--experimental-strip-types", "hook-check.mjs"], consumer);
    check("the installed loader executes a TypeScript hook and reloads its relative helper", hookResult.code, 0);
    if (hookResult.code !== 0) process.stderr.write(`    ${hookResult.output.trim().split("\n").slice(0, 8).join("\n    ")}\n`);

    // What the npm-linked bin actually gets: a plain `#!/usr/bin/env node`, because busybox
    // `env` has no -S to carry a flag. With type stripping disabled, bin.js must notice and
    // re-execute itself with --experimental-strip-types before loading the consumer app.ts.
    // --no-experimental-strip-types reproduces that here on any Node.
    const stripless = await run(process.execPath, ["--no-experimental-strip-types", entry, "help"], consumer);
    check("and runs on a Node that does not strip types until asked", stripless.code, 0);
    check("listing the same commands after re-executing itself", stripless.output.includes("bootstrap"), true);
    if (stripless.code !== 0) process.stderr.write(`    ${stripless.output.trim().split("\n").slice(0, 5).join("\n    ")}\n`);
  }
} finally {
  if (packRoot !== undefined) {
    // The link to the checkout's node_modules goes first, on its own and without following it.
    await rm(join(packRoot, "node_modules"), { force: true });
    await rm(packRoot, { recursive: true, force: true });
  }
  await rm(base, { recursive: true, force: true });
}

// Source-checkout relocation compatibility is exercised separately from the published tarball:
// the fixture has the canonical packages/clawwright + tools/clawwright.ts geometry, but no
// tools/framework mirror. Its generated legacy app and current public-import app both run
// through the checkout gate and must observe the same canonical framework module instances.
async function relocatedCheckoutConsumer(): Promise<void> {
  const checkout = await mkdtemp(join(tmpdir(), "clawwright-relocated-checkout-"));
  const sourcePackage = join(checkout, "packages", "clawwright");
  try {
    await mkdir(join(checkout, "packages"), { recursive: true });
    await mkdir(join(checkout, "tools"), { recursive: true });
    await cp(resolve(monorepoRoot, "packages", "clawwright"), sourcePackage, {
      recursive: true,
      filter: (entry) => basename(entry) !== "dist" && basename(entry) !== "node_modules",
    });
    await cp(resolve(monorepoRoot, "tools", "clawwright.ts"), join(checkout, "tools", "clawwright.ts"));
    await symlink(resolve(monorepoRoot, "node_modules"), join(checkout, "node_modules"), "junction");
    await writeFile(join(checkout, "package.json"), JSON.stringify({ type: "module" }), "utf8");

    const apps = join(checkout, "apps");
    for (const app of ["legacy", "current"]) await mkdir(join(apps, app), { recursive: true });
    const legacyText = `import { defineApp } from "../../tools/framework/core/app.ts";
import { mountPoints } from "../../tools/framework/runtime/mounts.ts";
import { openclawCommands } from "../../tools/framework/commands/interface/index.ts";
import { commandBody, materializeCommands } from "../../packages/clawwright/core/command/spec.ts";

export default defineApp({
  name: "legacy",
  description: "legacy compatibility probe",
  commands: materializeCommands({
    "compat-probe": {
      summary: "compatibility probe",
      ...commandBody({
        effect: "read",
        needs: "nothing",
        arguments: [],
        run: async () => {
          const publicApp = await import("@phpcraftdream/clawwright/app");
          const publicMounts = await import("@phpcraftdream/clawwright/mounts");
          const publicCommands = await import("@phpcraftdream/clawwright/commands");
          console.log(JSON.stringify({
            marker: "legacy",
            sameDefineApp: defineApp === publicApp.defineApp,
            sameMountPoints: mountPoints === publicMounts.mountPoints,
            sameCommands: openclawCommands === publicCommands.openclawCommands,
            mountCount: Object.keys(mountPoints).length,
          }));
        },
      }),
    },
  }),
});
`;
    const currentText = `import { defineApp } from "../../packages/clawwright/core/app.ts";
import { mountPoints } from "../../packages/clawwright/runtime/mounts.ts";
import { openclawCommands } from "../../packages/clawwright/commands/interface/index.ts";
import { commandBody, materializeCommands } from "../../packages/clawwright/core/command/spec.ts";

export default defineApp({
  name: "current",
  description: "public source import probe",
  commands: materializeCommands({
    "compat-probe": {
      summary: "compatibility probe",
      ...commandBody({
        effect: "read",
        needs: "nothing",
        arguments: [],
        run: async () => {
          const publicApp = await import("@phpcraftdream/clawwright/app");
          const publicMounts = await import("@phpcraftdream/clawwright/mounts");
          const publicCommands = await import("@phpcraftdream/clawwright/commands");
          console.log(JSON.stringify({
            marker: "current",
            sameDefineApp: defineApp === publicApp.defineApp,
            sameMountPoints: mountPoints === publicMounts.mountPoints,
            sameCommands: openclawCommands === publicCommands.openclawCommands,
            mountCount: Object.keys(mountPoints).length,
          }));
        },
      }),
    },
  }),
});
`;
    const paths = { legacy: join(apps, "legacy", "app.ts"), current: join(apps, "current", "app.ts") };
    await writeFile(join(apps, "legacy", "app.ts"), legacyText, "utf8");
    await writeFile(join(apps, "current", "app.ts"), currentText, "utf8");
    const before = { legacy: await readFile(paths.legacy), current: await readFile(paths.current) };
    const noMirror = await access(join(checkout, "tools", "framework")).then(() => false, () => true);
    check("relocated checkout fixture has no tools/framework mirror", noMirror, true);

    const gate = join(checkout, "tools", "clawwright.ts");
    const packageEntry = join(sourcePackage, "entry", "bin.ts");
    const childEnv = { ...process.env, CLAWWRIGHT_CHECKS_APPS_DIR: apps };
    for (const name of ["legacy", "current"] as const) {
      const result = await run(process.execPath, ["--experimental-strip-types", gate, "--app", name, "compat-probe"], join(apps, name), childEnv);
      check(`${name} app runs through the relocated checkout gate`, result.code, 0);
      if (result.code !== 0) {
        const diagnostic = maskSecrets(result.output).slice(-2000).split(/\r?\n/).slice(-20).join("\n    ");
        process.stderr.write(`    ${diagnostic}\n`);
      }
      for (const identity of ["sameDefineApp", "sameMountPoints", "sameCommands"])
        check(`${name} app shares canonical ${identity} module state`, result.output.includes(`\"${identity}\":true`), true);
      check(`${name} compatibility probe identifies its unchanged app`, result.output.includes(`\"marker\":\"${name}\"`), true);

      const delegated = await run(process.execPath, ["--experimental-strip-types", packageEntry, "--app", name, "compat-probe"], join(apps, name), childEnv);
      check(`${name} package entry delegates to the relocated checkout gate`, delegated.code, 0);
      if (delegated.code !== 0) {
        const diagnostic = maskSecrets(delegated.output).slice(-2000).split(/\r?\n/).slice(-20).join("\n    ");
        process.stderr.write(`    ${name} delegated invocation failure:\n    ${diagnostic}\n`);
      }
      check(`${name} delegated invocation loads the original app`, delegated.output.includes(`\"marker\":\"${name}\"`), true);

      const version = await run(process.execPath, ["--experimental-strip-types", gate, "--app", name, "version", "--json"], join(apps, name), childEnv);
      check(`${name} checkout version JSON succeeds`, version.code, 0);
      if (version.code !== 0) {
        const diagnostic = maskSecrets(version.output).slice(-2000).split(/\r?\n/).slice(-20).join("\n    ");
        process.stderr.write(`    ${name} checkout version failure:\n    ${diagnostic}\n`);
      }
      let versionData: { source?: string; path?: string } | undefined;
      try { versionData = JSON.parse(version.output) as { source?: string; path?: string }; } catch { /* checked below */ }
      check(`${name} version JSON identifies the relocated checkout`, [versionData?.source, versionData?.path], ["checkout", await realpath(checkout)]);
    }

    // Keep all unrelated imports valid so removing the parent-scope guard would load this app.
    const isolatedLegacyText = legacyText.replace(
      '"../../packages/clawwright/core/command/spec.ts"',
      JSON.stringify(pathToFileURL(join(sourcePackage, "core", "command", "spec.ts")).href),
    );
    const nestedDir = join(apps, "nested", "inside");
    await mkdir(nestedDir, { recursive: true });
    const nestedApp = join(nestedDir, "app.ts");
    await writeFile(nestedApp, isolatedLegacyText, "utf8");
    const nestedUrl = pathToFileURL(nestedApp).href;
    const nested = await run(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `import { resolveFrameworkFromSources } from ${JSON.stringify(pathToFileURL(join(sourcePackage, "entry", "delegate.ts")).href)}; resolveFrameworkFromSources(); try { await import(${JSON.stringify(nestedUrl)}); console.log("UNEXPECTED_APP_LOADED"); } catch (error) { console.log(error.code ?? "IMPORT_FAILED"); }`], checkout, childEnv);
    check("nested app paths are not granted legacy import remapping", nested.output.includes("UNEXPECTED_APP_LOADED"), false);
    check("nested app fails with ordinary unresolved legacy import", nested.output.includes("ERR_MODULE_NOT_FOUND"), true);

    const outside = join(checkout, "outside-app.ts");
    await writeFile(outside, isolatedLegacyText, "utf8");
    const outsideUrl = pathToFileURL(outside).href;
    const outsideRun = await run(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `import { resolveFrameworkFromSources } from ${JSON.stringify(pathToFileURL(join(sourcePackage, "entry", "delegate.ts")).href)}; resolveFrameworkFromSources(); try { await import(${JSON.stringify(outsideUrl)}); console.log("UNEXPECTED_APP_LOADED"); } catch (error) { console.log(error.code ?? "IMPORT_FAILED"); }`], checkout, childEnv);
    check("app outside apps/<one-dir> is not granted legacy import remapping", outsideRun.output.includes("UNEXPECTED_APP_LOADED"), false);
    check("outside app fails with ordinary unresolved legacy import", outsideRun.output.includes("ERR_MODULE_NOT_FOUND"), true);

    const unsupported = join(apps, "unsupported", "app.ts");
    await mkdir(join(apps, "unsupported"), { recursive: true });
    const unsupportedText = 'import "../../tools/framework/core/env.ts";\n' + legacyText.replaceAll('"legacy"', '"unsupported"');
    await writeFile(unsupported, unsupportedText, "utf8");
    const unsupportedRun = await run(process.execPath, ["--experimental-strip-types", gate, "--app", "unsupported", "compat-probe"], checkout, childEnv);
    check("unlisted legacy source imports use ordinary resolution and fail", unsupportedRun.code === 0, false);
    check("unsupported import fails before app command execution", unsupportedRun.output.includes('"marker":"unsupported"'), false);

    check("legacy generated app bytes remain unchanged", (await readFile(paths.legacy)).equals(before.legacy), true);
    check("current generated app bytes remain unchanged", (await readFile(paths.current)).equals(before.current), true);
  } finally {
    await rm(join(checkout, "node_modules"), { force: true });
    await rm(checkout, { recursive: true, force: true });
  }
}

await relocatedCheckoutConsumer();

finish("installed consumer");

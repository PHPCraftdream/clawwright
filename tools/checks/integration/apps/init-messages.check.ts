// What `clawwright init` tells the user (round 26, R26-06 / R26-16): an accurate list of what to
// commit, a .env header true in both modes, absolute documentation URLs, and the opt-in
// `--local` remedy for editor types. Runs initApp in a scratch directory.

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initApp, makeInitGateCommand, INIT_ARGUMENTS } from "#framework/integration/deployment/init.ts";
import { setInvocation } from "#framework/core/io/invocation/index.ts";
import { docsUrl } from "#framework/core/io/docs-url.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

async function initIn(directory: string, options?: { local?: boolean }): Promise<{ output: string; env: string; directory: string }> {
  let output = "";
  await withOutputSink((chunk) => {
    output += chunk;
  }, () => initApp(directory, options));
  return { output, env: await readFile(resolve(directory, ".env"), "utf8"), directory };
}

const fixtureRoot = await mkdtemp(join(tmpdir(), "clawwright-init-messages-"));
try {
  const plainDirectory = join(fixtureRoot, "plain", "deployment");
  const localDirectory = join(fixtureRoot, "local", "deployment");
  const hintDirectory = join(fixtureRoot, "hint", "deployment");
  await mkdir(plainDirectory, { recursive: true });
  await mkdir(localDirectory, { recursive: true });
  await mkdir(hintDirectory, { recursive: true });
  const plain = await initIn(plainDirectory);
  const local = await initIn(localDirectory, { local: true });
  setInvocation({ program: "./clawwright", mode: "local-package", audience: "terminal" });
  const localPackageHint = await initIn(hintDirectory);
  setInvocation({ program: "./clawwright", mode: "checkout", audience: "terminal" });
  checkTrue("the commit advice names mcp-launch.mjs", plain.output.includes("mcp-launch.mjs"));
  checkTrue("...and app.ts, package.json, config/ and recipes/", ["app.ts", "package.json", "config/", "recipes/"].every((name) => plain.output.includes(name)));
  checkTrue("the false 'only framework-adjacent file' claim is gone", !plain.output.includes("only framework-adjacent"));

  checkTrue("the .env header does not claim new-app alone copies it", !plain.env.includes("`./clawwright new-app <name>` copies this"));
  checkTrue("...and names both new-app and init", /new-app` and `init`/.test(plain.env));

  checkTrue("without --local, init hints at it", plain.output.includes("clawwright init --local"));
  checkTrue("--local prints an npm install that saves no machine path", local.output.includes("npm install --no-save "));
  checkTrue("--local does not hint at itself", !local.output.includes("clawwright init --local"));
  const localPackage = JSON.parse(await readFile(resolve(local.directory, "package.json"), "utf8")) as { devDependencies?: unknown };
  check("--local writes no machine path into package.json", localPackage.devDependencies, undefined);

  // The hint goes through the renderer (review R2-1): under a local-package invocation the
  // pasted command must name the program as typed, never the bare installed spelling.
  const hint = /(\S+) init --local/.exec(localPackageHint.output)?.[1];
  check("a local-package invocation spells the hint with the program as typed", hint, "./clawwright");
  checkTrue("...and never the bare installed spelling", !/(^|[^/.\w])clawwright init --local/.test(localPackageHint.output));
  check("init declares --local through the argument machinery", INIT_ARGUMENTS.map((argument) => argument.name), ["local"]);

  // The localTypesOnly path must parse argv like every other path: an unknown flag is
  // refused at parse, not silently ignored, and the happy path still prints its lines.
  {
    const gate = makeInitGateCommand("D:/root", { localTypesOnly: true, ancestor: "D:/elsewhere" });
    let refusal = "";
    const refusedCode = await withOutputSink((chunk) => { refusal += chunk; }, async () => gate.run!(["--bogus"]));
    checkTrue("init --bogus exits non-zero on the local-types-only path", refusedCode === 1);
    check("init --bogus is refused at parse on the local-types-only path", refusal.includes("unknown argument: --bogus"), true);
    const printed: string[] = [];
    let happyError: unknown;
    await withOutputSink((chunk) => printed.push(chunk), async () => {
      try {
        await gate.run!([]);
      } catch (error) {
        happyError = error;
      }
    });
    check("the local-types-only path runs its happy path", happyError === undefined && printed.join("").includes("editor types:"), true);
  }

  const homepage = (JSON.parse(await readFile(resolve(monorepoRoot, "packages", "clawwright", "package.json"), "utf8")) as { homepage: string }).homepage;
  check("docsUrl points at the package's own repository, default branch", docsUrl("x.md"), `${homepage.replace(/#readme$/, "")}/blob/main/docs/x.md`);
} finally {
  setInvocation({ program: "./clawwright", mode: "checkout", audience: "terminal" });
  await rm(fixtureRoot, { recursive: true, force: true });
}

finish("init-messages");

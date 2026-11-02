// check:exclusive — writes a scratch deployment into apps/ that the gate spawns it drives resolve under this checkout's apps/, which siblings' gate spawns and any apps/ enumeration must not see; exclusivity also keeps the runner's checkout guard from racing the fixture.
// Checks that --help actually shows help for the framework-level pseudo-commands —
// new-app, control-mcp, help itself — instead of running the real thing. Also checks that
// `./clawwright help` works in a checkout with no deployments at all, before any app.ts exists to
// load commands from.
//
// control-mcp is the sharp edge: before this was fixed, `./clawwright control-mcp --help` started
// the real MCP server and waited on stdin forever, since --help was only checked for
// commands looked up in app.commands, and control-mcp is dispatched before that lookup
// ever runs. A hang can't be told apart from a slow process without a real timeout, so
// this spawns the real gate (tools/clawwright.ts) with a bounded wait rather than asserting on a
// direct function call.

import { rm, readFile, access } from "node:fs/promises";
import { createName } from "#framework/core/values/names.ts";
import { cp, mkdir, symlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { createApp } from "#framework/integration/deployment/scaffold.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { unknownArgumentMessage } from "#framework/core/command/index.ts";
import { UNKNOWN_COMMAND } from "#framework/integration/gate.ts";
import { check, finish, isolatedAppsRoot } from "#checks/kit/harness.ts";
import { CHILD_NODE_DEADLINE_MS, runProcess } from "#checks/kit/spawn.ts";
import { maskSecrets } from "#framework/core/io/log.ts";

/** Runs the real gate with a hard deadline. stdin stays an open, never-written pipe: a server
 *  wrongly started by --help would block on it, whereas /dev/null's EOF would let it exit and hide
 *  the hang. The deadline is generous — a cold start under a loaded machine is slow, a hang is forever. */
const childSource = await isolatedAppsRoot("cli-help-source");
await cp(resolve(monorepoRoot, "tools"), resolve(childSource.root, "tools"), { recursive: true });
await mkdir(resolve(childSource.root, "packages"), { recursive: true });
await cp(resolve(monorepoRoot, "packages", "clawwright"), resolve(childSource.root, "packages", "clawwright"), {
  recursive: true,
  filter: (entry) => !["dist", "node_modules"].includes(entry.split(/[\\/]/).at(-1) ?? ""),
});
await access(resolve(childSource.root, "packages", "clawwright", "entry", "bin.ts"));
await cp(resolve(monorepoRoot, "package.json"), resolve(childSource.root, "package.json"));
await symlink(resolve(monorepoRoot, "node_modules"), resolve(childSource.root, "node_modules"), "junction");
await mkdir(resolve(childSource.root, "apps"));

async function runGate(args: string[], timeoutMs = CHILD_NODE_DEADLINE_MS): Promise<{ code: number | null; stdout: string; timedOut: boolean }> {
  const result = await runProcess(
    process.execPath,
    ["--experimental-strip-types", resolve(childSource.root, "tools", "clawwright.ts"), ...args],
    { cwd: childSource.root, keepStdinOpen: true, timeoutMs },
  );
  if (result.code !== 0 && args.includes("--help")) {
    const diagnostic = maskSecrets(result.output).slice(-2000).split(/\r?\n/).slice(-20).join("\n    ");
    process.stderr.write(`    cli-help fixture help child exit failure:\n    ${diagnostic}\n`);
  }
  return { code: result.code, stdout: result.output, timedOut: result.timedOut };
}

const deploymentName = `cli-help-check-${randomBytes(4).toString("hex")}`;

const apps = await isolatedAppsRoot("cli-help");
try {
  await createApp(createName("deployment", deploymentName));

  // new-app's own .gitignore must keep machine-local, regenerated-every-cycle state out of a
  // deployment's git history (state/watch.json, sets/*.tar.gz and sets/.tries|receipts/) while
  // leaving config/, recipes/ and deployment.lock.json — the parts lock.ts's own advice tells
  // an operator to commit — trackable. Only actual ignore-pattern lines count: an explanatory
  // comment mentioning "config/" in passing must not read as excluding it.
  const gitignoreLines = (await readFile(resolve(apps.root, deploymentName, ".gitignore"), "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  check("the deployment .gitignore excludes machine-local watch state", gitignoreLines.includes("state/"), true);
  check("and excludes built set artifacts", gitignoreLines.includes("sets/"), true);
  check("but leaves config/ trackable", gitignoreLines.includes("config/"), false);
  check("and leaves recipes/ trackable", gitignoreLines.includes("recipes/"), false);
  check("and leaves deployment.lock.json trackable", gitignoreLines.includes("deployment.lock.json"), false);

  const controlHelp = await runGate(["--app", deploymentName, "control-mcp", "--help"]);
  check("control-mcp --help does not hang waiting on stdin", controlHelp.timedOut, false);
  check("control-mcp --help exits cleanly", controlHelp.code, 0);
  check("control-mcp --help explains itself, not silence", controlHelp.stdout.includes("MCP tools"), true);

  // Same boundary, short spelling: `-h` after a `--` is no help request, so control-mcp does
  // not print its help (it declares no arguments, so the token is refused) — assert on stdout.
  const controlShortAfterSeparator = await runGate(["--app", deploymentName, "control-mcp", "--", "-h"]);
  check("`-h` after a `--` does not print control-mcp's help", controlShortAfterSeparator.stdout.includes("MCP tools"), false);

  // `help` declares one positional and control-mcp none: extra or unknown tokens are refused
  // instead of being silently dropped (a started server, a help page for a typo'd call).
  const controlBogus = await runGate(["--app", deploymentName, "control-mcp", "--bogus", "extra"]);
  check("control-mcp --bogus extra does not start the server", controlBogus.timedOut, false);
  check("control-mcp --bogus extra exits non-zero", controlBogus.code, 1);
  check("control-mcp --bogus extra names the unknown argument", controlBogus.stdout.includes(unknownArgumentMessage("--bogus")), true);
  const helpBogus = await runGate(["--app", deploymentName, "help", "status", "--bogus", "extra"]);
  check("help status --bogus extra exits non-zero", helpBogus.code, 1);
  check("help status --bogus extra names the unknown argument", helpBogus.stdout.includes(unknownArgumentMessage("--bogus")), true);
  check("help status --bogus extra prints no help page", helpBogus.stdout.includes("Usage:"), false);
  const helpExtra = await runGate(["--app", deploymentName, "help", "status", "extra"]);
  check("help status extra (a second positional) exits non-zero", helpExtra.code, 1);
  check("help status extra names the stray word", helpExtra.stdout.includes(unknownArgumentMessage("extra")), true);
  const helpStatus = await runGate(["--app", deploymentName, "help", "status", "--help"]);
  check("help status --help is still a help request", helpStatus.code, 0);

  // The word after a bare `--` is the same positional: `help -- status` is `help status`.
  const helpPlain = await runGate(["--app", deploymentName, "help", "status"]);
  for (const argv of [["help", "--", "status"], ["help", "status", "--"]]) {
    const dashed = await runGate(["--app", deploymentName, ...argv]);
    check(`${argv.join(" ")} exits cleanly`, dashed.code, 0);
    check(`${argv.join(" ")} prints what help status prints`, dashed.stdout, helpPlain.stdout);
    check(`${argv.join(" ")} reports no unknown command`, dashed.stdout.includes(UNKNOWN_COMMAND), false);
  }

  const helpHelp = await runGate(["--app", deploymentName, "help", "--help"]);
  check("help --help exits cleanly", helpHelp.code, 0);
  check("help --help falls back to the command list", helpHelp.stdout.includes(`Usage: ./clawwright --app ${deploymentName} <command>`), true);

  // `help control-mcp` used to fail with "unknown command: control-mcp / did you mean:
  // control-mcp" — the general help and completion both offer it, but renderHelp knew only
  // app.commands and gate commands, while closestCommand happily suggested the exact match.
  const helpControl = await runGate(["--app", deploymentName, "help", "control-mcp"]);
  check("help control-mcp exits cleanly", helpControl.code, 0);
  check("help control-mcp does not report itself unknown", helpControl.stdout.includes("unknown command"), false);
  check("help control-mcp does not suggest itself", helpControl.stdout.includes("did you mean: control-mcp"), false);
  check("help control-mcp prints its help", helpControl.stdout.includes("MCP tools"), true);

  // mcp-serve and the other framework-owned names live in the declarations renderHelp
  // already reads; spot-check that `help <name>` answers for one of them too.
  const helpMcpServe = await runGate(["--app", deploymentName, "help", "mcp-serve"]);
  check("help mcp-serve exits cleanly", helpMcpServe.code, 0);
  check("help mcp-serve prints its help", helpMcpServe.stdout.includes("mcp-serve —"), true);

  const newAppHelp = await runGate(["new-app", "--help"]);
  check("new-app --help exits cleanly", newAppHelp.code, 0);
  check("new-app --help explains itself", newAppHelp.stdout.includes("new-app"), true);
  // The real regression this guards: --help used to be treated as the deployment name and
  // rejected by safeName, instead of being recognised as a request for help.
  check("new-app --help is not treated as an invalid deployment name", newAppHelp.stdout.includes("invalid"), false);

  // `help help` used to fall through to reportUnknownCommand, which then suggested "help" for
  // the very word just typed — "help" is always in its own candidate pool.
  const helpForHelp = await runGate(["--app", deploymentName, "help", "help"]);
  check("help help exits cleanly", helpForHelp.code, 0);
  check("help help does not report itself as unknown", helpForHelp.stdout.includes("unknown command"), false);
  check("help help does not suggest itself", helpForHelp.stdout.includes("did you mean: help"), false);
  check("help help falls back to the command list", helpForHelp.stdout.includes(`Usage: ./clawwright --app ${deploymentName} <command>`), true);

  // `new-app a b` used to read args[0] directly, so "b" vanished silently instead of being
  // refused — the shared declaration parser refuses any token past the one declared positional.
  const extraPositional = await runGate(["new-app", `${deploymentName}-extra`, "b"]);
  check("new-app with an extra positional exits non-zero", extraPositional.code === 0, false);
  check("new-app with an extra positional names the stray token", extraPositional.stdout.includes("unknown argument: b"), true);

  // The gate used to check the deployment exists before it ever looked at what command was
  // asked for, so `./clawwright help` in a completely fresh checkout (no apps/<name> yet — exactly
  // when someone reaches for help) failed with "deployment not found" instead of listing
  // commands. Deliberately never created, unlike deploymentName above.
  const neverCreated = `cli-help-check-missing-${randomBytes(4).toString("hex")}`;
  const helpBeforeSetup = await runGate(["--app", neverCreated, "help"]);
  check("./clawwright help works before any deployment exists", helpBeforeSetup.code, 0);
  check(
    "./clawwright help before setup still lists real commands",
    helpBeforeSetup.stdout.includes("bootstrap") && helpBeforeSetup.stdout.includes("Usage: ./clawwright <command>"),
    true,
  );

  const realCommandBeforeSetup = await runGate(["--app", neverCreated, "status"]);
  check(
    "a real command still refuses cleanly when there is truly no deployment",
    realCommandBeforeSetup.stdout.includes("not found") && realCommandBeforeSetup.code !== 0,
    true,
  );

  // Before this fix, this branch always ended in process.exit(0) regardless of what runApp()
  // reported — a typo'd sub-argument printed "unknown command" yet still exited success.
  const helpTypoBeforeSetup = await runGate(["--app", neverCreated, "help", "lsit"]);
  check("./clawwright help <typo> exits non-zero", helpTypoBeforeSetup.code === 0, false);
  check(
    "./clawwright help <typo> still names the unknown command",
    helpTypoBeforeSetup.stdout.includes("unknown command: lsit"),
    true,
  );
} finally {
  // dispose() retries through transient Windows handle errors and removes the whole root,
  // so this per-fixture rm is only defense in depth (a no-op once dispose succeeded).
  await childSource.dispose();
  await apps.dispose();
  await rm(resolve(apps.root, deploymentName), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

finish("cli-help");

// `./clawwright destroy` — dry run by default; a real run needs --yes AND --confirm-name,
// refuses an unsafe target shape or a symlinked target, and removes containers/network/
// volumes plus whichever of --data/--backups/--snapshots was asked for, in that order,
// under the REAL instance lock (guardedWith()/takeLock()) — the same shared fixture
// backup/prune-replaced.check.ts layers its own domain exec handling over, not a stand-in
// for the lock.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { NotBootstrapped } from "#framework/runtime/runtime.ts";
import { takeLock } from "#framework/runtime/lock/instance-lock.ts";
import { stubContext, refused } from "#checks/runtime/convergence/instance-lock/fixture.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecOptions, ExecResult } from "#framework/runtime/transport/transport.ts";
import { check, checkTrue, finish, requires } from "#checks/kit/harness.ts";
import { asDirectTest } from "#checks/runtime/service/restore/file-test-stub.ts";
import { SAFE_DESTROY_SCRIPT, NEVER_BOOTSTRAPPED, WOULD_REMOVE, DRY_RUN_NOTHING_TO_REMOVE, DRY_RUN_REAL_RUN_HINT, DESTROY_ARGUMENTS } from "#framework/commands/lifecycle/instance/destroy.ts";
import { SUDO_PASSWORD_REFUSAL } from "#framework/runtime/files/datadir.ts";
import { commandLine } from "#framework/core/io/invocation/render.ts";
import { humanSize } from "#framework/core/io/size.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { executeCommand } from "#framework/core/command/execute.ts";
import { ArgumentError, ruleText } from "#framework/core/command/index.ts";
import type { AppDefinition } from "#framework/core/app.ts";
import type { Transport } from "#framework/runtime/transport/transport.ts";

useDeployment("/srv/destroy-check-deployment");
const DEPLOYMENT_NAME = "destroy-check-deployment";

const DATA_DIR = "/srv/destroy-check/data";
const BACKUP_DIR = "/srv/destroy-check/backups";
const SNAPSHOT_DIR = "/srv/destroy-check/snapshots";

interface DestroyOptions {
  readonly inaccessible?: Set<string>;
  readonly failedTest?: boolean;
  readonly failedResolver?: boolean;
  readonly noReadlink?: boolean;
  readonly uid?: number;
  readonly unwritable?: Set<string>;
  readonly unsearchable?: Set<string>;
  readonly noSudo?: boolean;
  /** An external `test` that answers -w/-x "no" for everything, as uutils does for root on a
   *  directory owned by another uid; only the shell builtin (`sh -c`) follows the setup. */
  readonly externalTestDenies?: boolean;
  readonly afterStop?: () => void;
  readonly neverBootstrapped?: boolean;
}

/** Layers destroy's target-side checks over the real lock fixture. */
function destroyContext(
  present: string[] = [DATA_DIR, BACKUP_DIR, SNAPSHOT_DIR],
  symlinks: Set<string> = new Set(),
  canonicalPaths: Map<string, string> = new Map(),
  setup: DestroyOptions = {},
): { ctx: Context; dirs: Set<string>; order: string[] } {
  const { ctx: fixtureCtx, dirs } = stubContext();
  for (const dir of present) dirs.add(dir);
  const baseExec = fixtureCtx.transport.exec;
  const order: string[] = [];
  const transport: Context["transport"] = {
    ...fixtureCtx.transport,
    async exists(path: string): Promise<boolean> { return dirs.has(path); },
    async exec(rawCommand: string, rawArgs: string[], execOptions?: ExecOptions): Promise<ExecResult> {
      if (setup.externalTestDenies === true && rawCommand === "test" && (rawArgs[0] === "-w" || rawArgs[0] === "-x")) {
        return { code: 1, stdout: "", stderr: "" };
      }
      const { command, args } = asDirectTest(rawCommand, rawArgs);
      if (command === "id") return { code: 0, stdout: `${setup.uid ?? 1000}\n`, stderr: "" };
      if (command === "test" && args[0] === "-w") {
        return { code: setup.unwritable?.has(args[1] ?? "") ? 1 : 0, stdout: "", stderr: "" };
      }
      if (command === "test" && args[0] === "-x") {
        return { code: setup.unsearchable?.has(args[1] ?? "") ? 1 : 0, stdout: "", stderr: "" };
      }
      if (command === "sh" && args[0] === "-c" && args[1] === "command -v sudo") {
        return { code: 0, stdout: "/usr/bin/sudo\n", stderr: "" };
      }
      if (command === "sudo" && args.join(" ") === "-n true") {
        return { code: setup.noSudo ? 1 : 0, stdout: "", stderr: "" };
      }
      if ((command === "sh" && args[0] === "-s") || (command === "sudo" && args[0] === "-n" && args[1] === "sh" && args[2] === "-s")) {
        const elevated = command === "sudo";
        const path = args.at(-2) ?? "";
        const mode = args.at(-1) ?? "";
        const parent = path.slice(0, path.lastIndexOf("/")) || "/";
        order.push(`${elevated ? "sudo:" : "plain:"}${mode}:${path}`);
        check("destroy passes a fixed shell script through stdin", execOptions?.input, SAFE_DESTROY_SCRIPT);
        if (setup.noReadlink) return { code: 1, stdout: "", stderr: "readlink is unavailable" };
        if (setup.failedResolver) return { code: 1, stdout: "", stderr: "parent cannot be resolved" };
        if (setup.inaccessible?.has(parent)) return { code: 1, stdout: "", stderr: "parent cannot be entered" };
        if (canonicalPaths.has(path) || canonicalPaths.has(parent)) {
          return { code: 1, stdout: "", stderr: "parent resolves through a symlink" };
        }
        if ([...symlinks].some((entry) => path === entry || path.startsWith(`${entry}/`))) {
          return { code: 1, stdout: "", stderr: "target is a symlink" };
        }
        if (setup.failedTest) return { code: 2, stdout: "", stderr: "target link test failed" };
        if (mode === "remove" && dirs.has(path)) {
          order.push(`rm:${path}`);
          for (const dir of [...dirs].filter((entry) => entry === path || entry.startsWith(`${path}/`))) dirs.delete(dir);
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      // 5 GiB in KiB: the dry-run size goes through humanSize, not raw `du -sk` output.
      if (command === "du") return { code: 0, stdout: `5242880\t${args[args.length - 1]}`, stderr: "" };
      return baseExec(command, args, execOptions);
    },
  };
  const runtime = {
    async isRunning(): Promise<boolean> {
      if (setup.neverBootstrapped) throw new NotBootstrapped(DATA_DIR);
      return true;
    },
    async stop(extraArgs: string[] = []): Promise<void> { order.push(`stop:${extraArgs.join(",")}`); setup.afterStop?.(); },
    async showStatus(): Promise<void> { order.push("showStatus"); },
  };
  const ctx = {
    ...fixtureCtx,
    settings: { dataDir: DATA_DIR, backupDir: BACKUP_DIR, snapshotDir: SNAPSHOT_DIR, env: {} },
    transport,
    runtime,
  } as unknown as Context;
  return { ctx, dirs, order };
}

async function output(body: () => Promise<void>): Promise<string> {
  let captured = "";
  await withOutputSink((chunk) => { captured += chunk; }, body);
  return captured;
}

// --- dry run (default): prints the plan, removes nothing -----------------------------------

{
  const { ctx, dirs, order } = destroyContext();
  const text = await output(() => openclawCommands.destroy.run(ctx, ["--data", "--backups", "--snapshots"]));
  check("dry run leaves every target in place", [dirs.has(DATA_DIR), dirs.has(BACKUP_DIR), dirs.has(SNAPSHOT_DIR)], [true, true, true]);
  check("dry run never calls runtime.stop", order.some((entry) => entry.startsWith("stop:")), false);
  check("dry run still shows the containers plan", order.includes("showStatus"), true);
  check("dry run says so and names --yes/--confirm-name", text.includes(DRY_RUN_REAL_RUN_HINT), true);
  check("dry run names each target path", [DATA_DIR, BACKUP_DIR, SNAPSHOT_DIR].every((path) => text.includes(path)), true);
  check("dry run sizes read as human units, not raw KiB", text.includes(humanSize(5 * 1024 ** 3)), true);
  check("dry run never prints the raw du count", text.includes("5242880"), false);
}

{
  // No flags at all: still a dry run of the containers/network/volumes, nothing else.
  const { ctx, order } = destroyContext();
  await output(() => openclawCommands.destroy.run(ctx, []));
  check("no target flags still shows the containers-only plan", order, ["showStatus"]);
}

// --- --confirm-name: missing or wrong refuses a real run ------------------------------------

{
  const { ctx, dirs } = destroyContext();
  const message = await refused(() => openclawCommands.destroy.run(ctx, ["--data", "--yes"]));
  // The declared rule's voice, not a hand-written refusal: the same wording the parser
  // prints on every surface and `--help` lists as a rule.
  check("--yes with no --confirm-name is refused",
    message.includes(ruleText({ rule: "requires", name: "yes", with: ["confirm-name"] }, DESTROY_ARGUMENTS)), true);
  check("nothing was removed", dirs.has(DATA_DIR), true);
}

// Independent token expectation: single-word tokens, no counted prose pin.
const CONFIRM_NAME_MISMATCH = ["--confirm-name", "\"not-this-deployment\"", "does", "not", "match", "this", "deployment's", "name", "\"destroy-check-deployment\""];

{
  const { ctx, dirs } = destroyContext();
  const message = await refused(() => openclawCommands.destroy.run(ctx, ["--data", "--yes", "--confirm-name", "not-this-deployment"]));
  // token-pinned: the refusal text is the contract, not the product builder's echo
  check("a wrong --confirm-name is refused", CONFIRM_NAME_MISMATCH.every((token) => message.includes(token)), true);
  check("nothing was removed", dirs.has(DATA_DIR), true);
}

// --- path-shape guards: string-level, before anything reaches the transport -----------------

function shapeContext(dataDir: string): Context {
  return { settings: { dataDir, backupDir: BACKUP_DIR, snapshotDir: SNAPSHOT_DIR, env: {} } } as unknown as Context;
}

for (const [name, dataDir, expectedSubstring] of [
  ["/ itself", "/", "top-level directory"],
  ["a single-segment path", "/srv", "top-level directory"],
  ["a home-directory-shaped path", "/home/alice", "home directory"],
  ["a relative path", "srv/data", "not an absolute path"],
  ["parent traversal", "/srv/instance/../../home/alice", ".."],
  ["dot segment", "/srv/./data", ".."],
  ["repeated separators", "/srv//data", "normalized path"],
  ["mixed separators", "C:\\srv/data", "mixes path separators"],
] as const) {
  const message = await refused(() => openclawCommands.destroy.run(shapeContext(dataDir), ["--data"]));
  check(`refuses ${name}`, message.includes(expectedSubstring), true);
}

for (const [flag, envName, path] of [
  ["--backups", "OC_BACKUP_DIR", "/srv/instance/../../home/alice"],
  ["--snapshots", "OC_SNAPSHOT_DIR", "/srv/./snapshots"],
] as const) {
  const ctx = {
    settings: {
      dataDir: DATA_DIR,
      backupDir: envName === "OC_BACKUP_DIR" ? path : BACKUP_DIR,
      snapshotDir: envName === "OC_SNAPSHOT_DIR" ? path : SNAPSHOT_DIR,
      env: {},
    },
  } as unknown as Context;
  const message = await refused(() => openclawCommands.destroy.run(ctx, [flag]));
  check(`${envName} unsafe path is refused`, message.includes(envName), true);
}

// --- symlink guard: checked in dry run too, so the plan never promises what a real run
// --- would then refuse -----------------------------------------------------------------------

{
  const { ctx } = destroyContext([DATA_DIR], new Set([DATA_DIR]));
  const message = await refused(() => openclawCommands.destroy.run(ctx, ["--data"]));
  check("refuses a symlinked target, even in dry run", message.includes("symlink"), true);
}

{
  const linkedParent = "/srv/destroy-check/link/backups";
  const ctx = {
    settings: { dataDir: DATA_DIR, backupDir: linkedParent, snapshotDir: SNAPSHOT_DIR, env: {} },
  } as unknown as Context;
  const { ctx: transportCtx } = destroyContext([linkedParent], new Set(), new Map([[linkedParent, "/outside/backups"]]));
  const linkedCtx = { ...transportCtx, settings: ctx.settings } as Context;
  const message = await refused(() => openclawCommands.destroy.run(linkedCtx, ["--backups"]));
  check("refuses a path reached through a symlinked parent", message.includes("resolves through a symlink"), true); // the script's own diagnostic, quoted verbatim
}

// --- real run: removes exactly the flagged parts, in order, under the real lock -------------

{
  const { ctx, dirs, order } = destroyContext();
  await output(() => openclawCommands.destroy.run(ctx, ["--data", "--backups", "--snapshots", "--yes", "--confirm-name", DEPLOYMENT_NAME]));
  check(
    "stops containers first, then removes data, backups, snapshots in that order",
    order.filter((entry) => entry.startsWith("stop:") || entry.startsWith("rm:")),
    ["stop:-v", `rm:${DATA_DIR}`, `rm:${BACKUP_DIR}`, `rm:${SNAPSHOT_DIR}`],
  );
  check("each target has a preflight and a same-invocation removal", [DATA_DIR, BACKUP_DIR, SNAPSHOT_DIR].every((path) =>
    order.indexOf(`plain:verify:${path}`) < order.indexOf(`plain:remove:${path}`) &&
    order.indexOf(`plain:remove:${path}`) < order.indexOf(`rm:${path}`)), true);
  check("every flagged target is gone", [dirs.has(DATA_DIR), dirs.has(BACKUP_DIR), dirs.has(SNAPSHOT_DIR)], [false, false, false]);
}

for (const [name, setup, expected] of [
  ["inaccessible parent", { inaccessible: new Set(["/srv/destroy-check"]) }, "parent cannot be entered"],
  ["readlink unavailable", { noReadlink: true }, "readlink is unavailable"],
  ["resolver failure", { failedResolver: true }, "parent cannot be resolved"],
  ["test exit other than 0 or 1", { failedTest: true }, "target link test failed"],
] as const) {
  const { ctx, order, dirs } = destroyContext([DATA_DIR], new Set(), new Map(), setup);
  const message = await refused(() => openclawCommands.destroy.run(ctx, ["--data", "--yes", "--confirm-name", DEPLOYMENT_NAME]));
  check(`${name} refuses removal`, message.includes(expected), true);
  check(`${name} never reaches rm`, order.some((entry) => entry.startsWith("rm:")), false);
  check(`${name} preserves the target`, dirs.has(DATA_DIR), true);
}

{
  const { ctx, order } = destroyContext([BACKUP_DIR, SNAPSHOT_DIR], new Set(), new Map(), { uid: 1001, noSudo: true });
  await output(() => openclawCommands.destroy.run(ctx, ["--backups", "--snapshots"]));
  await output(() => openclawCommands.destroy.run(ctx, ["--backups", "--snapshots", "--yes", "--confirm-name", DEPLOYMENT_NAME]));
  check("a different uid can inspect and remove writable directories without sudo", order.filter((entry) => entry.includes(`:${BACKUP_DIR}`) || entry.includes(`:${SNAPSHOT_DIR}`)),
    [`plain:verify:${BACKUP_DIR}`, `plain:verify:${SNAPSHOT_DIR}`, `plain:verify:${BACKUP_DIR}`, `plain:verify:${SNAPSHOT_DIR}`, `plain:remove:${BACKUP_DIR}`, `rm:${BACKUP_DIR}`, `plain:remove:${SNAPSHOT_DIR}`, `rm:${SNAPSHOT_DIR}`]);
}

{
  // Root on a uutils host: the external test denies what the kernel allows. The access probes
  // ask the shell builtin, so nothing escalates (and with sudo refused, escalating would fail).
  const { ctx, order } = destroyContext([DATA_DIR], new Set(), new Map(), { uid: 0, externalTestDenies: true, noSudo: true });
  await output(() => openclawCommands.destroy.run(ctx, ["--data", "--yes", "--confirm-name", DEPLOYMENT_NAME]));
  check("an external test that denies root does not send destroy to sudo", order.filter((entry) => entry.includes(`:${DATA_DIR}`)),
    [`plain:verify:${DATA_DIR}`, `plain:remove:${DATA_DIR}`, `rm:${DATA_DIR}`]);
}

{
  const { ctx, order } = destroyContext([DATA_DIR], new Set(), new Map(), { uid: 1001, unwritable: new Set([DATA_DIR]) });
  await output(() => openclawCommands.destroy.run(ctx, ["--data", "--yes", "--confirm-name", DEPLOYMENT_NAME]));
  check("a protected target uses the same sudo prefix for verification and removal", order.filter((entry) => entry.includes(`:${DATA_DIR}`)),
    [`sudo:verify:${DATA_DIR}`, `sudo:remove:${DATA_DIR}`, `rm:${DATA_DIR}`]);
}

{
  const { ctx, order } = destroyContext([DATA_DIR, BACKUP_DIR], new Set(), new Map(), {
    uid: 1001, unwritable: new Set([DATA_DIR]),
  });
  await output(() => openclawCommands.destroy.run(ctx, ["--data", "--backups", "--yes", "--confirm-name", DEPLOYMENT_NAME]));
  check("mixed target permissions select separate prefixes", order.filter((entry) => entry.includes(`:${DATA_DIR}`) || entry.includes(`:${BACKUP_DIR}`)),
    [`sudo:verify:${DATA_DIR}`, `plain:verify:${BACKUP_DIR}`, `sudo:remove:${DATA_DIR}`, `rm:${DATA_DIR}`, `plain:remove:${BACKUP_DIR}`, `rm:${BACKUP_DIR}`]);
}

{
  const { ctx, order, dirs } = destroyContext([DATA_DIR], new Set(), new Map(), {
    uid: 1001, unwritable: new Set([DATA_DIR]), noSudo: true,
  });
  const message = await refused(() => openclawCommands.destroy.run(ctx, ["--data", "--yes", "--confirm-name", DEPLOYMENT_NAME]));
  check("a protected target without passwordless sudo is refused", message.includes(SUDO_PASSWORD_REFUSAL), true);
  check("a protected target without sudo is never verified or removed", order.some((entry) => entry.includes(`:${DATA_DIR}`)), false);
  check("a protected target without sudo preserves the target", dirs.has(DATA_DIR), true);
}

{
  const { ctx, order } = destroyContext([DATA_DIR], new Set(), new Map(), {
    uid: 1001, unsearchable: new Set(["/srv/destroy-check"]),
  });
  await output(() => openclawCommands.destroy.run(ctx, ["--data", "--yes", "--confirm-name", DEPLOYMENT_NAME]));
  check("an unsearchable parent uses sudo for both phases", order.filter((entry) => entry.includes(`:${DATA_DIR}`)),
    [`sudo:verify:${DATA_DIR}`, `sudo:remove:${DATA_DIR}`, `rm:${DATA_DIR}`]);
}

{
  const { ctx, order, dirs } = destroyContext([DATA_DIR], new Set(), new Map(), {
    uid: 1001, unsearchable: new Set(["/srv/destroy-check"]), noSudo: true,
  });
  const message = await refused(() => openclawCommands.destroy.run(ctx, ["--data", "--yes", "--confirm-name", DEPLOYMENT_NAME]));
  check("a protected parent without passwordless sudo is refused", message.includes(SUDO_PASSWORD_REFUSAL), true);
  check("a protected parent without sudo is never verified or removed", order.some((entry) => entry.includes(`:${DATA_DIR}`)), false);
  check("a protected parent without sudo preserves the target", dirs.has(DATA_DIR), true);
}

{
  const links = new Set<string>();
  const { ctx, dirs, order } = destroyContext([DATA_DIR], links, new Map(), { afterStop: () => { links.add("/srv/destroy-check"); } });
  const message = await refused(() => openclawCommands.destroy.run(ctx, ["--data", "--yes", "--confirm-name", DEPLOYMENT_NAME]));
  check("symlink introduced after preflight is refused", message.includes("symlink"), true);
  check("symlink introduced after preflight never reaches rm", order.some((entry) => entry.startsWith("rm:")), false);
  check("symlink introduced after preflight preserves target", dirs.has(DATA_DIR), true);
}

await requires("linux-host", "the target-side safe-destroy script against a real POSIX tree", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "clawwright-destroy-check-"));
  const root = realpathSync(temporary);
  try {
    const safe = join(root, "safe");
    const outside = join(root, "outside");
    mkdirSync(safe);
    mkdirSync(outside);
    const target = join(safe, "data");
    mkdirSync(target);
    writeFileSync(join(outside, "keep"), "keep");
    const run = (path: string, mode: "verify" | "remove") => spawnSync("sh", ["-s", "--", path, mode], {
      input: SAFE_DESTROY_SCRIPT,
      encoding: "utf8",
    });
    check("target-side script verifies a real directory", run(target, "verify").status, 0);
    symlinkSync(outside, join(safe, "link"));
    check("target-side script rejects a symlinked ancestor", run(join(safe, "link", "keep"), "remove").status === 0, false);
    check("symlinked ancestor leaves external file untouched", existsSync(join(outside, "keep")), true);
    check("target-side script rejects a missing parent", run(join(root, "absent", "data"), "remove").status === 0, false);
    const racing = join(root, "racing");
    const moved = join(root, "racing-moved");
    const wrapperDir = join(root, "bin");
    mkdirSync(racing);
    mkdirSync(join(racing, "data"));
    mkdirSync(join(outside, "data"));
    mkdirSync(wrapperDir);
    const wrapper = join(wrapperDir, "readlink");
    writeFileSync(wrapper, [
      "#!/bin/sh",
      '"$REAL_READLINK" "$@" || exit $?',
      'if [ "$3" = "$RACE_PARENT" ]; then',
      '  mv -- "$RACE_PARENT" "$RACE_MOVED" || exit',
      '  ln -s -- "$RACE_OUTSIDE" "$RACE_PARENT" || exit',
      "fi",
    ].join("\n"));
    chmodSync(wrapper, 0o700);
    const raced = spawnSync("sh", ["-s", "--", join(racing, "data"), "remove"], {
      input: SAFE_DESTROY_SCRIPT,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${wrapperDir}:${process.env.PATH ?? ""}`,
        REAL_READLINK: "/usr/bin/readlink",
        RACE_PARENT: racing,
        RACE_MOVED: moved,
        RACE_OUTSIDE: outside,
      },
    });
    check("parent replacement inside the removal call is refused", raced.status === 0, false);
    check("parent replacement leaves the original target", existsSync(join(moved, "data")), true);
    check("parent replacement leaves the symlink destination", existsSync(join(outside, "data")), true);
    check("target-side script removes only its verified sibling", run(target, "remove").status, 0);
    check("external sibling survives target-side deletion", existsSync(join(outside, "keep")), true);
    check("verified sibling was removed", existsSync(target), false);
  } finally {
    const resolved = resolve(root);
    if (resolved.startsWith(`${resolve(tmpdir())}${sep}`) && resolved.includes("clawwright-destroy-check-")) {
      rmSync(resolved, { recursive: true, force: true });
    }
  }
});

{
  // Only --data: backups/snapshots are never touched.
  const { ctx, dirs, order } = destroyContext();
  await output(() => openclawCommands.destroy.run(ctx, ["--data", "--yes", "--confirm-name", DEPLOYMENT_NAME]));
  check(
    "only the requested target is removed",
    order.filter((entry) => entry.startsWith("stop:") || entry.startsWith("rm:")),
    ["stop:-v", `rm:${DATA_DIR}`],
  );
  check("the others are left alone", [dirs.has(BACKUP_DIR), dirs.has(SNAPSHOT_DIR)], [true, true]);
}

// --- takes the instance lock: refused while another operation already holds it --------------

{
  const { ctx, dirs } = destroyContext();
  const held = await takeLock(ctx, "unrelated", "op-holder");
  try {
    const message = await refused(() => openclawCommands.destroy.run(ctx, ["--data", "--yes", "--confirm-name", DEPLOYMENT_NAME]));
    check("a real run refuses while another operation holds the lock", message.includes(commandLine(["operations", "op-holder"])), true);
  } finally {
    await held.release();
  }
  check("nothing was removed while refused", dirs.has(DATA_DIR), true);
}

// --- never bootstrapped: nothing to destroy, exit 0, no lock home created --------------------

{
  const { ctx, dirs, order } = destroyContext([], new Set(), new Map(), { neverBootstrapped: true });
  const text = await output(() => openclawCommands.destroy.run(ctx, ["--data"]));
  check("never bootstrapped dry run says nothing to destroy", text.includes(NEVER_BOOTSTRAPPED) && text.includes(DRY_RUN_NOTHING_TO_REMOVE), true);
  check("never bootstrapped dry run does not show a container plan", order.includes("showStatus"), false);
  check("never bootstrapped dry run creates nothing", [...dirs], []);
}

{
  const { ctx, dirs, order } = destroyContext([], new Set(), new Map(), { neverBootstrapped: true });
  const text = await output(() => openclawCommands.destroy.run(ctx, ["--data", "--yes", "--confirm-name", DEPLOYMENT_NAME]));
  check("never bootstrapped real run says nothing to destroy", text.includes(NEVER_BOOTSTRAPPED), true);
  check("never bootstrapped real run stops and removes nothing", order.filter((e) => e.startsWith("stop:") || e.startsWith("rm:")), []);
  check("never bootstrapped real run creates no lock directory", [...dirs], []);
}

{
  const message = await refused(async () => {
    const { ctx } = destroyContext([], new Set(), new Map(), { neverBootstrapped: true });
    await openclawCommands.destroy.run(ctx, ["--yes", "--confirm-name", "not-this-deployment"]);
  });
  check("never bootstrapped still needs the right --confirm-name", CONFIRM_NAME_MISMATCH.every((token) => message.includes(token)), true);
}

{
  // --backups/--snapshots are independent directories and still go when present.
  const { ctx, dirs, order } = destroyContext([BACKUP_DIR], new Set(), new Map(), { neverBootstrapped: true });
  const text = await output(() => openclawCommands.destroy.run(ctx, ["--backups", "--snapshots"]));
  check("never bootstrapped dry run names the present backup dir", text.includes(BACKUP_DIR), true);
  await output(() => openclawCommands.destroy.run(ctx, ["--backups", "--snapshots", "--yes", "--confirm-name", DEPLOYMENT_NAME]));
  check("never bootstrapped real run removes the present backup dir only", order.filter((e) => e.startsWith("rm:")), [`rm:${BACKUP_DIR}`]);
  check("never bootstrapped removal leaves no lock directory behind", [...dirs], []);
}

// --- dry run on absent directories: no privilege probe, no "for a real run" ----------------

{
  // Password-gated sudo, parent not enterable: the old dry run died on /srv for absent dirs.
  const { ctx, order } = destroyContext([], new Set(), new Map(), {
    uid: 1001, noSudo: true, neverBootstrapped: true,
    unwritable: new Set(["/srv/destroy-check"]), unsearchable: new Set(["/srv/destroy-check"]),
  });
  const text = await output(() => openclawCommands.destroy.run(ctx, ["--backups", "--snapshots"]));
  check("absent dry run needs no sudo and runs no target script", order, []);
  check("absent dry run reports the directories absent", text.includes(`${BACKUP_DIR}`) && text.includes("absent"), true);
  check("absent dry run says there is nothing to remove", text.includes(DRY_RUN_NOTHING_TO_REMOVE), true);
  check("absent directories are not listed as 'would remove'", text.includes(WOULD_REMOVE), false);
  check("absent dry run does not invite a real run", text.includes("--yes") || text.includes(DRY_RUN_REAL_RUN_HINT), false);
}

{
  // A present target is still verified, and the real-run invitation stays.
  const { ctx, order } = destroyContext([BACKUP_DIR], new Set(), new Map(), { uid: 1001, noSudo: true, neverBootstrapped: true });
  const text = await output(() => openclawCommands.destroy.run(ctx, ["--backups", "--snapshots"]));
  check("present target is still verified in the dry run", order, [`plain:verify:${BACKUP_DIR}`]);
  check("present target keeps the real-run hint", text.includes(DRY_RUN_REAL_RUN_HINT), true);
}

// --- --yes + --confirm-name is refused before any contact or the lock -----------------------
// Presence is the declared rule, refused at parse; the value match needs only the arguments
// and the local deployment name, so it refuses at the prepare stage — executeCommand with a
// recording transport proves no target is ever reached.

{
  const app: AppDefinition = { name: "destroy-fixture", description: "fixture", commands: { destroy: openclawCommands.destroy } };
  const contacts: string[] = [];
  const transport = {
    description: "stub",
    exec(...rest: unknown[]): never { contacts.push(String(rest[0])); throw new Error("unreachable"); },
    exists(): never { contacts.push("exists"); throw new Error("unreachable"); },
    readFile(): never { contacts.push("readFile"); throw new Error("unreachable"); },
  } as unknown as Transport;

  for (const [label, argv, stage, argument, messagePart] of [
    // A rule refusal names the rule's own argument (--yes); the value refusal names --confirm-name.
    ["a missing --confirm-name", ["--data", "--yes"], "parse", "yes",
      ruleText({ rule: "requires", name: "yes", with: ["confirm-name"] }, DESTROY_ARGUMENTS)],
    ["a wrong --confirm-name", ["--data", "--yes", "--confirm-name", "not-this-deployment"], "prepare", "confirm-name", "does not match"],
  ] as const) {
    const execution = await executeCommand(app, "destroy", { kind: "argv", argv: [...argv] }, { surface: "terminal", transport });
    check(`${label} stops at the ${stage} stage`, execution.stage, stage);
    checkTrue(`${label} is an ArgumentError naming the argument`, execution.error instanceof ArgumentError
      && (execution.error as ArgumentError).argument === argument);
    checkTrue(`${label} keeps the declared refusal text`, (execution.error as Error).message.includes(messagePart));
    check(`${label} never contacts the target`, contacts, []);
    contacts.length = 0;
  }
}


finish("destroy");

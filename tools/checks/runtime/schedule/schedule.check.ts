// commands/operate/schedule.ts — the scheduling machinery `watch install` and
// `backup install` both build on: the pure builders (marker, cron/schtasks encoding,
// interval parsing, which transports are schedulable) and the Windows fallback's own
// apply path, proven here against a recording transport that never touches a real
// scheduled task (see schedule.ts's own withScheduleRunner).

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CMD_EXE_ONLY_NOTE,
  CMD_EXE_UNSAFE_NOTE,
  CRONTAB_ENTRY_ONE_LINE,
  CRONTAB_ENTRY_OWNED,
  MANUAL_INSTALL_HEADER,
  NO_FAITHFUL_ENCODING,
  PERCENT_REFUSAL,
  REFUSING_APPLY,
  cronLine,
  cronSchedule,
  displayCommandLine,
  jobMarker,
  parseIntervalToMinutes,
  posixTargetInvocation,
  printSchedulingInstructions,
  readCrontab,
  updateCrontab,
  schedulingSupport,
  schtasksCreateCommand,
  schtasksDeleteCommand,
  schtasksSchedule,
  SCHTASKS_RUN_LIMIT,
  withoutMarkedLine,
  withScheduleRunner,
} from "#framework/commands/operate/schedule.ts";
import { INTERVAL_GRAMMAR, NEAREST_VALID } from "#framework/core/values/durations.ts";
import { deploymentName, useDeployment } from "#framework/runtime/deployment.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { shellQuote } from "#framework/core/io/shell.ts";
import { WslTransport } from "#framework/runtime/transport/wsl.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import { cmdExeArgv } from "#checks/runtime/schedule/fixture.ts";
import { check, finish, requires } from "#checks/kit/harness.ts";

async function deathOf(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}


check(
  "withoutMarkedLine drops only the named job's marked line for the named deployment",
  withoutMarkedLine(
    `0 3 * * * /usr/bin/other.sh\n${cronLine(5, { cwd: "/x", command: "./clawwright", args: ["watch", "check"] }, "watch", "myapp")}\n${cronLine(1440, { cwd: "/x", command: "./clawwright", args: ["backup"] }, "backup", "myapp")}\n`,
    "backup",
    "myapp",
  ),
  ["0 3 * * * /usr/bin/other.sh", cronLine(5, { cwd: "/x", command: "./clawwright", args: ["watch", "check"] }, "watch", "myapp")],
);

const owned = cronLine(5, { cwd: "/x", command: "./clawwright", args: ["watch", "check"] }, "watch", "myapp");
const foreign = [
  `# note: ${jobMarker("watch", "myapp")}`,
  `*/5 * * * * echo '${jobMarker("watch", "myapp")}'`,
  `${owned} extra`,
  owned.replace("'watch' 'check'", "'backup'"),
  owned.replace("# clawwright-watch:myapp", "# clawwright-watch:myapp-extra"),
  "",
  "  ",
];
check("only an exact generated entry is removed; foreign rows and blank lines survive", withoutMarkedLine(`${foreign.join("\n")}\n${owned}\n`, "watch", "myapp"), foreign);
const quoted = cronLine(5, { cwd: "/owner's app", command: "./clawwright", args: ["--app", "myapp", "watch", "check"] }, "watch", "myapp");
check("an owned line with a quoted path and explicit deployment is removed", withoutMarkedLine(`${quoted}\n`, "watch", "myapp"), []);

for (const path of ["/srv/project%blue", "/srv/project\\%blue", "/srv/project\\\\%blue"]) {
  check("percent paths are refused even with a preceding backslash", (await deathOf(() => cronLine(5, { cwd: path, command: "./clawwright", args: ["watch", "check"] }, "watch", "myapp"))).includes(PERCENT_REFUSAL), true);
  const legacy = owned.replace("'/x'", shellQuote(path));
  check("unsupported legacy percent rows are preserved", withoutMarkedLine(`${legacy}\n`, "watch", "myapp"), [legacy]);
}
for (const invocation of [
  { cwd: "/x", command: "./clawwright%", args: ["watch", "check"] },
  { cwd: "/x", command: "./clawwright", args: ["watch", "%"] },
]) {
  check("percent in commands or arguments is refused", (await deathOf(() => cronLine(5, invocation, "watch", "myapp"))).includes(PERCENT_REFUSAL), true);
}
check("percent in markers is refused", (await deathOf(() => cronLine(5, { cwd: "/x", command: "./clawwright", args: ["backup"] }, "backup", "my%app"))).includes(PERCENT_REFUSAL), true);

// --- cronSchedule(): only true divisors of 60 (minutes) or 24 (hours) fire evenly — shared
// by both jobs, and by schtasksSchedule()'s own range check ---------------------------------

for (const [minutes, expected] of [
  [15, "*/15 * * * *"],
  [30, "*/30 * * * *"],
  [60, "0 * * * *"],
  [120, "0 */2 * * *"],
  [360, "0 */6 * * *"],
  [1440, "0 0 * * *"],
] as const) {
  check(`cronSchedule(${minutes})`, cronSchedule(minutes), expected);
}
// 45m/7h/5h would fire unevenly (*/45, */7) — refused despite passing the old "multiple of 60"
// check; 25/90/300/420 are likewise non-divisors of 60 or 24.
for (const invalid of [7, 25, 45, 59, 90, 300, 420]) {
  check(`cronSchedule(${invalid}) refuses (no even-firing encoding)`, await deathOf(() => cronSchedule(invalid)) !== "", true);
}

check("cronLine carries the job's own marker, not another job's", cronLine(5, { cwd: "/x", command: "./clawwright", args: ["backup"] }, "backup", "myapp").endsWith(jobMarker("backup", "myapp")), true);

// --- parseIntervalToMinutes(): backup's own duration-string convention, funneled through
// cronSchedule so it can never accept an interval the cron line itself would then refuse ----

check("30m -> 30 minutes", parseIntervalToMinutes("30m"), 30);
check("6h -> 360 minutes", parseIntervalToMinutes("6h"), 360);
check("12h -> 720 minutes", parseIntervalToMinutes("12h"), 720);
check("1d -> 1440 minutes", parseIntervalToMinutes("1d"), 1440);
check("a bare number is minutes (watch's historical form)", [parseIntervalToMinutes("30"), parseIntervalToMinutes("120"), parseIntervalToMinutes("1440")], [30, 120, 1440]);
check("60m and 1h are the same interval", [parseIntervalToMinutes("60m"), parseIntervalToMinutes("1h")], [60, 60]);
// backup install passes { bareMinutes: false }: a cadence that stops the gateway must carry a unit.
check("a bare number is refused when bare minutes are disallowed, naming valid explicit spellings", (await deathOf(() => parseIntervalToMinutes("6", { bareMinutes: false }))).includes(`${NEAREST_VALID}6m`), true);
check("an explicit unit is still accepted when bare minutes are disallowed", [parseIntervalToMinutes("6m", { bareMinutes: false }), parseIntervalToMinutes("6h", { bareMinutes: false })], [6, 360]);
check("an empty value is refused even when bare minutes are allowed", (await deathOf(() => parseIntervalToMinutes(""))).includes(INTERVAL_GRAMMAR), true);
for (const malformed of ["", "abc", "1.5h", "-5", "5 m", "10mm"]) {
  check(`"${malformed}" is refused, naming both spellings`, (await deathOf(() => parseIntervalToMinutes(malformed))).includes(INTERVAL_GRAMMAR), true);
}
check("5h has no faithful cron encoding and is refused", (await deathOf(() => parseIntervalToMinutes("5h"))).includes(NO_FAITHFUL_ENCODING), true);
check("7h has no faithful cron encoding and is refused", (await deathOf(() => parseIntervalToMinutes("7h"))).includes(NO_FAITHFUL_ENCODING), true);
check("the refusal names the nearest valid values in the flag's own spelling", (await deathOf(() => parseIntervalToMinutes("7h"))).includes(`${NEAREST_VALID}6h, 8h`), true);

// Every refusal's "nearest valid" list is non-empty and each entry parses back through the
// same parser — it never offers a value the command itself would reject.
for (const refused of ["10h", "45m", "45", "90", "1441", "7", "0", "2d", "100d"]) {
  const message = await deathOf(() => parseIntervalToMinutes(refused));
  const offered = /nearest valid: (.*)$/.exec(message)?.[1]?.split(", ") ?? [];
  check(`${refused}: a non-empty nearest list`, offered.length > 0, true);
  for (const value of offered) {
    check(`${refused}: suggested ${value} is accepted`, await deathOf(() => parseIntervalToMinutes(value)), "");
    // The grammar's own reading, not the suggester's: a faithful cron cadence divides 60 minutes or one day.
    const minutes = parseIntervalToMinutes(value);
    check(`${refused}: suggested ${value} divides an hour or a day`, minutes < 60 ? 60 % minutes === 0 : 1440 % minutes === 0 && minutes % 60 === 0, true);
  }
}

// Both commands' refusals for the report's values: every suggestion in the message is itself
// accepted by the same command (backup: explicit unit only; 1440 minutes reads as 1d).
for (const bare of [true, false]) {
  const options = bare ? undefined : { bareMinutes: false };
  const label = bare ? "watch" : "backup";
  for (const value of ["1440", "90", "0", "7h", "45m"]) {
    const accepted = value === "1440" && bare; // only watch accepts bare minutes, and 1440 = 1d is valid
    const message = await deathOf(() => parseIntervalToMinutes(value, options));
    const offered = /nearest valid: (.*)$/.exec(message.replace(/; a bare number.*$/, ""))?.[1]?.split(", ") ?? [];
    check(`${label} ${value}: ${accepted ? "accepted" : "a non-empty nearest list"}`, accepted ? message : offered.length > 0, accepted ? "" : true);
    for (const suggestion of offered) {
      check(`${label} ${value}: suggested ${suggestion} is accepted`, await deathOf(() => parseIntervalToMinutes(suggestion, options)), "");
    }
  }
}

// --- schedulingSupport(): a property of the transport, checked against THIS platform's own
// POSIX-ness for the "local" branch so the assertion holds on every CI runner ----------------

function ctxWith(description: string): Context {
  return { transport: { description }, settings: { remotePath: "/opt/openclaw" } } as unknown as Context;
}

check("ssh is schedulable", schedulingSupport(ctxWith("ssh:user@host")).supported, true);
check("a WSL target is not", schedulingSupport(ctxWith("wsl:Ubuntu-24.04")).supported, false);
check("local reflects whether THIS platform is POSIX", schedulingSupport(ctxWith("local")).supported, process.platform !== "win32");

// --- schtasksSchedule()/schtasksCreateCommand()/schtasksDeleteCommand(): the pure Windows
// builders, exercised regardless of the host this check itself runs on ----------------------

check("a sub-hour interval steps schtasks' own MINUTE schedule", schtasksSchedule(30), { sc: "MINUTE", mo: "30" });
check("an hour-multiple interval steps HOURLY", schtasksSchedule(360), { sc: "HOURLY", mo: "6" });
check("exactly a day steps DAILY, with no /mo", schtasksSchedule(1440), { sc: "DAILY" });

// schtasks parity: same accept/refuse verdict as cronSchedule for every value in the table
// above, since schtasksSchedule() validates by calling cronSchedule() itself, not a copy.
for (const minutes of [15, 30, 60, 120, 360, 1440]) {
  check(`schtasksSchedule(${minutes}) accepts what cronSchedule accepts`, await deathOf(() => schtasksSchedule(minutes)), "");
}
for (const minutes of [7, 25, 45, 59, 90, 300, 420]) {
  check(`schtasksSchedule(${minutes}) refuses whatever cronSchedule refuses`, await deathOf(() => schtasksSchedule(minutes)) !== "", true);
}

{
  const create = schtasksCreateCommand("clawwright-myapp-backup", 1440, { command: "node.exe", args: ["C:\\tools\\clawwright.ts", "--app", "myapp", "backup"] });
  check("schtasksCreateCommand builds /create with the task name, schedule and a quoted /tr", create, {
    command: "schtasks",
    args: ["/create", "/tn", "clawwright-myapp-backup", "/sc", "DAILY", "/tr", displayCommandLine("node.exe", ["C:\\tools\\clawwright.ts", "--app", "myapp", "backup"]), "/f"],
  });
  check("...and /f, so a re-run replaces the same task instead of refusing", create.args.includes("/f"), true);
}
check("schtasksDeleteCommand names the task and forces it", schtasksDeleteCommand("clawwright-myapp-backup"), { command: "schtasks", args: ["/delete", "/tn", "clawwright-myapp-backup", "/f"] });

{
  const path = "/mnt/c/team's app/clawwright";
  const args = ["backup", "a b", "it's", "$(touch injected)", "a; false"];
  const invocation = new WslTransport("test-distro").clientInvocation(path, args);
  check("WSL scheduled invocation keeps shell syntax in one quoted argument", invocation, {
    command: "wsl.exe",
    args: [
      "-d", "test-distro", "--exec", "bash", "-lc",
      `set -e; cd -- ${shellQuote("/mnt/c/team's app")}; exec ${[shellQuote("./clawwright"), ...args.map(shellQuote)].join(" ")}`,
    ],
  });
  check("...with no cmd.exe operator outside its quotes", invocation.args.at(-1)?.includes("&"), false);
}

// Read failures may only become an empty table when cron explicitly says there is none.
{
  const listing = async (code: number, stdout: string, stderr: string) => {
    let env: Record<string, string> | undefined;
    const ctx = {
      transport: {
        description: "ssh:user@host",
        async exec(_command: string, _args: string[], options?: { env?: Record<string, string> }) {
          env = options?.env;
          return { code, stdout, stderr };
        },
      },
    } as unknown as Context;
    const error = await deathOf(() => readCrontab(ctx));
    return { error, env };
  };
  const empty = await listing(1, "", "no crontab for user");
  check("the known no-crontab diagnostic means an empty table", empty.error, "");
  check("crontab diagnostics use the stable C locale", empty.env, { LC_ALL: "C" });
  const denied = await listing(1, "", "permission denied");
  // Independent token expectation: single-word tokens, no counted prose pin.
  const READ_FAILURE_EXIT_1 = ["could", "not", "read", "crontab", "on", "ssh:user@host", "(exit", "1);", "table", "unchanged"];
  check("an unreadable crontab is surfaced instead of treated as empty", READ_FAILURE_EXIT_1.every((token) => denied.error.includes(token)), true);
  // Independent token expectation: single-word tokens, no counted prose pin.
  const READ_FAILURE_EXIT_255 = ["could", "not", "read", "crontab", "on", "ssh:user@host", "(exit", "255);", "table", "unchanged"];
  const transportFailure = await listing(255, "", "connection lost");
  check("a transport failure is surfaced instead of treated as empty", READ_FAILURE_EXIT_255.every((token) => transportFailure.error.includes(token)), true);
  const privateListing = await listing(1, "SCHEDULER_PRIVATE_FIXTURE", "");
  check("failed partial listings are never echoed", privateListing.error.includes("SCHEDULER_PRIVATE_FIXTURE"), false);
  const partialEmpty = await listing(1, "SCHEDULER_PRIVATE_FIXTURE", "no crontab for user");
  check("partial stdout prevents a contradictory empty-table result", READ_FAILURE_EXIT_1.every((token) => partialEmpty.error.includes(token)), true);
  check("contradictory empty-table diagnostics never echo private content", partialEmpty.error.includes("SCHEDULER_PRIVATE_FIXTURE"), false);
}

{
  let calls = 0;
  let answer = { code: 0, stdout: "updated\n", stderr: "" };
  const ctx = {
    transport: {
      description: "ssh:user@host",
      async exec() { calls += 1; return answer; },
    },
  } as unknown as Context;
  const wrongJob = cronLine(5, { cwd: "/x", command: "./clawwright", args: ["backup"] }, "backup", "myapp");
  check("an install cannot insert another job's entry", (await deathOf(() => updateCrontab(ctx, "watch", "myapp", wrongJob))).includes(CRONTAB_ENTRY_OWNED), true);
  check("multiline input is refused before target execution", (await deathOf(() => updateCrontab(ctx, "watch", "myapp", `${owned}\nforeign`))).includes(CRONTAB_ENTRY_ONE_LINE), true);
  check("invalid entries never reach the target", calls, 0);
  answer = { code: 26, stdout: "", stderr: "could not acquire scheduler account lock" };
  // Independent token expectation: single-word tokens, no counted prose pin.
  const LOCK_REFUSAL = ["could", "not", "update", "crontab", "on", "ssh:user@host", "(exit", "26):", "could", "not", "acquire", "scheduler", "account", "lock", "within", "30", "seconds;", "retry", "after", "the", "other", "update", "finishes"];
  const lockRefusal = await deathOf(() => updateCrontab(ctx, "watch", "myapp", owned));
  check("account lock refusal reaches the operator", LOCK_REFUSAL.every((token) => lockRefusal.includes(token)), true);
  // Refusal text per exit code, pinned independently of the product's table.
  const UPDATE_REFUSALS: Record<number, readonly string[]> = {
    28: ["could", "not", "read", "crontab;", "table", "unchanged"],
    33: ["could", "not", "update", "crontab"],
    255: ["target", "scheduler", "transaction", "failed"],
  };
  for (const code of [28, 33, 255]) {
    answer = { code, stdout: "SCHEDULER_PRIVATE_FIXTURE", stderr: "SCHEDULER_PRIVATE_FIXTURE" };
    const error = await deathOf(() => updateCrontab(ctx, "watch", "myapp", owned));
    check("scheduler failure never echoes target stdout/stderr", error.includes("SCHEDULER_PRIVATE_FIXTURE"), false);
    const tokens = ["could", "not", "update", "crontab", "on", "ssh:user@host", "(exit", `${code}):`, ...UPDATE_REFUSALS[code]!];
    check("scheduler failure keeps its exit code", tokens.every((token) => error.includes(token)), true);
  }
  answer = { code: 0, stdout: "unexpected output", stderr: "" };
  // Independent token expectation: single-word tokens, no counted prose pin.
  const CONFIRM_REFUSAL = ["could", "not", "confirm", "crontab", "update", "on", "ssh:user@host:", "unexpected", "transaction", "response"];
  const confirmRefusal = await deathOf(() => updateCrontab(ctx, "watch", "myapp", owned));
  check("success requires transaction confirmation", CONFIRM_REFUSAL.every((token) => confirmRefusal.includes(token)), true);
}


// --- posixTargetInvocation(): ssh vs. a monorepo checkout vs. an installed shim -------------

const root = await mkdtemp(join(tmpdir(), "clawwright-schedule-check-"));
useDeployment(root);
const name = deploymentName();

try {
  const sshCtx = { transport: { description: "ssh:user@host" }, settings: { remotePath: "/opt/openclaw" } } as unknown as Context;
  const sshInvocation = await posixTargetInvocation(sshCtx, ["backup"]);
  check("ssh runs from the mirrored remote path, with --app", sshInvocation, { cwd: "/opt/openclaw", command: "./clawwright", args: ["--app", name, "backup"] });

  const localCtx = { transport: { description: "local" }, settings: {} } as unknown as Context;
  const localInvocation = await posixTargetInvocation(localCtx, ["backup"]);
  check("a monorepo checkout (no installed shim here) still names --app explicitly", localInvocation.args, ["--app", name, "backup"]);

  // --- printSchedulingInstructions(): the Windows apply path, through the recording
  // transport only — this must never spawn a real schtasks.exe --------------------------

  const wslCtx = {
    transport: { description: "wsl:Ubuntu-24.04", clientInvocation: (entry: string, args: string[]) => ({ command: "wsl.exe", args: [entry, ...args] }) },
    paths: { async toTarget(path: string): Promise<string> { return path; } },
    settings: {},
  } as unknown as Context;

  const printed: string[] = [];
  await withOutputSink((chunk) => printed.push(chunk), () => printSchedulingInstructions(wslCtx, "backup", name, 1440, ["backup"], false));
  check("printing without --apply names the manual command, on every platform", printed.join("").includes(MANUAL_INSTALL_HEADER), true);

  await requires("windows-host", "--apply on an actual Windows host drives schtasks through the recording transport", async () => {
    check("...and shows the schtasks command on an actual Windows host", printed.join("").includes("schtasks"), true);

    const recorded: { command: string; args: string[] }[] = [];
    await withOutputSink(() => {}, () =>
      withScheduleRunner(
        async (command, args) => {
          recorded.push({ command, args: [...args] });
          return { code: 0, stdout: "", stderr: "" };
        },
        () => printSchedulingInstructions(wslCtx, "backup", name, 1440, ["backup"], true),
      ));
    check("--apply on Windows runs schtasks through the recording transport, never a real one", recorded.length, 1);
    check("...via the wsl.exe line for a wsl: target, not a re-derived node invocation", recorded[0]?.args.some((arg) => arg.includes("wsl.exe")), true);

    const failing: { command: string; args: string[] }[] = [];
    const message = await deathOf(() =>
      withOutputSink(() => {}, () =>
        withScheduleRunner(
          async (command, args) => {
            failing.push({ command, args: [...args] });
            return { code: 1, stdout: "", stderr: "access denied" };
          },
          () => printSchedulingInstructions(wslCtx, "backup", name, 1440, ["backup"], true),
        )));
    check("a failing schtasks call is reported, not swallowed", message.includes("access denied"), true);
  });
  await requires("posix-host", "--apply on a non-Windows host refuses outright — no scheduler here to drive", async () => {
    const message = await deathOf(() => withOutputSink(() => {}, () => printSchedulingInstructions(wslCtx, "backup", name, 1440, ["backup"], true)));
    check("--apply on a non-Windows host refuses outright — no scheduler here to drive", message.includes(REFUSING_APPLY), true);
  });

  // The printed schtasks line, parsed the way cmd.exe + CommandLineToArgvW would, is exactly
  // what --apply passes as argv — on any host (the platform is forced).
  for (const [entryPath, pasteable] of [["/mnt/d/team's app/clawwright", true], ["/mnt/d/50%/clawwright", false], ["/mnt/d/a&b/clawwright", false]] as const) {
    const realWsl = new WslTransport("Ubuntu-24.04");
    const realCtx = {
      transport: { description: "wsl:Ubuntu-24.04", clientInvocation: realWsl.clientInvocation.bind(realWsl) },
      paths: { async toTarget(): Promise<string> { return entryPath; } },
      settings: {},
    } as unknown as Context;
    const applied: string[][] = [];
    const out: string[] = [];
    await withOutputSink((chunk) => out.push(chunk), () =>
      withScheduleRunner(
        async (_command, args) => { applied.push([...args]); return { code: 0, stdout: "", stderr: "" }; },
        () => printSchedulingInstructions(realCtx, "backup", name, 1440, ["backup"], true),
        "win32",
      ));
    const line = out.join("").split("\n").find((row) => row.trimStart().startsWith("schtasks "));
    check(`${entryPath}: --apply still runs schtasks`, applied.length, 1);
    if (pasteable) {
      check(`${entryPath}: the /tr is bash with no && or cmd.exe operator`, applied[0]?.[applied[0].indexOf("/tr") + 1]?.includes("&"), false);
      check(`${entryPath}: the printed line, parsed by cmd.exe, is the --apply argv`, cmdExeArgv(line?.trim() ?? ""), ["schtasks", ...(applied[0] ?? [])]);
      check(`${entryPath}: the line is labelled for cmd.exe`, out.join("").includes(CMD_EXE_ONLY_NOTE), true);
    } else {
      check(`${entryPath}: a path cmd.exe cannot carry gets no pasteable line, only --apply`, [line, out.join("").includes(CMD_EXE_UNSAFE_NOTE)], [undefined, true]);
    }
  }

  // schtasks rejects a /tr over 261 characters: refuse with advice, print and create nothing.
  {
    const realWsl = new WslTransport("Ubuntu-24.04");
    const longCtx = (entryPath: string): Context => ({
      transport: { description: "wsl:Ubuntu-24.04", clientInvocation: realWsl.clientInvocation.bind(realWsl) },
      paths: { async toTarget(): Promise<string> { return entryPath; } },
      settings: {},
    }) as unknown as Context;
    for (const apply of [false, true]) {
      const applied: string[][] = [];
      const out: string[] = [];
      const message = await deathOf(() => withOutputSink((chunk) => out.push(chunk), () =>
        withScheduleRunner(
          async (_command, args) => { applied.push([...args]); return { code: 0, stdout: "", stderr: "" }; },
          () => printSchedulingInstructions(longCtx(`/mnt/d/${"x".repeat(200)}/clawwright`), "backup", name, 1440, ["backup"], apply),
          "win32",
        )));
      check(`a /tr over 261 characters is refused (apply=${apply}), naming the limit and the fix`, [message.includes("261"), message.includes("shorten")], [true, true]);
      check(`...and nothing is run or printed for schtasks (apply=${apply})`, [applied.length, out.join("").includes("schtasks /create")], [0, false]);
    }
    const fits = "x".repeat(40);
    const okApplied: string[][] = [];
    await withOutputSink(() => {}, () =>
      withScheduleRunner(
        async (_command, args) => { okApplied.push([...args]); return { code: 0, stdout: "", stderr: "" }; },
        () => printSchedulingInstructions(longCtx(`/mnt/d/${fits}/clawwright`), "backup", name, 1440, ["backup"], true),
        "win32",
      ));
    check("a /tr within the limit still applies", okApplied.length, 1);
    check("the applied /tr is at most 261 characters", (okApplied[0]?.[okApplied[0].indexOf("/tr") + 1] ?? "").length <= SCHTASKS_RUN_LIMIT, true);
  }

  const installedRoot = join(root, "installed project");
  const otherCwd = join(root, "other directory");
  await mkdir(installedRoot);
  await mkdir(otherCwd);
  await writeFile(join(installedRoot, "clawwright"), "");
  await writeFile(join(installedRoot, "app.ts"), 'export default { name: "fixture", summary: "Fixture", commands: {} };\n');
  useDeployment(installedRoot);
  const entry = resolve(monorepoRoot, "packages", "clawwright", "entry", "bin.ts");
  const fromOtherCwd = spawnSync(process.execPath, ["--experimental-strip-types", entry, "--project-root", installedRoot, "help"], {
    cwd: otherCwd,
    encoding: "utf8",
  });
  check("installed entry loads app.ts from the scheduled root outside its cwd", fromOtherCwd.status, 0);
  const withoutRoot = spawnSync(process.execPath, ["--experimental-strip-types", entry, "status"], {
    cwd: otherCwd,
    encoding: "utf8",
  });
  check("installed entry cannot use the unrelated cwd as its app", withoutRoot.status, 1);
} finally {
  await rm(root, { recursive: true, force: true });
}

finish("schedule");

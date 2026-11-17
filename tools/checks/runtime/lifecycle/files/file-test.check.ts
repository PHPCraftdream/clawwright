// File-test probes (runtime/files/file-test.ts).
//
// uutils coreutils (default /usr/bin/test on Ubuntu 25.10+) answers -r/-w/-x from mode bits
// against the caller's euid/egid, so `sudo -n test -r DIR` says "no" to root for a
// 1000:1000 mode 700 directory, and so does an unprivileged `test` when Clawwright itself
// runs as root. The probes therefore run through the shell's own `test`, with the path as a
// positional parameter. Pinned here: the exact argv per operator, the exit codes passing
// through unchanged, the archive prefix deciding through the builtin (against a stub that
// answers like uutils for an external test and like the kernel for the builtin), the
// unprivileged callers (sudoFor, sudoForRead, privilegePrefixFor, ensureLockHome, the
// bootstrap directory probes, the privacy-history read) asking the builtin as root, and the
// failure evidence appearing only when a probe fails.

import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";
import { answeredFileTest, ensureLockHome, sudoFor, sudoForRead } from "#framework/runtime/files/datadir.ts";
import { fileTest, fileTestArgv, FILE_TEST_SCRIPTS } from "#framework/runtime/files/file-test.ts";
import { PREREQ_PROBES, runPrereqProbes } from "#framework/commands/lifecycle/bootstrap/prereqs.ts";
import { clearDeployment } from "#framework/runtime/deployment.ts";
import { privatePathsPolicy } from "#framework/security/privacy/private-paths-ledger.ts";
import { privilegePrefixFor } from "#framework/service/archive/index.ts";
import { check, finish } from "#checks/kit/harness.ts";

/** The script text for one operator, assembled from words so it is a value, not prose. */
const script = (flag: string): string => ["test", flag, '"$1"'].join(" ");
const FLAGS = ["-r", "-w", "-d", "-x"] as const;
const HOSTILE = ["/srv/a;", "$(id)", '"q"', "`z`", "*"].join(" ");
const LOCKED = "/srv/app/data/auth-secrets";

check("exactly -d, -r, -w and -x are probed through the shell", Object.keys(FILE_TEST_SCRIPTS).sort(), ["-d", "-r", "-w", "-x"]);

for (const flag of FLAGS) {
  check(`${flag} under sudo -n: builtin test, path as $1`, fileTestArgv(["sudo", "-n"], flag, LOCKED), ["sudo", "-n", "sh", "-c", script(flag), "sh", LOCKED]);
  check(`${flag} without a prefix: same shape, no prefix words`, fileTestArgv([], flag, LOCKED), ["sh", "-c", script(flag), "sh", LOCKED]);
  const hostile = fileTestArgv(["sudo", "-n"], flag, HOSTILE);
  check(`${flag}: a path with spaces and shell metacharacters is one argument`, hostile.slice(-1), [HOSTILE]);
  check(`${flag}: the script is the same text whatever the path is`, hostile[4], script(flag));
  check(`${flag}: the path never reaches the script text`, hostile[4]?.includes(HOSTILE), false);
  check(`${flag}: the script quotes its parameter`, hostile[4]?.endsWith('"$1"'), true);
  check(`${flag}: argv is prefix, shell, -c, script, $0, path and nothing else`, hostile.length, 7);
}

// --- fileTest: executes that argv, tolerates failure, returns the result untouched -------------

for (const code of [0, 1, 2, 127]) {
  const seen: Array<{ command: string; args: string[]; allowFailure: boolean | undefined }> = [];
  const ctx = {
    transport: {
      async exec(command: string, args: string[], options?: { allowFailure?: boolean }): Promise<ExecResult> {
        seen.push({ command, args, allowFailure: options?.allowFailure });
        return { code, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;
  const result = await fileTest(ctx, ["sudo", "-n"], "-r", LOCKED);
  check(`exit ${code} comes back as ${code}`, result.code, code);
  check(`exit ${code}: one call, through the builtin, allowed to fail`, seen, [
    { command: "sudo", args: ["-n", "sh", "-c", script("-r"), "sh", LOCKED], allowFailure: true },
  ]);
}

// --- privilegePrefixFor decides through the builtin --------------------------------------------

interface Model {
  /** The elevated builtin probe for this operator answers `code`. */
  readonly failing?: { readonly flag: string; readonly code: number };
  /** The evidence commands fail at the transport. */
  readonly evidenceThrows?: boolean;
}

interface Seen {
  readonly command: string;
  readonly args: readonly string[];
}

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

/** A target where LOCKED is a directory owned 1000:1000, mode 700, the operator is another
 *  uid, and sudo -n runs as root. An external `test` answers from mode bits (root is neither
 *  owner nor group, so the "other" bits decide: no); the builtin answers like the kernel. */
function lockedTarget(model: Model = {}): { ctx: Context; calls: Seen[] } {
  const calls: Seen[] = [];
  const ctx = {
    settings: { dataDir: "/srv/app/data", env: {} },
    transport: {
      description: "stub",
      async exists(): Promise<boolean> { return true; },
      async exec(command: string, args: string[]): Promise<ExecResult> {
        calls.push({ command, args });
        const elevated = command === "sudo" && args[0] === "-n";
        if (elevated && args[1] === "true") return ok();
        const head = elevated ? (args[1] ?? "") : command;
        const rest = elevated ? args.slice(2) : args;
        if (!elevated) {
          // The operator is not 1000 and not in its group: the kernel's answer is "no" too.
          if (head === "sh" && FLAGS.some((candidate) => rest[1] === script(candidate))) return { code: 1, stdout: "", stderr: "" };
          if (head === "sh") return ok("/usr/bin/sudo\n");
          if (head === "test") return { code: rest[0] === "-d" ? 0 : 1, stdout: "", stderr: "" };
          throw new Error(`unmodelled unprivileged command: ${head}`);
        }
        if (head === "test") return { code: rest[0] === "-d" ? 0 : 1, stdout: "", stderr: "" };
        if (head === "sh" && rest[0] === "-c") {
          const flag = FLAGS.find((candidate) => rest[1] === script(candidate));
          if (flag !== undefined) {
            if (model.failing?.flag === flag) return { code: model.failing.code, stdout: "", stderr: "denied" };
            return ok();
          }
          if (rest[1]?.startsWith("command")) return ok("test\n");
          if (rest[1]?.startsWith("for")) return ok("/usr/lib/cargo/bin/coreutils/test\ntest 0.10.0\n");
        }
        if (model.evidenceThrows === true) throw new Error("boom");
        if (head === "id") return ok("0\n");
        if (head === "stat") return ok("1000:1000 700 directory\n");
        throw new Error(`unmodelled elevated command: ${head}`);
      },
    },
  } as unknown as Context;
  return { ctx, calls };
}

const evidenceCommands = (calls: readonly Seen[]): string[] =>
  calls.filter((call) => call.command === "sudo" && (call.args[1] === "id" || call.args[1] === "stat")).map((call) => call.args[1] ?? "");

{
  const { ctx, calls } = lockedTarget();
  check("a directory only root can enter is read through sudo -n", await privilegePrefixFor(ctx, [LOCKED]), ["sudo", "-n"]);
  const probes = calls.filter((call) => call.command === "sudo" && call.args[1] !== "true");
  check(
    "the elevated probes are -r, -d, -x, each the builtin with the path as $1",
    probes.map((call) => call.args),
    [
      ["-n", "sh", "-c", script("-r"), "sh", LOCKED],
      ["-n", "sh", "-c", script("-d"), "sh", LOCKED],
      ["-n", "sh", "-c", script("-x"), "sh", LOCKED],
    ],
  );
  check("no external test binary ran as the elevated identity", calls.some((call) => call.command === "sudo" && call.args[1] === "test"), false);
  check("a successful probe prints and runs no failure evidence", evidenceCommands(calls), []);
  check(
    "the unprivileged first look asked the builtin for -r once, never an external -r or -x test",
    [
      calls.filter((call) => call.command === "sh" && call.args[1] === script("-r") && call.args[3] === LOCKED).length,
      calls.some((call) => call.command === "test" && (call.args[0] === "-r" || call.args[0] === "-x")),
    ],
    [1, false],
  );
}

for (const [flag, code, first] of [["-r", 1, "cannot"], ["-d", 2, "could"], ["-x", 1, "cannot"]] as const) {
  const { ctx, calls } = lockedTarget({ failing: { flag, code } });
  let failure: Error | undefined;
  try { await privilegePrefixFor(ctx, [LOCKED]); } catch (error) { failure = error as Error; }
  const lines = (failure?.message ?? "").split("\n");
  const words = (line: string | undefined): string[] => (line ?? "").trim().split(/\s/);
  check(`${flag} failing: the refusal is an error`, failure instanceof Error, true);
  check(`${flag} failing: the headline is the first line`, words(lines[0])[0], first);
  check(
    `${flag} failing: the evidence lines follow in a fixed order`,
    lines.slice(1).map((line) => words(line)[0]),
    ["probe:", "uid:", "builtin:", "binary:", "external:", "target:"],
  );
  check(`${flag} failing: the probe line carries the exit code and the stderr word`, words(lines[1]).slice(2), [`${code},`, "stderr", '"denied"']);
  check(`${flag} failing: the uid line reports the elevated uid`, words(lines[2]).slice(2), ["0,", "stdout", '"0"']);
  check(`${flag} failing: the external test is asked through the same prefix`, calls.some((call) => call.command === "sudo" && call.args[1] === "test" && call.args[2] === flag && call.args[3] === LOCKED), true);
  check(`${flag} failing: id and stat ran through the same prefix`, evidenceCommands(calls), ["id", "stat"]);
}

{
  const { ctx } = lockedTarget({ failing: { flag: "-r", code: 1 }, evidenceThrows: true });
  let failure: Error | undefined;
  try { await privilegePrefixFor(ctx, [LOCKED]); } catch (error) { failure = error as Error; }
  check("evidence that cannot be gathered still ends in the original refusal", (failure?.message ?? "").split(/\s/)[0], "cannot");
  check("and says why the evidence is missing", /boom/.test(failure?.message ?? ""), true);
}

// --- answeredFileTest: the builtin through answeredProbe's retry and answer rules ---------------

for (const code of [0, 1]) {
  const seen: Array<{ command: string; args: string[] }> = [];
  const ctx = {
    transport: {
      async exec(command: string, args: string[]): Promise<ExecResult> {
        seen.push({ command, args });
        return { code, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;
  check(`-w answered ${code} comes back as ${code}`, (await answeredFileTest(ctx, "-w", HOSTILE)).code, code);
  check(`-w answered ${code}: one call, the builtin, the path as the only argument`, seen, [
    { command: "sh", args: ["-c", script("-w"), "sh", HOSTILE] },
  ]);
}

for (const code of [2, 127, 255]) {
  let asked = 0;
  const ctx = {
    transport: {
      async exec(): Promise<ExecResult> {
        asked += 1;
        return { code, stdout: "", stderr: "hiccup" };
      },
    },
  } as unknown as Context;
  let message = "";
  try { await answeredFileTest(ctx, "-r", LOCKED); } catch (error) { message = (error as Error).message; }
  check(`exit ${code} is retried, then reported as a transport failure`, [asked, message.includes("transport"), message.includes("hiccup")], [3, true, true]);
}

// --- Clawwright itself as root on a uutils host --------------------------------------------------
//
// No sudo anywhere: the operator IS root, LOCKED is 1000:1000 mode 700. The external `test`
// answers from mode bits (root is neither owner nor group, "other" has nothing: no); the
// builtin answers like the kernel (yes). Every other command throws, so an escalation, a
// chown or a mkdir the answer should have made unnecessary fails loudly.

const PAYLOAD = `${JSON.stringify({ privatePaths: ["history-entry"] })}\n`;

function uutilsRoot(): { ctx: Context; calls: Seen[] } {
  const calls: Seen[] = [];
  const ctx = {
    settings: { dataDir: "/srv/app/data", backupDir: "/srv/app/backups", snapshotDir: "/srv/app/snapshots", env: {} },
    transport: {
      description: "uutils-root-stub",
      async exists(): Promise<boolean> { return true; },
      async exec(command: string, args: string[]): Promise<ExecResult> {
        calls.push({ command, args });
        if (command === "test") return { code: args[0] === "-d" ? 0 : 1, stdout: "", stderr: "" };
        if (command === "sh" && args[0] === "-c" && FLAGS.some((candidate) => args[1] === script(candidate))) return ok();
        if (command === "cat") return ok(PAYLOAD);
        throw new Error(`unmodelled command on a root host that needs no escalation: ${command} ${args.join(" ")}`);
      },
    },
  } as unknown as Context;
  return { ctx, calls };
}

const builtinAsked = (calls: readonly Seen[]): readonly (readonly string[])[] =>
  calls.filter((call) => call.command === "sh").map((call) => call.args);
const externalAccessTests = (calls: readonly Seen[]): number =>
  calls.filter((call) => call.command === "test" && (call.args[0] === "-r" || call.args[0] === "-w" || call.args[0] === "-x")).length;

{
  const { ctx, calls } = uutilsRoot();
  check("sudoFor: root needs no escalation although the external test says no", await sudoFor(ctx, LOCKED), []);
  check("sudoFor asks the builtin -w", builtinAsked(calls), [["-c", script("-w"), "sh", LOCKED]]);
  check("sudoFor ran no external access test", externalAccessTests(calls), 0);
}

{
  const { ctx, calls } = uutilsRoot();
  check("sudoForRead: root reads it without sudo", await sudoForRead(ctx, LOCKED), []);
  check("sudoForRead asks the builtin -r", builtinAsked(calls), [["-c", script("-r"), "sh", LOCKED]]);
  check("sudoForRead ran no external access test", externalAccessTests(calls), 0);
}

{
  const { ctx, calls } = uutilsRoot();
  check("privilegePrefixFor: root archives it without a prefix", await privilegePrefixFor(ctx, [LOCKED]), []);
  check("privilegePrefixFor asks the builtin -r then -x", builtinAsked(calls), [["-c", script("-r"), "sh", LOCKED], ["-c", script("-x"), "sh", LOCKED]]);
  check("privilegePrefixFor ran no external access test (the -d question stays external)", [externalAccessTests(calls), calls.filter((call) => call.command === "test").length], [0, 1]);
}

{
  const { ctx, calls } = uutilsRoot();
  await ensureLockHome(ctx);
  const asked = builtinAsked(calls);
  check("ensureLockHome: a writable lock home per the builtin needs no chown and no sudo", [asked.length, asked[0]?.[1], externalAccessTests(calls)], [1, script("-w"), 0]);
}

{
  const { ctx, calls } = uutilsRoot();
  const results = await runPrereqProbes(ctx, PREREQ_PROBES.slice(2, 5));
  check("bootstrap --check: the data, backup and snapshot directories read as writable", results.map((result) => result.status), ["ok", "ok", "ok"]);
  check("and each was asked to the builtin -w", builtinAsked(calls).map((argv) => argv[1]), [script("-w"), script("-w"), script("-w")]);
  check("and no external -w test ran", externalAccessTests(calls), 0);
}

{
  clearDeployment();
  const { ctx, calls } = uutilsRoot();
  check("the privacy-history copy is read as root without sudo", await privatePathsPolicy(ctx), ["history-entry"]);
  check("and its readability was asked to the builtin -r", builtinAsked(calls), [["-c", script("-r"), "sh", "/srv/app/data/config/clawwright-private-paths.json"]]);
  check("with no external -r test", externalAccessTests(calls), 0);
}

finish("file-test probes");

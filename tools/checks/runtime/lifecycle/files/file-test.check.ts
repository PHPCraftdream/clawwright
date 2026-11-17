// Elevated file-test probes (runtime/files/file-test.ts).
//
// uutils coreutils (default /usr/bin/test on Ubuntu 25.10+) answers -r/-x from mode bits
// against the caller's euid/egid, so `sudo -n test -r DIR` says "no" to root for a
// 1000:1000 mode 700 directory. The probes therefore run through the shell's own `test`,
// with the path as a positional parameter. Pinned here: the exact argv per operator, the
// exit codes passing through unchanged, the archive prefix deciding through the builtin
// (against a stub that answers like uutils for an external test and like the kernel for
// the builtin), and the failure evidence appearing only when a probe fails.

import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";
import { fileTest, fileTestArgv, FILE_TEST_SCRIPTS } from "#framework/runtime/files/file-test.ts";
import { privilegePrefixFor } from "#framework/service/archive/index.ts";
import { check, finish } from "#checks/kit/harness.ts";

/** The script text for one operator, assembled from words so it is a value, not prose. */
const script = (flag: string): string => ["test", flag, '"$1"'].join(" ");
const FLAGS = ["-r", "-d", "-x"] as const;
const HOSTILE = ["/srv/a;", "$(id)", '"q"', "`z`", "*"].join(" ");
const LOCKED = "/srv/app/data/auth-secrets";

check("exactly -d, -r and -x are probed through the shell", Object.keys(FILE_TEST_SCRIPTS).sort(), ["-d", "-r", "-x"]);

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

finish("file-test probes");

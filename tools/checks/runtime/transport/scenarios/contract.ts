// The transport contract, defined once. local.check.ts, wsl.check.ts and ssh.check.ts each
// call runTransportScenarios() against their own real Transport, so every promise tested here
// holds identically across all three — a divergence between transports is a real bug, not a
// check that forgot to cover one of them.
//
// Every assertion below tests exactly what packages/clawwright/runtime/transport/exec.ts's
// Transport interface promises, nothing more: read that file before adding one. Where the
// interface is silent (e.g. the exact wording of a "file not found" error), this suite checks
// the shape (it rejects) and not the wording, because the three implementations word it
// differently (a raw Node fs error locally, a composed `cat ... failed` message remotely) and
// that difference is not a bug.
//
// Everything this suite creates on the target lives under a per-run scratch directory made
// (and removed) through the transport itself — never through node:fs, and never inside this
// repository: the target may not share a filesystem with the process running this check.

import { randomBytes } from "node:crypto";
import type { Transport } from "#framework/runtime/transport/transport.ts";
import { TransportUnreachableError } from "#framework/runtime/transport/transport.ts";
import { shellQuote } from "#framework/core/io/shell.ts";
import { check, checkTrue } from "#checks/kit/harness.ts";

export interface TransportScenarioOptions {
  /** Exit code the target reports for a command that does not exist. A POSIX shell says 127;
   *  wsl.exe's `--exec` bypasses the target's shell entirely and reports its own execve()
   *  failure differently — real, observed platform behavior a shared suite must parametrize
   *  rather than paper over. Default 127. */
  readonly nonexistentCommandExitCode?: number;
  /** Builds a transport this suite expects TransportUnreachableError from: a WSL distro name
   *  that cannot exist, an ssh target on a closed port. Omitted where a target cannot be
   *  "unreachable" once built — a local target either runs or is refused by createTransport()
   *  before any Transport exists, so there is nothing here to reach with one already built. */
  readonly makeUnreachableTransport?: () => Transport;
}

// 3-byte ("€") and 2-byte ("ж") UTF-8 sequences back to back: doubling this string 17 times
// (below) crosses a 64 KB read-chunk boundary many times over, and never on a whole-character
// edge, since the two units are different lengths.
const MULTIBYTE_UNIT = "€ж";
const MULTIBYTE_DOUBLINGS = 17;

/** Grows `unit` in the target's own shell (doubling, not a forked-per-char loop) so producing
 *  hundreds of kilobytes costs a handful of forks, not thousands. */
function doublingScript(unit: string, doublings: number): string {
  return `s='${unit}'; i=0; while [ $i -lt ${doublings} ]; do s="$s$s"; i=$((i+1)); done; printf %s "$s"`;
}

const QUOTING_CASES = [
  "plain",
  "has spaces",
  "single'quote",
  "$(command substitution)",
  "`backticks`",
  "line\nbreak",
  "unicode ★ ж 漢字",
  "-leading-dash",
];

async function execScenarios(transport: Transport, label: (s: string) => string, options: TransportScenarioOptions): Promise<void> {
  check(label("exec of true resolves with exit 0"), (await transport.exec("true", [])).code, 0);
  check(label("exec of false under allowFailure resolves with exit 1"), (await transport.exec("false", [], { allowFailure: true })).code, 1);
  check(label("an exact non-zero exit code round-trips"), (await transport.exec("sh", ["-c", "exit 7"], { allowFailure: true })).code, 7);

  {
    let threw = false;
    try { await transport.exec("false", []); } catch { threw = true; }
    checkTrue(label("a non-zero exit without allowFailure rejects rather than returning"), threw);
  }

  {
    const result = await transport.exec("sh", ["-c", "printf out-marker; printf err-marker 1>&2"]);
    check(label("stdout and stderr are captured separately"), [result.stdout, result.stderr], ["out-marker", "err-marker"]);
  }

  {
    const expected = MULTIBYTE_UNIT.repeat(2 ** MULTIBYTE_DOUBLINGS);
    const result = await transport.exec("sh", ["-c", doublingScript(MULTIBYTE_UNIT, MULTIBYTE_DOUBLINGS)]);
    check(label(`multibyte output crossing a chunk boundary decodes exactly (${Buffer.byteLength(expected, "utf8")} bytes)`), result.stdout, expected);
  }

  {
    const input = `stdin-payload-${MULTIBYTE_UNIT}`;
    check(label("stdin passes through to the child exactly"), (await transport.exec("cat", [], { input })).stdout, input);
    check(label("stdin still passes through under a deadline"), (await transport.exec("cat", [], { input, timeoutMs: 60_000 })).stdout, input);
    check(label("a command under a deadline keeps its exit code"), (await transport.exec("sh", ["-c", "exit 3"], { allowFailure: true, timeoutMs: 60_000 })).code, 3);
  }

  for (const value of QUOTING_CASES) {
    const result = await transport.exec("printf", ["%s", value], { allowFailure: true });
    check(label(`an argument needing quoting round-trips through printf %s: ${JSON.stringify(value)}`), result.stdout, value);
  }

  {
    const expectedCode = options.nonexistentCommandExitCode ?? 127;
    const result = await transport.exec("oc-check-definitely-nonexistent-cmd", [], { allowFailure: true });
    check(label("a nonexistent command reports the documented exit code, not a throw"), result.code, expectedCode);
  }
}

async function fileScenarios(transport: Transport, label: (s: string) => string, tmp: string): Promise<void> {
  {
    const dir = `${tmp}/unicode dir ★`;
    await transport.mkdirp(dir);
    const path = `${dir}/файл with spaces.txt`;
    // Embedded NUL and multibyte characters: content that is not merely ASCII, passed as a
    // Uint8Array (not a string) so the write path cannot be quietly assuming text.
    const text = `binary-safe payload\u0000embedded-nul ${MULTIBYTE_UNIT} done\n`;
    await transport.writeFile(path, Buffer.from(text, "utf8"));
    check(label("writeFile/readFile round-trips binary-safe content through a unicode path with spaces"), await transport.readFile(path), text);
  }

  {
    // Not a proof of atomicity under concurrent readers (no Transport method exposes that) —
    // only the observable contract: after a second write, the old content is gone completely,
    // not truncated-and-reused in place.
    const path = `${tmp}/replace-me.txt`;
    await transport.writeFile(path, "A".repeat(5000));
    await transport.writeFile(path, "B");
    check(label("overwriting an existing file leaves exactly the new content"), await transport.readFile(path), "B");
  }

  {
    let threw = false;
    try { await transport.readFile(`${tmp}/does-not-exist.txt`); } catch { threw = true; }
    checkTrue(label("readFile of a missing file rejects rather than returning empty content"), threw);
  }
}

async function timeoutScenario(transport: Transport, label: (s: string) => string, tmp: string): Promise<void> {
  const pidFile = `${tmp}/timeout-pid`;
  let rejected: (Error & { timedOut?: boolean }) | undefined;
  try {
    // `exec sleep 20` replaces the shell's own process image (same pid) with sleep, so the
    // pid this records is the long-running process the deadline is supposed to end.
    await transport.exec("sh", ["-c", `echo $$ > ${shellQuote(pidFile)}; exec sleep 20`], { timeoutMs: 3000 });
  } catch (error) {
    rejected = error as Error & { timedOut?: boolean };
  }
  checkTrue(label("a command past its timeout rejects"), rejected !== undefined);
  checkTrue(label("...marked as a timeout, not misclassified as an unrelated/unreachable failure"), rejected?.timedOut === true);

  // The local wrapper (wsl.exe/ssh) having exited proves nothing about the target process on
  // its own — give the target's own SIGTERM/SIGKILL escalation time to land, then ask the
  // target itself whether that pid is still around.
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const pid = (await transport.readFile(pidFile)).trim();
  const stillAlive = await transport.exec("sh", ["-c", `kill -0 ${shellQuote(pid)} 2>/dev/null`], { allowFailure: true });
  check(label("the timed-out command's process is actually gone on the target, not left running"), stillAlive.code !== 0, true);
}

/** The deadline must end the command's whole process tree, not just its top process. */
async function timeoutTreeScenario(transport: Transport, label: (s: string) => string, tmp: string): Promise<void> {
  const childPidFile = `${tmp}/timeout-child-pid`;
  const started = Date.now();
  try {
    await transport.exec("sh", ["-c", `sleep 30 & echo $! > ${shellQuote(childPidFile)}; wait`], { timeoutMs: 3000 });
  } catch {
    // The rejection itself is asserted by timeoutScenario.
  }
  // A surviving child holds the output pipes open, so the call would only return once it exits.
  checkTrue(label("a timed-out command returns at its deadline, not when its child exits"), Date.now() - started < 15_000);
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const pid = (await transport.readFile(childPidFile)).trim();
  const stillAlive = await transport.exec("sh", ["-c", `kill -0 ${shellQuote(pid)} 2>/dev/null`], { allowFailure: true });
  if (stillAlive.code === 0) await transport.exec("sh", ["-c", `kill -9 ${shellQuote(pid)} 2>/dev/null`], { allowFailure: true });
  check(label("the timed-out command's child process is gone too, not orphaned"), stillAlive.code !== 0, true);
}

async function unreachableScenario(label: (s: string) => string, options: TransportScenarioOptions): Promise<void> {
  if (options.makeUnreachableTransport === undefined) return;
  const unreachable = options.makeUnreachableTransport();
  let error: unknown;
  try {
    await unreachable.exec("true", [], { timeoutMs: 15_000 });
  } catch (thrown) {
    error = thrown;
  }
  checkTrue(label("a target that cannot be reached raises TransportUnreachableError"), error instanceof TransportUnreachableError);
}

/** Runs the whole contract against one real Transport. `name` prefixes every check line
 *  (`local: ...`, `wsl: ...`, `ssh: ...`) so a failure names which transport broke without
 *  needing three near-duplicate suites to keep in sync by hand. */
export async function runTransportScenarios(
  name: string,
  makeTransport: () => Transport | Promise<Transport>,
  options: TransportScenarioOptions = {},
): Promise<void> {
  const transport = await makeTransport();
  const label = (scenario: string): string => `${name}: ${scenario}`;
  const tmp = `/tmp/oc-transport-check-${name}-${randomBytes(6).toString("hex")}`;

  await transport.mkdirp(tmp);
  try {
    await execScenarios(transport, label, options);
    await fileScenarios(transport, label, tmp);
    await timeoutScenario(transport, label, tmp);
    await timeoutTreeScenario(transport, label, tmp);
    await unreachableScenario(label, options);
  } finally {
    await transport.remove(tmp);
  }
}

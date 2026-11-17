// Preparing the directory the instance lock is created in.
//
// The bug this guards is one that reads correctly and does the opposite: `sudo -n sh -c
// 'chown "$(id -u):$(id -g)" <dir>'` evaluates the substitution in the shell sudo started —
// root's — so it hands the directory to 0:0 and the ordinary user still cannot create a
// lock. The preparation appeared to work, and left the exact state it exists to prevent.
//
// So the assertions are about the shape of what reaches the target, not about the outcome
// of a run: numeric ids, resolved before any escalation, passed as plain arguments.

import { ensureLockHome, needsOwnerEscalation, sudoFor, answeredProbe } from "#framework/runtime/files/datadir.ts";
import { shellQuote } from "#framework/core/io/shell.ts";
import { lockHome } from "#framework/runtime/lock/instance-lock.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { asDirectTest } from "#checks/runtime/service/restore/file-test-stub.ts";

interface TargetSpec {
  /** Directories that already exist on the target. */
  existing?: string[];
  /** Paths an unprivileged mkdir cannot create. */
  unprivilegedMkdirFails?: boolean;
  /** Paths `test -w` reports as writable, by the time it is asked. */
  writableAfterChown?: boolean;
}

function recordingContext(spec: TargetSpec) {
  const calls: { command: string; args: string[] }[] = [];
  const existing = new Set(spec.existing ?? []);
  let chowned = false;

  const ctx = {
    settings: { dataDir: "/srv/clawwright" },
    transport: {
      async exists(path: string): Promise<boolean> {
        return existing.has(path);
      },
      async exec(rawCommand: string, rawArgs: string[]): Promise<ExecResult> {
        const { command, args } = asDirectTest(rawCommand, rawArgs);
        calls.push({ command, args });

        if (command === "id") return { code: 0, stdout: args[0] === "-u" ? "1000\n" : "1001\n", stderr: "" };
        if (command === "mkdir") {
          if (spec.unprivilegedMkdirFails === true) return { code: 1, stdout: "", stderr: "Permission denied" };
          existing.add(args[args.length - 1]);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "chown") {
          chowned = true;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "test" && args[0] === "-w") {
          const ok = spec.writableAfterChown === false ? false : chowned || spec.unprivilegedMkdirFails !== true;
          return { code: ok ? 0 : 1, stdout: "", stderr: "" };
        }
        // sudo availability probes from sudoFor.
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;

  return { ctx, calls };
}

async function run(ctx: Context): Promise<string> {
  let message = "";
  await withOutputSink(
    () => {},
    async () => {
      try {
        await ensureLockHome(ctx);
      } catch (error) {
        message = (error as Error).message;
      }
    },
  );
  return message;
}

// --- the ownership handover ------------------------------------------------------------------

{
  // The parent needs root: an unprivileged mkdir fails, so the directory is created with
  // sudo and handed over — and the handover is what used to go to 0:0.
  const { ctx, calls } = recordingContext({ unprivilegedMkdirFails: true });
  await run(ctx);

  const chown = calls.find((call) => call.command === "chown" || (call.command === "sudo" && call.args.includes("chown")));
  check("the directory is handed over after being created", chown !== undefined, true);

  const argv = [chown?.command ?? "", ...(chown?.args ?? [])];
  check("with numeric ids", argv.includes("1000:1001"), true);
  // The failure mode in one assertion: a substitution reaching the target is evaluated
  // wherever the target evaluates it, which under sudo is root's shell.
  check("and no command substitution left for the target to evaluate", argv.some((arg) => arg.includes("$(")), false);
  check("nor a shell wrapped around it", argv.includes("sh"), false);
}

{
  // Who asks decides the answer. `id` run under sudo — or expanded by a shell sudo started —
  // reports root, whenever it happens; run as the tooling's own user it reports the right
  // ids no matter what escalated before or after.
  const { ctx, calls } = recordingContext({ unprivilegedMkdirFails: true });
  await run(ctx);

  const idCalls = calls.filter((call) => call.command === "id" || (call.command === "sudo" && call.args.includes("id")));
  check("the ids are read at all", idCalls.length > 0, true);
  check("and never through sudo", idCalls.filter((call) => call.command === "sudo").length, 0);
}

// --- the ordinary case does no work at all -----------------------------------------------------

{
  const { ctx, calls } = recordingContext({ existing: [lockHome({ settings: { dataDir: "/srv/clawwright" } } as unknown as Context)] });
  await run(ctx);
  check("an existing, writable home is left alone", calls.some((call) => call.command === "chown"), false);
  check("and nothing is created", calls.some((call) => call.command === "mkdir"), false);
}

// --- a handover that did not take is reported ---------------------------------------------------

{
  // Assuming the chown worked leaves a directory the lock cannot be created in, and that
  // resurfaces later as a failed claim on some unrelated command.
  const { ctx } = recordingContext({ unprivilegedMkdirFails: true, writableAfterChown: false });
  const message = await run(ctx);
  check("a directory still not writable afterwards is a failure", message !== "", true);
  check("saying what it stops", message.includes("nothing that changes this deployment can run"), true);
  check("and how to prepare it by hand", message.includes("sudo install -d"), true);
}

// --- a probe the transport refuses to answer -----------------------------------------------------

{
  // exists() reports a path it was not allowed to look at by throwing, rather than calling it
  // absent. sudoFor()'s climb was written against the old lenient answer: it walked up until
  // something "existed" and asked `test -w` there. On a root-only data directory the very
  // first probe now throws, and letting that escape would stop every privileged command this
  // framework has — backup, restore, state, verify — on exactly the hosts sudo is there for.
  //
  // A directory we cannot even look into answers the question sudoFor asks.
  const calls: { command: string; args: string[] }[] = [];
  let existsCalls = 0;
  const ctx = {
    settings: { dataDir: "/srv/clawwright" },
    transport: {
      async exists(path: string): Promise<boolean> {
        existsCalls += 1;
        throw new Error(`could not check whether ${path} exists: /srv/clawwright cannot be searched by the target user`);
      },
      async exec(rawCommand: string, rawArgs: string[]): Promise<ExecResult> {
        const { command, args } = asDirectTest(rawCommand, rawArgs);
        calls.push({ command, args });
        if (command === "test" && args[0] === "-w") return { code: 1, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;

  let prefix: unknown;
  try {
    prefix = await sudoFor(ctx, "/srv/clawwright/data");
  } catch (error) {
    prefix = `threw: ${(error as Error).message}`;
  }

  check("a directory that cannot be looked into is escalated to, not aborted on", prefix, ["sudo", "-n"]);
  check("three refusals in a row end the climb: exactly three exists calls, none for an ancestor", existsCalls, 3);
  check(
    "and writability is asked about that path, not about an ancestor",
    calls.find((call) => call.command === "test")?.args,
    ["-w", "/srv/clawwright/data"],
  );
}

// --- a probe that failed once and then answers -------------------------------------------------

{
  // A transport hiccup (wsl.exe/ssh under load) makes exists() throw once. That is not a
  // directory this user cannot enter: read as one, a writable path is sent to sudo, and a
  // host without passwordless sudo then refuses a backup it could have made.
  let asked = 0;
  const calls: { command: string; args: string[] }[] = [];
  const ctx = {
    settings: { dataDir: "/srv/clawwright" },
    transport: {
      async exists(path: string): Promise<boolean> {
        asked += 1;
        if (asked === 1) throw new Error(`could not check whether ${path} exists (exit 255): connection reset`);
        return path === "/srv/clawwright";
      },
      async exec(rawCommand: string, rawArgs: string[]): Promise<ExecResult> {
        const { command, args } = asDirectTest(rawCommand, rawArgs);
        calls.push({ command, args });
        // Only the directory that exists is writable; test -w on an absent path answers 1.
        if (command === "test" && args[0] === "-w") return { code: args[1] === "/srv/clawwright" ? 0 : 1, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;

  check("a probe that throws once and then answers is asked again", await sudoFor(ctx, "/srv/clawwright/data"), []);
  check("and writability is judged on the nearest existing ancestor", calls.find((call) => call.command === "test")?.args, ["-w", "/srv/clawwright"]);
}

// --- the "no passwordless sudo" refusal advises the whole family, not just one path ----------
//
// The bug: bootstrap refused on the lock home alone ("sudo install -d ... data-locks"), and
// once that was done by hand it refused again the same way on the data directory, then again
// on backups and snapshots the first time each was touched — four manual sudo rounds where
// one should do. sudoFor's own die() now asks datadir.ts's prepareFamilyAdvice for every
// command to print instead of naming just the path that happened to fail first.

/** A target with no passwordless sudo, dataDir/backupDir/snapshotDir sharing one root
 *  (scaffold.ts's/init.ts's own default layout), and a configurable identity for whoever
 *  runs the tooling — the fact that decides whether the lock home's own group merges with
 *  the data family's or stays separate. */
function familyContext(owner: string, root = "/srv/openclaw"): Context {
  const [uid, gid] = owner.split(":");
  return {
    settings: {
      dataDir: `${root}/data`,
      backupDir: `${root}/backups`,
      snapshotDir: `${root}/snapshots`,
    },
    transport: {
      async exists(): Promise<boolean> {
        return false;
      },
      async exec(rawCommand: string, rawArgs: string[]): Promise<ExecResult> {
        const { command, args } = asDirectTest(rawCommand, rawArgs);
        if (command === "id") return { code: 0, stdout: args[0] === "-u" ? `${uid}\n` : `${gid}\n`, stderr: "" };
        if (command === "test" && args[0] === "-w") return { code: 1, stdout: "", stderr: "" };
        // sudo IS on the target ("sh -c command -v sudo" below succeeds)...
        if (command === "sh") return { code: 0, stdout: "", stderr: "" };
        // ...but it always asks for a password ("sudo -n true" fails).
        if (command === "sudo") return { code: 1, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;
}

const sudoLines = /sudo install -d[^\n]*/g;

async function familyRefusal(owner: string, root = "/srv/openclaw"): Promise<string> {
  try {
    await sudoFor(familyContext(owner, root), `${root}/data`);
    return "(did not refuse)";
  } catch (error) {
    return (error as Error).message;
  }
}

{
  // The WSL-default-user case: whoever runs the tooling already is
  // uid 1000, same as the container — every directory this deployment needs collapses into
  // one owner, and the advice is one line for the whole family instead of one per path.
  const message = await familyRefusal("1000:1000");
  const commands: string[] = message.match(sudoLines) ?? [];
  check("when the tooling's own user already is uid 1000, one command covers the family", commands.length, 1);
  check("naming the shared root, not each path", commands[0], "sudo install -d -o 1000 -g 1000 /srv/openclaw");
}

{
  // A data root spelled with a space must survive the handed-over sudo line as one
  // element — the line is pasted into a root shell by hand (review R17).
  const message = await familyRefusal("1000:1000", "/srv/my openclaw");
  const commands: string[] = message.match(sudoLines) ?? [];
  check("a spaced data root is one quoted element of the sudo line", commands[0], `sudo install -d -o 1000 -g 1000 ${shellQuote("/srv/my openclaw")}`);
}

{
  // The transport-failure refusal names the probe it could not run; a spaced path in it
  // stays one element (review R17).
  const ctx = { transport: { exec: async () => ({ code: 2, stdout: "", stderr: "" }) } } as unknown as Context;
  let message = "";
  try {
    await answeredProbe(ctx, "test", ["-w", "/srv/my dir"], [0, 1]);
  } catch (error) {
    message = (error as Error).message;
  }
  check("the probe refusal quotes a spaced path", message.includes(`\`test -w ${shellQuote("/srv/my dir")}\``), true);
  check("and never echoes the bare space join", message.includes("`test -w /srv/my dir`"), false);
}

{
  // A real server: whoever runs the tooling is not uid 1000. The container-owned family
  // (data/backups/snapshots) still collapses to their shared root; the lock home — owned by
  // the invoking identity, never the container's — is named on its own so this command
  // cannot re-chown the shared root out from under the other group.
  const message = await familyRefusal("1000:1001");
  const commands: string[] = message.match(sudoLines) ?? [];
  check("otherwise, one command per owner", commands.length, 2);
  check("the container-owned family still names the shared root", commands.includes("sudo install -d -o 1000 -g 1000 /srv/openclaw"), true);
  check("the lock home keeps the tooling's own identity, not the container's", commands.includes("sudo install -d -o 1000 -g 1001 /srv/openclaw/data-locks"), true);
}

// A privilege probe that never ran (wsl.exe/ssh failing under load: exit 255, -1, ...) is not
// the answer "not writable"/"not the owner": it is retried, then reported as a transport
// failure — never turned into "needs root" plus a sudo refusal.
{
  function flaky(results: Record<string, number[]>): Context {
    return {
      settings: { dataDir: "/srv/x/data" },
      transport: {
        description: "stub",
        async exists(): Promise<boolean> { return true; },
        async exec(rawCommand: string, rawArgs: string[]): Promise<ExecResult> {
          const { command, args } = asDirectTest(rawCommand, rawArgs);
          const queue = results[`${command} ${args[0]}`] ?? [0];
          const code = queue.length > 1 ? queue.shift() as number : queue[0];
          return { code, stdout: command === "id" ? "1000\n" : "", stderr: code === 255 ? "wsl: transport hiccup" : "" };
        },
      },
    } as unknown as Context;
  }
  check("a transient probe failure is retried, and a writable path needs no sudo", (await sudoFor(flaky({ "test -w": [255, 0] }), "/srv/x/data")).length, 0);
  let message = "";
  try { await sudoFor(flaky({ "test -w": [255] }), "/srv/x/data"); } catch (error) { message = (error as Error).message; }
  check("a probe that never runs is reported as the transport failing", /transport failed, not the check/.test(message), true);
  check("and never as a sudo refusal", /needs root/.test(message), false);
  check("an id probe hiccup is retried, not read as \"escalate\"", await needsOwnerEscalation(flaky({ "id -u": [255, 0] }), "1000:1000"), false);
  // Not writable, so sudo is asked; a hiccup there is retried, never read as "asks for a password".
  check("a sudo probe hiccup is retried", await sudoFor(flaky({ "test -w": [1], "sudo -n": [255, 0] }), "/srv/x/data"), ["sudo", "-n"]);
  message = "";
  try { await sudoFor(flaky({ "test -w": [1], "sudo -n": [255] }), "/srv/x/data"); } catch (error) { message = (error as Error).message; }
  check("a sudo probe that never runs is a transport failure", /transport failed, not the check/.test(message), true);
  check("and never \"asks for a password\"", /asks for a password/.test(message), false);
}

finish("lock home");

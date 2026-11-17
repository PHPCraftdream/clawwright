// loadSecrets(): keys private from the first byte and published by one rename, the previous
// keys left intact on every failure, and the chown escalation decided by identity rather than
// directory writability. A modelled target filesystem, no real target.

import { resolve } from "node:path";
import { loadSecrets } from "#framework/commands/lifecycle/state.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";
import { modelMutationGuard } from "./mutation-guard.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { asDirectTest } from "#checks/kit/deployment-fixture.ts";

useDeployment(resolve(monorepoRoot, "apps", "example app"));

// --- loadSecrets: keys private from the first byte, published by one rename ---------------
//
// A model of the target filesystem rather than command echoes: the contract is about what is
// true on the target between two commands — content at the final path under a mode other
// than 600, a staging file left behind — and only a model can observe that.

type SecretFailure = "write" | "chown" | "mv";

const SECRETS_FINAL = "/srv/openclaw/data/config/.env";
const SECRETS_PREVIOUS = "ANTHROPIC_API_KEY=previous-key-value-0123456789\n";
const SECRETS_UPDATED = "ANTHROPIC_API_KEY=updated-key-value-0123456789\nOPENAI_API_KEY=second-key-value-0123456789\n";

function secretsScenario(options: { privateFile?: boolean; fail?: SecretFailure; identity?: string; noSudo?: boolean }): {
  ctx: Context;
  files: Map<string, { content: string; mode: string; owner: string }>;
  events: string[];
  sudoCalls: string[][];
  output: string[];
} {
  const files = new Map<string, { content: string; mode: string; owner: string }>();
  const events: string[] = [];
  const sudoCalls: string[][] = [];
  const output: string[] = [];
  // Who runs the tooling ON THE TARGET. needsOwnerEscalation() reads it through `id -u`/`id -g`
  // before every chown, so the stubbed answer is what decides whether the chown below
  // escalates. The default is the gateway identity, under which nothing about the existing
  // scenarios changes: no force, the `test -w` probe answers writable, no sudo.
  const [uid, gid] = (options.identity ?? "1000:1000").split(":");
  files.set(SECRETS_FINAL, { content: SECRETS_PREVIOUS, mode: "600", owner: "1000:1000" });

  // Both private-write shapes create at 0600 (umask 077, exclusive) — recorded as such, so a
  // later chmod-down from a permissive mode cannot masquerade as created-private.
  const stage = (target: string, content: string): void => {
    events.push(`stage:0600:${target}`);
    if (options.fail === "write") throw new Error("staging write failed");
    files.set(target, { content, mode: "600", owner: "runner" });
  };

  // Hoisted, not a method on the transport literal below: the sudo unwrap inside re-dispatches
  // into these very branches, and an object-literal method has no name to call itself by.
  async function execStub(rawCommand: string, rawArgs: string[], execOptions?: { input?: string | Uint8Array; allowFailure?: boolean }): Promise<ExecResult> {
    const { command, args } = asDirectTest(rawCommand, rawArgs);
    const finish = (result: ExecResult): ExecResult => {
      if (result.code !== 0 && execOptions?.allowFailure !== true) throw new Error(`${command} exited ${result.code}: ${result.stderr.trim()}`);
      return result;
    };

    // An invocation that arrived wrapped in sudo: recorded as made, then run as its inner
    // command so every branch below judges the real chown/mv/rm unchanged. sudoFor's own
    // `sudo -n true` availability probe is answered before the recording — it is a
    // capability check, not a command this scenario ran.
    if (command === "sudo") {
      if (args[0] === "-n" && args[1] === "true") {
        return finish(options.noSudo === true ? { code: 1, stdout: "", stderr: "sudo: a password is required" } : { code: 0, stdout: "", stderr: "" });
      }
      sudoCalls.push(args);
      return execStub(args[1] ?? "", args.slice(2), execOptions);
    }
    // The identity every chown-escalation decision starts from.
    if (command === "id") return { code: 0, stdout: args[0] === "-u" ? (uid ?? "") : (gid ?? ""), stderr: "" };
    if (command === "test") return { code: 0, stdout: "", stderr: "" };
    // sudoFor's availability probe, answered before the fallback-write check: an escalation
    // forced by the identity comparison reaches `command -v sudo` from here.
    if (command === "sh" && args[0] === "-c") {
      if (args[1]?.includes("command -v sudo")) {
        return finish(options.noSudo === true ? { code: 1, stdout: "", stderr: "sudo: not found" } : { code: 0, stdout: "/usr/bin/sudo\n", stderr: "" });
      }
      if (!args[1]?.includes("umask 077") || !args[1]?.includes("set -C")) throw new Error("fallback staging write is not private and exclusive");
      const destination = /ln -T -- "\$temporary" '([^']+)'/.exec(args[1])?.[1];
      if (destination === undefined) throw new Error("fallback staging destination is missing");
      stage(destination, typeof execOptions?.input === "string" ? execOptions.input : "");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command === "chown") {
      const owner = args[0] ?? "";
      const target = args[1] ?? "";
      events.push(`chown:${owner}:${target}`);
      if (options.fail === "chown") return finish({ code: 1, stdout: "", stderr: "chown: operation not permitted" });
      const entry = files.get(target);
      if (entry !== undefined) entry.owner = owner;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command === "mv") {
      const source = args[args.length - 2] ?? "";
      const destination = args[args.length - 1] ?? "";
      events.push(`mv:${source}=>${destination}`);
      if (options.fail === "mv") return finish({ code: 1, stdout: "", stderr: "mv: cannot move" });
      const entry = files.get(source);
      if (entry !== undefined) {
        files.set(destination, entry);
        files.delete(source);
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command === "rm") {
      files.delete(args[args.length - 1] ?? "");
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  }

  const ctx = {
    settings: { dataDir: "/srv/openclaw/data", backupDir: "/srv/openclaw/backups", snapshotDir: "/srv/openclaw/snapshots", env: {} },
    transport: {
      description: "secrets-stub",
      async exists(path: string): Promise<boolean> {
        return files.has(path) || path === "/srv/openclaw/data" || path === "/srv/openclaw/data/config";
      },
      async readFile(path: string): Promise<string> {
        return files.get(path)?.content ?? "";
      },
      // The non-private write, as the real transports behave: content lands at the process
      // umask and the chmod follows. The failure models an interrupted tee — the half file
      // an in-place update leaves behind as the only copy of the keys.
      async writeFile(path: string, content: string, mode?: string): Promise<void> {
        events.push(`write:${path}`);
        files.set(path, {
          content: options.fail === "write" ? content.slice(0, Math.ceil(content.length / 2)) : content,
          mode: "644",
          owner: "runner",
        });
        if (mode !== undefined) {
          events.push(`chmod:${path}:${mode}`);
          const entry = files.get(path);
          if (entry !== undefined) entry.mode = mode;
        }
        if (options.fail === "write") throw new Error("tee interrupted");
      },
      ...(options.privateFile === false
        ? {}
        : {
            async writePrivateFile(path: string, content: string): Promise<void> {
              stage(path, content);
            },
          }),
      async exec(command: string, args: string[], execOptions?: { input?: string | Uint8Array; allowFailure?: boolean }): Promise<ExecResult> {
        return execStub(command, args, execOptions);
      },
    },
    runtime: { async isRunning(): Promise<boolean> { return false; } },
  } as unknown as Context;
  return { ctx, files, events, sudoCalls, output };
}

async function runLoadSecrets(scenario: ReturnType<typeof secretsScenario>): Promise<boolean> {
  modelMutationGuard(scenario.ctx);
  let threw = false;
  try {
    await withOutputSink((line) => scenario.output.push(line), () => loadSecrets(scenario.ctx, SECRETS_UPDATED));
  } catch {
    threw = true;
  }
  return threw;
}

for (const privateFile of [true, false]) {
  const label = privateFile ? "capability" : "fallback";
  const scenario = secretsScenario({ privateFile });
  const threw = await runLoadSecrets(scenario);
  const stageEvent = scenario.events.find((event) => event.startsWith("stage:0600:")) ?? "";
  const stagedPath = stageEvent.slice("stage:0600:".length);
  const mvEvents = scenario.events.filter((event) => event.startsWith("mv:"));
  // Exact equality: the staging path has the final path as a prefix, so startsWith
  // would count the staging write itself as a direct write to the final path.
  const directWrites = scenario.events.filter((event) => event === `write:${SECRETS_FINAL}` || event === `stage:0600:${SECRETS_FINAL}`);
  const chownIndex = scenario.events.indexOf(`chown:1000:1000:${stagedPath}`);
  const mvIndex = scenario.events.indexOf(`mv:${stagedPath}=>${SECRETS_FINAL}`);
  check(`secrets (${label}) install without failing`, threw, false);
  check(`secrets (${label}) stage the content once, owner-only from creation`, stageEvent.startsWith("stage:0600:"), true);
  check(`secrets (${label}) reach the final path only by rename, never a direct write`, directWrites.length, 0);
  check(`secrets (${label}) publish with a single rename onto the final path`, mvEvents.length === 1 && mvEvents[0] === `mv:${stagedPath}=>${SECRETS_FINAL}`, true);
  check(`secrets (${label}) never chmod the staging path down from 600`, scenario.events.some((event) => event === `chmod:${stagedPath}:600`), false);
  check(`secrets (${label}) set owner 1000:1000 on the staging file before publication`, chownIndex > -1 && chownIndex < mvIndex, true);
  check(`secrets (${label}) install the updated content at the final path`, scenario.files.get(SECRETS_FINAL)?.content, SECRETS_UPDATED);
  check(`secrets (${label}) publish owner-only and owned by the gateway user`, `${scenario.files.get(SECRETS_FINAL)?.mode} ${scenario.files.get(SECRETS_FINAL)?.owner}`, "600 1000:1000");
  check(`secrets (${label}) leave no staging file behind`, [...scenario.files.keys()].filter((path) => path !== SECRETS_FINAL).length, 0);
  check(`secrets (${label}) still report the variable count`, scenario.output.join("").includes(`installed ${SECRETS_FINAL} (2 variable(s))`), true);
}

for (const fail of ["write", "chown", "mv"] as SecretFailure[]) {
  const scenario = secretsScenario({ fail });
  const threw = await runLoadSecrets(scenario);
  const previous = JSON.stringify({ content: SECRETS_PREVIOUS, mode: "600", owner: "1000:1000" });
  check(`secrets (${fail} failure) propagate the failure`, threw, true);
  check(`secrets (${fail} failure) leave the previous keys byte-for-byte intact`, JSON.stringify(scenario.files.get(SECRETS_FINAL)), previous);
  check(`secrets (${fail} failure) leave no file at the final path that is not the previous one`, [...scenario.files.keys()].filter((path) => path !== SECRETS_FINAL).length, 0);
  check(`secrets (${fail} failure) leave no staging file behind`, [...scenario.files.keys()].length, 1);
}

// --- owning the staging file is not the right to hand it to another uid -------------------
//
// chown 1000:1000 is a privileged operation whenever the current identity is not 1000:1000,
// no matter who owns the file being handed over — POSIX lets an owner keep or drop their own
// uid, never give the file away. The writability probe answers "can I write the file I just
// created" and always says yes here, so the escalation decision must compare the target
// owner against the current identity instead (the datadir.ts pattern).

{
  const scenario = secretsScenario({});
  const threw = await runLoadSecrets(scenario);
  check("a runner whose own identity is the gateway's chowns without escalating", scenario.sudoCalls.length, 0);
  check("that install still succeeds", threw, false);
  check("the owner still ends 1000:1000", scenario.files.get(SECRETS_FINAL)?.owner, "1000:1000");
}

{
  const scenario = secretsScenario({ identity: "1001:1001" });
  const threw = await runLoadSecrets(scenario);
  const stageEvent = scenario.events.find((event) => event.startsWith("stage:0600:")) ?? "";
  const stagedPath = stageEvent.slice("stage:0600:".length);
  const chownIndex = scenario.events.indexOf(`chown:1000:1000:${stagedPath}`);
  const mvEvents = scenario.events.filter((event) => event.startsWith("mv:"));
  check("another identity makes exactly one sudo call", scenario.sudoCalls.length, 1);
  check(
    "that sudo call wraps the real chown to the gateway's owner",
    scenario.sudoCalls[0]?.includes("chown") === true && scenario.sudoCalls[0]?.includes("1000:1000") === true,
    true,
  );
  check("the escalated install still succeeds", threw, false);
  check("the final file is owned by the gateway user", scenario.files.get(SECRETS_FINAL)?.owner, "1000:1000");
  check(
    "the chown still precedes the single rename",
    mvEvents.length === 1 && chownIndex > -1 && chownIndex < scenario.events.indexOf(mvEvents[0] ?? ""),
    true,
  );
}

{
  const scenario = secretsScenario({ identity: "1001:1001", noSudo: true });
  const threw = await runLoadSecrets(scenario);
  check("the install is refused when sudo is unavailable", threw, true);
  check("the refusal leaves the previous keys byte-for-byte intact", JSON.stringify(scenario.files.get(SECRETS_FINAL)), JSON.stringify({ content: SECRETS_PREVIOUS, mode: "600", owner: "1000:1000" }));
  check("the refusal leaves no file at the final path that is not the previous one", [...scenario.files.keys()].filter((path) => path !== SECRETS_FINAL).length, 0);
  check("the refusal publishes nothing, not even a rename", scenario.events.some((event) => event.startsWith("mv:")), false);
}

finish("state secrets");

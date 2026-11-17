// Target files a restore left owned by the runtime (uid 1000), reached by some other operator.
//
// Publication: staging, renaming and unlinking a private target file write its DIRECTORY, not the file. An
// operator who is the runtime owner (uid 1000) publishing into a directory only root may write
// used to stage through sudo, chown the staging file to itself, then — asked again per step
// whether the now self-owned staging file was writable — rename and clean up without sudo: both
// failed, and the staging copy of the secret stayed behind. Modelled filesystem: owner and
// directory write bits only, `sudo -n` runs as root.
//
// Reading: the secrets preflight reads the target .env through `sudo -n` only when this user
// really may not read it, and refuses in terms of the read when it cannot escalate.

import { posix } from "node:path";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult, Transport } from "#framework/runtime/transport/transport.ts";
import { publishPrivateTargetFile } from "#framework/security/privacy/private-target-file.ts";
import { statusForRequirements, type SecretRequirement } from "#framework/service/secrets.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { asDirectTest } from "#checks/kit/deployment-fixture.ts";

interface Scenario {
  readonly name: string;
  readonly operator: string;
  readonly directoryWritable: boolean;
  readonly existing: boolean;
}

async function run(scenario: Scenario): Promise<{ error?: string; files: Map<string, { owner: string; content: string }>; sudoProbes: number }> {
  const directory = "/srv/app/data/config";
  const path = `${directory}/openclaw.json`;
  const files = new Map<string, { owner: string; content: string }>();
  let sudoProbes = 0;
  if (scenario.existing) files.set(path, { owner: "1000", content: "before" });
  const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
  const denied = (what: string): ExecResult => ({ code: 1, stdout: "", stderr: `${what}: Permission denied` });
  const canWriteDirectory = (user: string): boolean => user === "0" || scenario.directoryWritable;

  const execAs = (user: string, rawCommand: string, rawArgs: string[], input: string | undefined): ExecResult => {
    const { command, args } = asDirectTest(rawCommand, rawArgs);
    if (command === "sudo" && args[0] === "-n") return args[1] === "true" ? ok() : execAs("0", args[1] as string, args.slice(2), input);
    if (command === "id") return ok(`${scenario.operator}\n`);
    if (command === "test" && args[0] === "-w") {
      const target = args[1] as string;
      const file = files.get(target);
      const writable = target === directory ? canWriteDirectory(user) : file !== undefined && (user === "0" || file.owner === user);
      return writable ? ok() : { code: 1, stdout: "", stderr: "" };
    }
    if (command === "sh" && args[1] === "command -v sudo") return ok("/usr/bin/sudo\n");
    if (command === "sh") {
      const staging = /ln -T -- "\$temporary" '([^']+)'/.exec(args[1] as string)?.[1];
      if (staging === undefined) throw new Error(`unmodelled sh: ${args[1]}`);
      if (!canWriteDirectory(user)) return denied(staging);
      files.set(staging, { owner: user, content: input ?? "" });
      return ok();
    }
    if (command === "chown") {
      const file = files.get(args[1] as string);
      if (file === undefined) return denied(args[1] as string);
      if (user !== "0" && file.owner !== user) return denied(args[1] as string);
      file.owner = (args[0] as string).split(":")[0] as string;
      return ok();
    }
    if (command === "mv") {
      const [from, to] = args.slice(-2) as [string, string];
      if (!canWriteDirectory(user)) return denied(to);
      files.set(to, files.get(from) as { owner: string; content: string });
      files.delete(from);
      return ok();
    }
    if (command === "rm") {
      const target = args.at(-1) as string;
      if (!canWriteDirectory(user)) return denied(target);
      files.delete(target);
      return ok();
    }
    throw new Error(`unmodelled command: ${command} ${args.join(" ")}`);
  };

  const transport = {
    description: "modelled",
    async exists(target: string) { return target === directory || posix.dirname(target) === "/" || directory.startsWith(`${target}/`) || files.has(target); },
    async exec(command: string, args: string[], options: { input?: string; allowFailure?: boolean } = {}) {
      if ((command === "sh" && args[1] === "command -v sudo") || (command === "sudo" && args[1] === "true")) sudoProbes += 1;
      const result = execAs(scenario.operator, command, args, options.input);
      if (result.code !== 0 && options.allowFailure !== true) throw new Error(`${command} failed: ${result.stderr}`);
      return result;
    },
  } as unknown as Transport;
  try {
    await publishPrivateTargetFile({ transport } as Context, path, "after");
    return { files, sudoProbes };
  } catch (error) {
    return { error: (error as Error).message, files, sudoProbes };
  }
}

const scenarios: Scenario[] = [
  { name: "owner operator, root-only directory, no file yet", operator: "1000", directoryWritable: false, existing: false },
  { name: "owner operator, root-only directory, file present", operator: "1000", directoryWritable: false, existing: true },
  { name: "other operator, root-only directory", operator: "1001", directoryWritable: false, existing: true },
  { name: "owner operator, own directory", operator: "1000", directoryWritable: true, existing: true },
];

for (const scenario of scenarios) {
  const { error, files, sudoProbes } = await run(scenario);
  check(`${scenario.name}: publication succeeds`, error, undefined);
  check(`${scenario.name}: the file holds the new content, owned by the runtime`, files.get("/srv/app/data/config/openclaw.json"), { owner: "1000", content: "after" });
  check(`${scenario.name}: no staging copy is left behind`, [...files.keys()], ["/srv/app/data/config/openclaw.json"]);
  // Escalated runs probe `command -v sudo` + `sudo -n true` once (2 execs); unescalated ones not at all.
  check(`${scenario.name}: sudo availability is probed at most once per context`, sudoProbes <= 2, true);
}

// --- reading a protected target .env ------------------------------------------------------

interface ReadScenario {
  readonly readable: boolean;
  readonly sudo: "passwordless" | "password" | "absent";
  readonly readFails?: boolean;
}

async function readStatus(scenario: ReadScenario): Promise<{ present?: boolean; error?: string; sudoCat: boolean }> {
  const envPath = "/srv/app/data/config/.env";
  let sudoCat = false;
  const transport = {
    description: "modelled",
    async exists(target: string) { return target === envPath; },
    async readFile(target: string) {
      if (scenario.readFails === true) throw new Error("cat: read error: Input/output error");
      if (!scenario.readable) throw new Error(`cat: ${target}: Permission denied`);
      return "GATEWAY_TOKEN=fixture\n";
    },
    async exec(rawCommand: string, rawArgs: string[]) {
      const { command, args } = asDirectTest(rawCommand, rawArgs);
      if (command === "test" && args[0] === "-r") return { code: scenario.readable ? 0 : 1, stdout: "", stderr: "" };
      if (command === "sh") return { code: scenario.sudo === "absent" ? 1 : 0, stdout: "", stderr: "" };
      if (command === "sudo" && args[1] === "true") return { code: scenario.sudo === "passwordless" ? 0 : 1, stdout: "", stderr: "" };
      if (command === "sudo" && args[1] === "cat") {
        sudoCat = true;
        return { code: 0, stdout: "GATEWAY_TOKEN=fixture\n", stderr: "" };
      }
      throw new Error(`unmodelled command: ${command} ${args.join(" ")}`);
    },
  } as unknown as Transport;
  const needed: SecretRequirement[] = [{ name: "GATEWAY_TOKEN", location: "target-env", usedBy: "gateway.auth.token", required: true }];
  const ctx = { transport, settings: { dataDir: "/srv/app/data", env: {} } } as unknown as Context;
  try {
    const [status] = await statusForRequirements(ctx, needed);
    return { present: status?.present, sudoCat };
  } catch (error) {
    return { error: (error as Error).message, sudoCat };
  }
}

{
  const own = await readStatus({ readable: true, sudo: "absent" });
  check("a readable target .env is read without sudo", own, { present: true, sudoCat: false });

  const protectedEnv = await readStatus({ readable: false, sudo: "passwordless" });
  check("a protected target .env is read through sudo -n", protectedEnv, { present: true, sudoCat: true });

  const noSudo = await readStatus({ readable: false, sudo: "absent" });
  check("without sudo the refusal names the read, not a write", noSudo.error?.includes("is not readable by this user and sudo is not available"), true);
  check("and it never claims the file is not writable", noSudo.error?.includes("not writable"), false);

  const password = await readStatus({ readable: false, sudo: "password" });
  check("a password-asking sudo is named as such", password.error?.includes("sudo asks for a password"), true);

  const broken = await readStatus({ readable: true, sudo: "passwordless", readFails: true });
  check("a readable file that still fails to read reports the real error, no sudo", broken, { error: "cat: read error: Input/output error", sudoCat: false });
}

finish("protected-target-access");

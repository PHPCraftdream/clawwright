// Real separate consumer roots, fake account scheduler; no live cron or Windows tasks.
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchInstall, watchUninstall } from "#framework/commands/operate/watch/install.ts";
import { cronLine, jobMarker, posixTargetInvocation, schedulerIdentity, withScheduleRunner } from "#framework/commands/operate/schedule.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { WslTransport } from "#framework/runtime/transport/wsl.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { stubContext } from "#checks/runtime/convergence/instance-lock/fixture.ts";
import { stubCrontabTransaction } from "#checks/runtime/schedule/fixture.ts";
import type { Context } from "#framework/core/context.ts";
import { check, finish, requires } from "#checks/kit/harness.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
const backupInstall = (ctx: any, args: string[]) => openclawCommands.backup.run(ctx, ["install", ...args]);
const backupUninstall = (ctx: any, args: string[]) => openclawCommands.backup.run(ctx, ["uninstall", ...args]);

const parent = await mkdtemp(join(tmpdir(), "clawwright-scheduler-identity-"));
const firstRoot = join(parent, "team-a", "deployment");
const secondRoot = join(parent, "team-b", "deployment");
const roots = [firstRoot, secondRoot];
const manual = "MAILTO=operator@example.invalid\n\n0 3 * * * /usr/bin/manual-backup\n# manual scheduler note\n";
let table = manual;
const contexts: Context[] = [];
try {
  async function prepareRoot(root: string, index: number): Promise<void> {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "clawwright"), "");
    await writeFile(join(root, ".env"), `OC_COMPOSE_PROJECT=team-${index}\nOC_DATA_DIR=${join(root, "data")}\n`);
    const fixture = stubContext();
    const baseExec = fixture.ctx.transport.exec.bind(fixture.ctx.transport);
    contexts.push({
      ...fixture.ctx,
      settings: { ...fixture.ctx.settings, dataDir: join(root, "data"), remotePath: parent, env: {} },
      runtime: { async isRunning() { return true; } },
      paths: { async toTarget(path: string) { return path; } },
      transport: {
        ...fixture.ctx.transport,
        description: "local",
        clientInvocation: (entry: string, args: string[]) => ({ command: entry, args }),
        async exec(command: string, args: string[]) {
          if (command === "sh" && args[2] === "clawwright-crontab-update") {
            const mutation = stubCrontabTransaction(args, table);
            table = mutation.next;
            return mutation.result;
          }
          return baseExec(command, args);
        },
      },
    } as unknown as Context);
  }
  await prepareRoot(firstRoot, 0);
  await prepareRoot(secondRoot, 1);
  await withOutputSink(() => {}, () => withScheduleRunner(
    async () => { throw new Error("POSIX scenario must not invoke host scheduler"); },
    async () => {
      for (const job of ["backup", "watch"] as const) {
        table = manual;
        const install = job === "backup" ? backupInstall : watchInstall;
        const uninstall = job === "backup" ? backupUninstall : watchUninstall;
        const jobArgs = job === "backup" ? ["backup"] : ["watch", "check"];
        const intervals = job === "backup" ? ["1d", "6h", "12h"] : ["5", "10", "15"];
        const lines: string[] = [];
        for (const index of [0, 1]) {
          useDeployment(roots[index]);
          await install(contexts[index], ["--apply", "--interval", intervals[index]]);
          lines.push(cronLine(index === 0 ? (job === "backup" ? 1440 : 5) : (job === "backup" ? 360 : 10),
            await posixTargetInvocation(contexts[index], jobArgs), job, await schedulerIdentity(contexts[index])));
        }
        check(`${job}: same-basename installs coexist with exact actions`, table, `${manual}${lines[0]}\n${lines[1]}\n`);
        useDeployment(roots[0]);
        await install(contexts[0], ["--apply", "--interval", intervals[2]]);
        const replacement = cronLine(job === "backup" ? 720 : 15, await posixTargetInvocation(contexts[0], jobArgs), job, await schedulerIdentity(contexts[0]));
        check(`${job}: reinstall A preserves B byte-identically`, table, `${manual}${lines[1]}\n${replacement}\n`);
        await uninstall(contexts[0], ["--apply"]);
        check(`${job}: uninstall A preserves B and manual lines byte-identically`, table, `${manual}${lines[1]}\n`);

        const invocation = await posixTargetInvocation(contexts[0], jobArgs);
        const oldA = cronLine(5, invocation, job, "deployment");
        useDeployment(roots[1]);
        const oldB = cronLine(10, await posixTargetInvocation(contexts[1], jobArgs), job, "deployment");
        const ambiguous = `*/5 * * * * echo manual ${jobMarker(job, "deployment")}`;
        table = `${manual}${oldA}\n${oldB}\n${ambiguous}\n`;
        useDeployment(roots[0]);
        await install(contexts[0], ["--apply", "--interval", intervals[2]]);
        check(`${job}: only exact own old invocation is migrated`, table, `${manual}${oldB}\n${ambiguous}\n${replacement}\n`);
        await uninstall(contexts[0], ["--apply"]);
        check(`${job}: legacy other root remains byte-identical`, table, `${manual}${oldB}\n${ambiguous}\n`);
      }
      await requires("posix-host", "SSH operator and target-local derive identical ownership on a POSIX host", async () => {
        useDeployment(roots[0]);
        const canonical = await realpath(roots[0]);
        const operator = {
          ...contexts[0],
          transport: {
            description: "ssh:operator-alias",
            async exec(_command: string, args: string[]) {
              check("SSH resolves the target deployment, not the operator checkout", args[3], join(parent, "apps", "deployment").replaceAll("\\", "/"));
              return { code: 0, stdout: `${canonical}\n`, stderr: "" };
            },
          },
        } as unknown as Context;
        check("SSH operator and target-local derive identical ownership", await schedulerIdentity(operator), await schedulerIdentity(contexts[0]));
      });
    }, "linux",
  ));

  // Windows hosts only ever schedule a WSL target (local is refused there).
  const wsl = new WslTransport("Ubuntu-24.04");
  const winContexts = contexts.map((base) => ({
    ...base,
    paths: { async toTarget(path: string) { return path.replaceAll("\\", "/"); } },
    transport: { ...base.transport, description: "wsl:Ubuntu-24.04", clientInvocation: wsl.clientInvocation.bind(wsl) },
  }) as unknown as Context);
  const tasks = new Map<string, string>();
  const calls: string[][] = [];
  // A pre-key task cannot safely establish root ownership: never overwrite/delete it.
  tasks.set("clawwright-deployment-backup", "ambiguous old task action");
  await withOutputSink(() => {}, () => withScheduleRunner(
    async (_command, args) => {
      calls.push([...args]);
      const name = args[args.indexOf("/tn") + 1];
      if (args[0] === "/create") tasks.set(name, args[args.indexOf("/tr") + 1]);
      else tasks.delete(name);
      return { code: 0, stdout: "", stderr: "" };
    },
    async () => {
      for (const job of ["backup", "watch"] as const) {
        const install = job === "backup" ? backupInstall : watchInstall;
        const uninstall = job === "backup" ? backupUninstall : watchUninstall;
        const names: string[] = [];
        for (const index of [0, 1]) {
          useDeployment(roots[index]);
          await install(winContexts[index], ["--apply"]);
          const call = calls.at(-1)!;
          names.push(call[call.indexOf("/tn") + 1]);
          const action = tasks.get(names[index])!;
          const own = roots[index].replaceAll("\\", "/");
          const other = roots[1 - index].replaceAll("\\", "/");
          check(`${job}: Windows action ${index} binds its own deployment root`, action.includes(own) && !action.includes(other), true);
        }
        check(`${job}: same-basename Windows task names differ`, names[0] !== names[1], true);
        const bAction = tasks.get(names[1]);
        useDeployment(roots[0]);
        await install(winContexts[0], ["--apply"]);
        check(`${job}: Windows reinstall addresses A only`, calls.at(-1)?.[2], names[0]);
        await uninstall(winContexts[0], ["--apply"]);
        check(`${job}: Windows delete addresses A only`, calls.at(-1), ["/delete", "/tn", names[0], "/f"]);
        check(`${job}: Windows B action survives exactly`, tasks.get(names[1]), bAction);
        check(`${job}: Windows A was removed`, tasks.has(names[0]), false);
      }
    }, "win32",
  ));
  check("ambiguous previous Windows task is never touched", tasks.get("clawwright-deployment-backup"), "ambiguous old task action");
} finally {
  await rm(parent, { recursive: true, force: true });
}
finish("scheduler identity");

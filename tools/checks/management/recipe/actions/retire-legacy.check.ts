// The RETIRE end-to-end review fix is covered through its public command surface.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { upsertEnvLine } from "#framework/core/env.ts";
import { createContext, type Context } from "#framework/core/context.ts";
import { executeCommand } from "#framework/core/command/execute.ts";
import { ConfirmationRequiredError } from "#framework/core/command/index.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { recipe } from "#framework/commands/management/recipe/index.ts";
import { buildStack } from "#framework/runtime/docker/side-stack/index.ts";
import { storageHelperScript } from "#framework/runtime/docker/side-stack/storage.ts";
import type { Stack } from "#framework/runtime/runtime.ts";
import type { Transport } from "#framework/runtime/transport/transport.ts";
import { createDeploymentFixture, TRANSPORT_SENTINEL, asDirectTest } from "#checks/kit/deployment-fixture.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { useLinuxHost } from "#checks/foundation/hygiene/linux-host.ts";

useLinuxHost();
const realNow = Date.now.bind(Date);
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;
const root = await mkdtemp(join(tmpdir(), "clawwright-recipe-retire-"));
const fixture = await createDeploymentFixture({ root }).catch(async (error) => { await rm(root, { recursive: true, force: true }); throw error; });
try {
  const envFile = join(root, ".env");
  await writeFile(envFile, upsertEnvLine((await readFile(envFile, "utf8")).replace(/^OC_DATA_DIR=.*$/m, "OC_DATA_DIR=/srv/fixture/data"), "OC_COMPOSE_PROJECT", "recipe-retire-fixture"));
  await writeFile(join(root, "recipes", "local", "recipe.json"), JSON.stringify({ description: "fixture recipe" }));
  const definition = "/srv/fixture/recipes/local/compose.yml";
  const directory = "/srv/fixture/recipes/local";
  let CURRENT = "";
  const LEGACY = "openclaw-recipe-tor-socks5";
  const LEGACY2 = "old-deployment-recipe-local";
  const id = "c".repeat(64), id2 = "d".repeat(64), id3 = "e".repeat(64), id4 = "1".repeat(64);
  const image = `sha256:${"b".repeat(64)}`;
  const altHelper = `sha256:${"a".repeat(64)}`;
  const secret = "fixture-secret-value";
  interface Entry { ns: string; mode: "legacy" | "matched" | "foreign"; state: string; signal?: string; mounts?: unknown[]; imageSignal?: string }
  const entries = new Map<string, Entry>();
  const defaultMounts = (entry: Entry): unknown[] => [
    { Type: "bind", Source: entry.ns === LEGACY ? `/srv/fixture/${secret}-data-legacy` : "/srv/fixture/data-legacy", Destination: "/data", RW: true },
    { Type: "volume", Name: `${entry.ns}_data`, Source: `/var/lib/docker/volumes/${entry.ns}_data/_data`, Destination: "/var/lib", RW: true },
  ];
  const reset = (state = "running"): void => { entries.clear(); entries.set(id, { ns: LEGACY, mode: "legacy", state }); };
  reset();
  let stopFails = false, helperRunFails = false, backupRunFails = false, stopClockAdvance = 0;
  const dockerVerbs: string[][] = [];
  const stopTimeouts: number[] = [];
  const operationLog: string[] = [];
  const journalWrites: { path: string; content: string }[] = [];
  let privateMkdirs = 0;
  const record = (entry: Entry): unknown => ({
    Id: [...entries].find(([, value]) => value === entry)![0], Image: image,
    Mounts: entry.mounts ?? defaultMounts(entry),
    State: { Status: entry.state, ExitCode: 0, OOMKilled: false, Paused: false, Restarting: false, Error: "" },
    Config: { ...(entry.signal === undefined ? {} : { StopSignal: entry.signal }), Env: [`TOKEN=${secret}`], Labels: {
      "com.docker.compose.service": "api", "com.docker.compose.project": entry.ns,
      "com.docker.compose.project.working_dir": directory,
      "com.docker.compose.project.config_files": entry.mode === "foreign" ? "/elsewhere/compose.yml" : definition,
    } },
    HostConfig: { PortBindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "18080" }] } },
  });
  const transport: Transport = {
    description: "retire-fixture",
    async exec(rawCommand, rawArgs, options) {
      const { command, args } = asDirectTest(rawCommand, rawArgs);
      if (command === "sh" && args[2] === "recipe-docker") {
        const docker = args.slice(3);
        if (docker[0] === "stop" && options?.timeoutMs !== undefined) stopTimeouts.push(options.timeoutMs);
        dockerVerbs.push(docker);
        const verb = docker[0]!;
        operationLog.push(`docker:${verb}`);
        const filter = docker.find((argument) => argument.startsWith("label=com.docker.compose.project="));
        if (verb === "ps" && filter !== undefined) {
          const ns = filter.slice("label=com.docker.compose.project=".length);
          const listed = Array.from(entries).filter(([, entry]) => entry.ns === ns);
          return { code: 0, stdout: listed.map(([key]) => key).join("\n") + (listed.length ? "\n" : ""), stderr: "" };
        }
        if (verb === "ps") { operationLog.push("writers:ps"); return { code: 0, stdout: [...entries.keys()].join("\n") + (entries.size ? "\n" : ""), stderr: "" }; }
        if (verb === "inspect") {
          const wanted = docker.slice(1);
          if (wanted.length === 1 && wanted[0] === id) operationLog.push("inspect:stopped");
          if (wanted.includes(id4)) operationLog.push("inspect:writers");
          const found = Array.from(entries).filter(([key]) => wanted.some((want) => key.startsWith(want)));
          if (found.length !== wanted.length) return { code: 1, stdout: "", stderr: TRANSPORT_SENTINEL };
          return { code: 0, stdout: JSON.stringify(found.map(([, entry]) => record(entry))), stderr: "" };
        }
        if (verb === "stop") {
          if (stopFails) return { code: 1, stdout: "", stderr: "stop refused" };
          clockOffset += stopClockAdvance; stopClockAdvance = 0;
          for (const entry of entries.values()) if (entry.ns === LEGACY) entry.state = "exited";
          return { code: 0, stdout: [...entries].filter(([, entry]) => entry.ns === LEGACY).map(([key]) => key).join("\n") + "\n", stderr: "" };
        }
        if (verb === "rm") { for (const [key, entry] of Array.from(entries)) if (entry.ns === LEGACY) entries.delete(key); return { code: 0, stdout: "", stderr: "" }; }
        if (verb === "image" && docker[1] === "inspect") {
          const imageConfig: Record<string, unknown> = {};
          if (entries.get(id)?.imageSignal !== undefined) imageConfig["StopSignal"] = entries.get(id)!.imageSignal;
          return { code: 0, stdout: JSON.stringify([{ Id: docker[2], Config: imageConfig }]), stderr: "" };
        }
        if (verb === "run") {
          const isBackup = docker.some((arg) => arg.includes("dst=/backup"));
          if (isBackup) operationLog.push("backup");
          if (isBackup ? backupRunFails : helperRunFails) return { code: 1, stdout: "", stderr: "helper failed" };
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: `forbidden docker verb: ${verb}` };
      }
      if (command === "sh" && args[2] === "recipe-topology") return { code: 0, stdout: `42:7\n${"f".repeat(64)}  /proc/self/mountinfo\n`, stderr: "" };
      if (command === "sh" && args[2] === "sh") return { code: 0, stdout: "absent", stderr: "" };
      if (command === "test") return { code: 1, stdout: "", stderr: "" };
      if (command === "mkdir") { if (args[0] === "-m") privateMkdirs++; return { code: 0, stdout: "", stderr: "" }; }
      if (["mv", "rm", "chmod", "ln", "cat"].includes(command)) return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: `forbidden exec: ${command} ${args[2] ?? ""}` };
    },
    async readFile() { throw new Error("fixture readFile unused"); },
    async writeFile(path) { journalWrites.push({ path: `writeFile:${path}`, content: "" }); },
    async writePrivateFile(path, content) {
      const textContent = typeof content === "string" ? content : Buffer.from(content).toString("utf8");
      journalWrites.push({ path, content: textContent });
      if (path.endsWith("manifest.json")) operationLog.push("write:manifest");
      else if (path.includes("inspect-")) operationLog.push("write:inspect");
      else if (path.includes("journal-")) operationLog.push(`journal:${(JSON.parse(textContent) as { events: { phase: string }[] }).events.at(-1)?.phase}`);
    },
    async mkdirPrivate() { privateMkdirs++; }, async exists() { return false; }, async mkdirp() {}, async remove() {}, async listFiles() { return []; },
    clientInvocation(entryPath, args) { return { command: entryPath, args }; },
  };
  const base = await createContext({ transport });
  const stackHolder: { stack?: Stack } = {};
  const ctx: Context = { ...base, runtime: { ...base.runtime, stack: (project, definitionPath, ownership) => {
    CURRENT = project;
    const stack = buildStack(transport, { ...base.paths, toTarget: async () => definition }, () => ({ ...base.settings,
      dataDir: "/srv/fixture/data", backupDir: "/srv/fixture/backups", snapshotDir: "/srv/fixture/snapshots" }),
    async (action) => action("/srv/fixture/.env"), project, definitionPath,
    { verifyOwnership: true, ...ownership, legacyProjects: [LEGACY, LEGACY2], recipeName: ownership?.recipeName ?? "local" });
    stackHolder.stack = stack; return stack;
  } } as Context["runtime"] };
  let output = "";
  async function run(argv: string[]): Promise<Record<string, unknown>> {
    output = ""; await withOutputSink((chunk) => { output += chunk; }, () => recipe(ctx, argv));
    const start = output.lastIndexOf("\n{"); return JSON.parse(start < 0 ? output : output.slice(start + 1)) as Record<string, unknown>;
  }
  async function runFailure(argv: string[]): Promise<{ caught: unknown; report: Record<string, unknown> }> {
    output = ""; let caught: unknown;
    try { await withOutputSink((chunk) => { output += chunk; }, () => recipe(ctx, argv)); } catch (error) { caught = error; }
    const start = output.lastIndexOf("\n{");
    return { caught, report: JSON.parse(start < 0 ? output : output.slice(start + 1)) as Record<string, unknown> };
  }
  const errors = (error: unknown): string => error instanceof Error
    ? [error.message, ...(error instanceof AggregateError ? error.errors : [])].map((entry) => entry instanceof Error ? entry.message : String(entry)).join("; ") : String(error);
  const codesOf = (error: unknown): string[] => {
    const collect = (value: unknown): string[] => value === null || typeof value !== "object" ? [] : [
      ...("code" in value && typeof (value as { code?: unknown }).code === "string" ? [(value as { code: string }).code] : []),
      ...(value instanceof AggregateError ? value.errors.flatMap(collect) : []),
    ];
    return collect(error);
  };
  async function refuse(argv: string[], code: string, label: string): Promise<void> {
    for (const extra of [[], ["--apply"]]) {
      let error: unknown;
      try { await withOutputSink(() => {}, () => recipe(ctx, [...argv, ...extra])); } catch (caught) { error = caught; }
      checkTrue(`${label} refuses (${extra.length ? "apply" : "preview"})`, error !== undefined);
      check(`${label} ${extra.length ? "apply" : "preview"} refusal code`, codesOf(error), [code]);
      check(`${label} ${extra.length ? "apply" : "preview"} removal never starts`, dockerVerbs.some((verb) => verb[0] === "rm" || verb[0] === "stop"), false);
    }
  }
  const preview = await run(["retire-legacy", "local"]);
  check("preview announces the retire operation", preview.operation, "retire-owned-legacy-stack");
  check("preview names the legacy project", preview.legacyProject, LEGACY);
  check("preview is a dry run", preview.dryRun, true);
  check("preview names the helper image", preview.helperImage, image);
  const containers = preview.containers as Record<string, unknown>[];
  check("preview inventories the legacy container", containers.map((c) => [c.provenance, c.service, c.state]), [["legacy", "api", "running"]]);
  check("preview carries provenance, project and image identity", [containers[0]!.project, containers[0]!.id, containers[0]!.imageId], [LEGACY, id, image]);
  const previewMounts = containers[0]!.mounts as Record<string, unknown>[];
  check("preview lists bind path and named volume", previewMounts.map((m) => [m.type, m.writable]), [["bind", true], ["volume", true]]);
  check("preview names the legacy volume", previewMounts[1]!.name, `${LEGACY}_data`);
  check("preview plans the strict operation order", (preview.operations as string[]).length, 5);
  check("preview promises containers-only removal", [preview.removesContainersOnly, preview.removesVolumes, preview.removesImages, preview.touchesRecipeDataDirectory], [true, false, false, false]);
  check("preview retains images and backup location", [(preview.retainedImages as Record<string, unknown>[])[0]!.imageId, typeof preview.backupRoot], [image, "string"]);
  check("preview builds and pulls nothing", [preview.build, preview.pull, preview.runsHooks], [false, false, false]);
  checkTrue("preview hides observed env values", !output.includes(secret));
  checkTrue("preview runs helper probes without stop/remove", dockerVerbs.some((verb) => verb[0] === "run") && dockerVerbs.every((verb) => !["stop", "rm"].includes(verb[0]!)));
  check("preview creates no recovery directory", privateMkdirs, 0);
  check("preview writes no journal", journalWrites, []);

  dockerVerbs.length = 0; entries.clear();
  await refuse(["retire-legacy", "local"], "retire-legacy.no-legacy", "absent legacy namespace");
  entries.set(id, { ns: LEGACY, mode: "legacy", state: "running" }); entries.set(id3, { ns: CURRENT, mode: "matched", state: "running" });
  await refuse(["retire-legacy", "local"], "retire-legacy.namespace-populated", "populated target namespace");
  entries.delete(id3); entries.set(id2, { ns: LEGACY2, mode: "legacy", state: "running" });
  await refuse(["retire-legacy", "local"], "retire-legacy.multiple-legacy", "second legacy namespace");
  entries.delete(id2); entries.get(id)!.mode = "foreign";
  await refuse(["retire-legacy", "local"], "retire-legacy.ownership-unproven", "foreign provenance");
  entries.get(id)!.mode = "legacy";

  const writerCases = [
    { label: "pre-stop volume writer", mount: { Type: "volume", Name: `${LEGACY}_data`, Source: `/var/lib/docker/volumes/${LEGACY}_data/_data`, Destination: "/x", RW: true } },
    { label: "pre-stop overlapping bind writer", mount: { Type: "bind", Source: `/srv/fixture/${secret}-data-legacy/child`, Destination: "/x", RW: true } },
  ];
  for (const item of writerCases) {
    reset(); entries.set(id4, { ns: "side-project", mode: "foreign", state: "running", mounts: [item.mount] }); dockerVerbs.length = 0;
    await refuse(["retire-legacy", "local"], "retire-legacy.writer-conflict", item.label);
  checkTrue(`${item.label} has no stop/remove/backup`, dockerVerbs.every((verb) => verb[0] !== "stop" && verb[0] !== "rm" && !(verb[0] === "run" && verb.some((arg) => arg.includes("dst=/backup")))));
  }
  reset(); entries.get(id)!.signal = "SIGKILL"; dockerVerbs.length = 0;
  await refuse(["retire-legacy", "local"], "retire-legacy.stop-signal-unsupported", "SIGKILL stop signal");
  checkTrue("SIGKILL signal has no mutation", dockerVerbs.every((verb) => !["stop", "rm", "run"].includes(verb[0]!)));
  entries.get(id)!.signal = "9"; dockerVerbs.length = 0;
  await refuse(["retire-legacy", "local"], "retire-legacy.stop-signal-unsupported", "numeric stop signal");
  checkTrue("numeric signal has no mutation", dockerVerbs.every((verb) => !["stop", "rm", "run"].includes(verb[0]!)));
  entries.get(id)!.signal = undefined; entries.get(id)!.imageSignal = "SIGKILL"; dockerVerbs.length = 0;
  await refuse(["retire-legacy", "local"], "retire-legacy.stop-signal-unsupported", "image SIGKILL stop signal");
  checkTrue("image signal has no mutation", dockerVerbs.every((verb) => !["stop", "rm", "run"].includes(verb[0]!)));
  entries.get(id)!.imageSignal = undefined;

  dockerVerbs.length = 0; operationLog.length = 0; journalWrites.length = 0; reset();
  const applied = await run(["retire-legacy", "local", "--apply"]);
  const stop = dockerVerbs.findIndex((verb) => verb[0] === "stop");
  const isolation = dockerVerbs.findIndex((verb, index) => index > stop && verb[0] === "ps" && !verb.includes("--filter"));
  const backup = dockerVerbs.findIndex((verb, index) => index > stop && verb[0] === "run" && verb.some((arg) => arg.includes("dst=/backup")));
  const remove = dockerVerbs.findIndex((verb) => verb[0] === "rm");
  check("apply stops gracefully without forcing", dockerVerbs[stop], ["stop", "--timeout", "-1", id]);
  const startAt = operationLog.lastIndexOf("docker:stop");
  check("recorded operational order", operationLog.slice(startAt).filter((e) => ["docker:stop", "inspect:stopped", "writers:ps", "backup", "write:inspect", "write:manifest", "docker:rm"].includes(e)),
    ["docker:stop", "inspect:stopped", "writers:ps", "inspect:stopped", "backup", "backup", "write:inspect", "write:manifest", "docker:rm"]);
  checkTrue("writer inventory inspect precedes backup", dockerVerbs.slice(isolation + 1, backup).some((verb) => verb[0] === "inspect"));
  checkTrue("apply backs up secret-bearing bind path", dockerVerbs.some((verb) => verb[0] === "run" && verb.some((arg) => arg.includes(`src=/srv/fixture/${secret}-data-legacy`))));
  checkTrue("apply backs up named volume", dockerVerbs.some((verb) => verb[0] === "run" && verb.some((arg) => arg.includes(`src=${LEGACY}_data`))));
  checkTrue("removal is last mutation", dockerVerbs.slice(remove + 1).every((verb) => ["ps", "inspect", "image"].includes(verb[0]!)));
  check("container-only removal", dockerVerbs.filter((verb) => verb[0] === "rm"), [["rm", id]]);
  checkTrue("never touches volumes", dockerVerbs.every((verb) => verb[0] !== "volume"));
  checkTrue("never removes/builds images", dockerVerbs.every((verb) => verb[0] !== "rmi" && !(verb[0] === "image" && verb[1] !== "inspect")));
  checkTrue("never kills or forces", dockerVerbs.every((verb) => verb[0] !== "kill" && !verb.includes("--force")));
  check("private recovery directory created", privateMkdirs > 0, true);
  const journals = journalWrites.filter((write) => write.path.includes(".clawwright-recipe-recovery/"));
  const phases = journals.filter((write) => /journal-\d+\.json$/.test(write.path)).map((write) => (JSON.parse(write.content) as { events: { phase: string }[] }).events.at(-1)!.phase);
  check("journal phases in order", phases, ["prepared", "stopped-verified", "writer-isolation-verified", "backups-verified", "inspect-recorded", "manifest-recorded", "retired"]);
  const manifest = JSON.parse(journals.find((write) => write.path.endsWith("manifest.json"))!.content) as { archives: { archive: string; restoreArgv: string[]; source: string }[]; images: { imageId: string }[] };
  checkTrue("private manifest maps exact restore argv", manifest.archives.every((a) => a.archive.endsWith(".tar") && a.restoreArgv[a.restoreArgv.indexOf("-c") + 1] === storageHelperScript("restore")));
  checkTrue("private inspect retains env, raw mount, identity", (() => {
    const inspect = JSON.parse(journals.find((w) => w.path.includes(`inspect-${id}.json`))!.content) as Record<string, unknown>;
    return (inspect["Config"] as { Env: string[] }).Env.includes(`TOKEN=${secret}`) && (inspect["Mounts"] as { Source: string }[])[0]!.Source.includes(secret)
      && inspect["Id"] === id && inspect["Image"] === image;
  })());
  check("manifest image mapping", manifest.images[0]!.imageId, image);
  check("success reports legacy project", applied.legacyProject, LEGACY);
  const rollback = applied.rollback as { archives: Record<string, unknown>[]; containers: Record<string, unknown>[] };
  const volumeArchives = rollback.archives.filter((a) => a.type === "volume");
  check("exactly one public volume archive", volumeArchives.length, 1);
  checkTrue("public volume restore uses volume-nocopy and exact script", (volumeArchives[0]!.restoreArgv as string[]).some((a) => a.startsWith("type=volume,volume-nocopy,"))
    && (rollback.archives[0]!.restoreArgv as string[])[(rollback.archives[0]!.restoreArgv as string[]).indexOf("-c") + 1] === storageHelperScript("restore"));
  check("public archive source redacts observed secret", rollback.archives[0]!.source, `/srv/fixture/[redacted]-data-legacy`);
  checkTrue("public report hides observed env value", !output.includes(secret));
  checkTrue("success explains private exact command source", rollback.archives.every((a) => a.exactCommandsInPrivateManifest === true));
  const publicContainer = rollback.containers[0] as { id?: string; imageId?: string; envNames?: string[]; ports?: unknown; mounts?: unknown[] } | undefined;
  check("public rollback names each removed container and its retained image", [rollback.containers.length, publicContainer?.id, publicContainer?.imageId], [1, id, image]);
  check("public rollback lists env NAMES only", publicContainer?.envNames, ["TOKEN"]);
  checkTrue("public rollback carries the host port binding", JSON.stringify(publicContainer?.ports ?? null).includes("18080"));
  checkTrue("public rollback carries the container's mounts", Array.isArray(publicContainer?.mounts) && publicContainer!.mounts!.length > 0);

  dockerVerbs.length = 0; journalWrites.length = 0; reset();
  await run(["retire-legacy", "local", "--apply", "--helper-image", altHelper]);
  checkTrue("chosen helper used", dockerVerbs.some((v) => v[0] === "run" && v.includes(altHelper)));
  checkTrue("default image not selected helper", !dockerVerbs.some((v) => v[0] === "run" && v.includes(image)));
  dockerVerbs.length = 0; reset(); await refuse(["retire-legacy", "local", "--helper-image", "nginx:1.25"], "retire-legacy.helper-image-invalid", "unpinned helper image");
  dockerVerbs.length = 0; reset(); helperRunFails = true; await refuse(["retire-legacy", "local", "--helper-image", altHelper], "retire-legacy.helper-capability", "helper without tools"); helperRunFails = false;

  dockerVerbs.length = 0; journalWrites.length = 0; reset(); stopFails = true;
  let stopOutput = "";
  let error: unknown;
  try { await withOutputSink((chunk) => { stopOutput += chunk; }, () => recipe(ctx, ["retire-legacy", "local", "--apply"])); } catch (caught) { error = caught; }
  check("stop-timeout refusal code", codesOf(error), ["retire-legacy.stop-timeout"]);
  checkTrue("stop timeout never removes", dockerVerbs.every((v) => v[0] !== "rm")); stopFails = false;

  const stoppedStillRunning = transport.exec.bind(transport);
  transport.exec = async (command, args, options) => {
    const result = await stoppedStillRunning(command, args, options);
    if (command === "sh" && args[2] === "recipe-docker" && args[3] === "stop") for (const entry of entries.values()) if (entry.ns === LEGACY && entry.state === "exited") entry.state = "running";
    return result;
  };
  reset(); dockerVerbs.length = 0; error = undefined;
  try { await withOutputSink(() => {}, () => recipe(ctx, ["retire-legacy", "local", "--apply"])); } catch (caught) { error = caught; }
  check("still-running refusal code", codesOf(error), ["retire-legacy.stop-unverified"]);
  check("unverified running containers are not claimed stopped", (error as { stoppedContainers?: string[] }).stoppedContainers, []);
  checkTrue("still-running refusal avoids helper/rm after stop", dockerVerbs.slice(dockerVerbs.findIndex((v) => v[0] === "stop") + 1).every((v) => v[0] !== "run" && v[0] !== "rm"));
  transport.exec = stoppedStillRunning;

  const intruderAppears = transport.exec.bind(transport);
  transport.exec = async (command, args, options) => {
    const result = await intruderAppears(command, args, options);
    if (command === "sh" && args[2] === "recipe-docker" && args[3] === "stop") entries.set(id4, { ns: LEGACY, mode: "foreign", state: "exited", mounts: [] });
    return result;
  };
  reset(); dockerVerbs.length = 0; error = undefined;
  try { await withOutputSink(() => {}, () => recipe(ctx, ["retire-legacy", "local", "--apply"])); } catch (caught) { error = caught; }
  transport.exec = intruderAppears; entries.delete(id4);
  check("an unexpected container after stop refuses", codesOf(error), ["retire-legacy.stop-unverified"]);
  check("the unexpected container is never offered for restart", (error as { stoppedContainers?: string[] }).stoppedContainers, [id]);
  checkTrue("an unexpected container avoids helper/rm after stop", dockerVerbs.slice(dockerVerbs.findIndex((v) => v[0] === "stop") + 1).every((v) => v[0] !== "run" && v[0] !== "rm"));

  dockerVerbs.length = 0; reset(); backupRunFails = true;
  const backupFailure = await runFailure(["retire-legacy", "local", "--apply"]); error = backupFailure.caught; backupRunFails = false;
  check("backup refusal code", codesOf(error), ["retire-legacy.backup-failed"]);
  check("backup failure output code", backupFailure.report.code, "retire-legacy.backup-failed");
  check("backup failure output stopped IDs", backupFailure.report.stoppedContainers, [id]);
  check("backup failure output restart argv", backupFailure.report.restartArgv, ["docker", "start", id]);
  check("backup failure output backup root", typeof backupFailure.report.backupRoot, "string");
  checkTrue("backup failure never removes", dockerVerbs.every((v) => v[0] !== "rm"));

  dockerVerbs.length = 0; reset();
  const writerAppears = transport.exec.bind(transport);
  transport.exec = async (command, args, options) => {
    const result = await writerAppears(command, args, options);
    if (command === "sh" && args[2] === "recipe-docker" && args[3] === "stop") entries.set(id4, { ns: "side-project", mode: "foreign", state: "running", mounts: [{ Type: "volume", Name: `${LEGACY}_data`, Source: `/var/lib/docker/volumes/${LEGACY}_data/_data`, Destination: "/var/lib", RW: true }] });
    return result;
  };
  const writerFailure = await runFailure(["retire-legacy", "local", "--apply"]); error = writerFailure.caught;
  transport.exec = writerAppears; entries.delete(id4);
  check("post-stop writer refusal code", codesOf(error), ["retire-legacy.writer-conflict-post-stop"]);
  check("writer failure output code", writerFailure.report.code, "retire-legacy.writer-conflict-post-stop");
  check("writer failure output stopped IDs", writerFailure.report.stoppedContainers, [id]);
  check("writer failure output restart argv", writerFailure.report.restartArgv, ["docker", "start", id]);
  check("writer failure output backup root", typeof writerFailure.report.backupRoot, "string");
  checkTrue("post-stop conflict avoids backup and removal", !dockerVerbs.some((v) => v[0] === "rm" || (v[0] === "run" && v.some((a) => a.includes("dst=/backup")))));

  dockerVerbs.length = 0; reset(); stopClockAdvance = 130_000;
  const timed = await run(["retire-legacy", "local", "--apply"]); stopClockAdvance = 0;
  check("130-second graceful stop succeeds", timed.legacyProject, LEGACY);
  checkTrue("default transport timeout accommodates 130 seconds", stopTimeouts.at(-1)! > 130_000);
  entries.delete(id4);
  const stack = stackHolder.stack!;
  check("after retirement current namespace is not running", await stack.isRunning(), false);
  const afterInspect = await stack.inspect!();
  check("legacy namespace absent", afterInspect.namespaces.find((ns) => ns.project === LEGACY)!.status, "absent");
  check("no unknown inspect results", afterInspect.unknown, []);
  const app = { name: "recipe-retire-fixture", description: "fixture", commands: { recipe: openclawCommands.recipe } };
  const refused = await executeCommand(app, "recipe", { kind: "argv", argv: ["retire-legacy", "local", "--apply"] }, { surface: "mcp", transport: fixture.transport() });
  check("apply stops at pipeline confirmation", refused.stage, "confirm");
  checkTrue("apply requires confirmation", refused.error instanceof ConfirmationRequiredError);
  check("confirmation effect", refused.facts?.effect, "destroy");
  check("unconfirmed apply has no target contacts", fixture.contacts(), []);
  const execution = await executeCommand(app, "recipe", { kind: "argv", argv: ["retire-legacy", "local"] }, { surface: "mcp", transport: fixture.transport() });
  check("preview is read effect", execution.facts?.effect, "read");
  check("preview reaches run", execution.stage, "run");
  checkTrue("preview hides transport detail", !errors(execution.error).includes(TRANSPORT_SENTINEL));
  const contacts = fixture.contacts();
  check("preview contacts shell exec", contacts[0]!.split(" ").slice(0, 2), ["exec", "sh"]);
  checkTrue("preview records Docker read", contacts[0]!.includes("recipe-docker"));
} finally { Date.now = realNow; await fixture.dispose(); }
finish("recipe-retire-legacy");

// `./clawwright upgrade` — resolve the target image to a digest (never moving a shared local
// tag), take a pre-upgrade backup, recreate the gateway, and roll back to the digest it was
// running before on any failure — restoring that backup too when the failure was a migration
// (upstream: exit 78) that may already have changed the data.
//
// Lives here rather than under lifecycle/ or orchestration/: both are already at the
// directory's 7-entry layout cap, and this command's central fact — OPENCLAW_IMAGE — is one
// of the four connection facts this directory otherwise already covers.

import { mkdtemp, writeFile, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { useDeployment, envFile } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";
import { mountPoints } from "#framework/runtime/mounts.ts";
import { toContainerPath, fromContainerPath } from "#framework/core/paths.ts";
import { connectionFactDiffs } from "#framework/commands/operate/recover-env/facts.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { DockerRuntime } from "#framework/runtime/docker/runtime-docker.ts";
import { toSettings, parseEnv } from "#framework/core/env.ts";
import type { Transport, ExecOptions } from "#framework/runtime/transport/transport.ts";
import { asDirectTest } from "#checks/runtime/service/restore/file-test-stub.ts";
import { DATA_DIR, SHARED_TAG, TARGET_DIGEST, PREVIOUS_DIGEST, PINNED_WITH_TAG, PINNED_NO_TAG, makeUpgradeCtx } from "./stub.ts";
import { pinAdviceLine } from "#framework/commands/lifecycle/instance/upgrade.ts";
import { withToolRunner, type ToolRunner } from "#framework/security/privacy/private-file.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";

// pinImageReference (instance/upgrade.ts) writes the deployment's OWN .env on success — a real
// repo-side file, not one ctx.transport can stand in for — so a real temporary deployment
// directory backs this file's checks, cleaned up at the end.
const deploymentDir = await mkdtemp(join(tmpdir(), "clawwright-upgrade-check-"));
useDeployment(deploymentDir);
await writeFile(envFile(), "OC_DATA_DIR=/srv/clawwright/data\nOPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:extended-stable\n", "utf8");

// Every scenario rewrites the real deployment .env through pinImageReference, whose private-file
// plumbing on Windows spawns whoami/icacls (and wsl boundary probes) per write — seconds each,
// dozens of times, and none of it is what any assertion here pins. The product's own check seam
// (withToolRunner) answers those tools deterministically instead; production still gets the real
// spawners, and the DACL the stub saves back satisfies private-file's own verification shape.
const CHECK_SID = "S-1-12-1-1111111111-2222222222-3333333333-4444";
const stubToolRunner: ToolRunner = async (command, args) => {
  const tool = command.split(/[\\/]/).pop() ?? command;
  if (tool === "whoami.exe") return { code: 0, output: `"stub","${CHECK_SID}"\r\n` };
  if (tool === "icacls.exe") {
    if (args.includes("/save")) {
      // Re-anchor at tmpdir: the argv-derived path may not be, but savedAces() always saves directly under tmpdir.
      const savedArg = args[args.indexOf("/save") + 1] ?? "";
      await writeFile(join(tmpdir(), basename(savedArg)), `D:P(A;;FA;;;${CHECK_SID})(A;;FA;;;SY)(A;;FA;;;BA)\r\n`, "utf16le");
    }
    return { code: 0, output: "processed" };
  }
  if (tool === "wsl.exe") {
    if (args[0] === "-l") return { code: 0, output: "" };
    return { code: 1, output: "" };
  }
  return { code: 0, output: "" };
};

await withToolRunner(stubToolRunner, async () => {


  // --- success path ----------------------------------------------------------------------------

  {
    const { ctx, runningDigest } = makeUpgradeCtx("success");
    let failure: unknown;
    await withOutputSink(() => {}, async () => {
      try { await openclawCommands.upgrade.run(ctx, []); } catch (error) { failure = error; }
    });
    check("a healthy upgrade completes without throwing", failure, undefined);
    check("it recreates on the resolved target digest", runningDigest(), TARGET_DIGEST);
  }

  // --- a generic health failure rolls back to the previous digest, without restoring data ------

  const TAGGED_PREVIOUS = `${SHARED_TAG}@${PREVIOUS_DIGEST.split("@")[1]}`;

  {
    await writeFile(envFile(), `OC_DATA_DIR=${DATA_DIR}\nOPENCLAW_IMAGE=${SHARED_TAG}\n`);
    const { ctx, calls, runningDigest } = makeUpgradeCtx("health-fail");
    let failure: unknown;
    await withOutputSink(() => {}, async () => {
      try { await openclawCommands.upgrade.run(ctx, []); } catch (error) { failure = error; }
    });
    check("a health failure is reported as a failure", failure instanceof Error, true);
    // The scenario is about the health gate: the gateway must have been recreated onto the
    // target first, and the reported reason must be the health failure itself.
    check("the failure comes after recreation onto the target", calls.some((call) => call === `recreateWithImage ${TARGET_DIGEST}`), true);
    check("the reported reason is the health failure", failure instanceof Error && failure.message.includes("the service did not become healthy"), true);
    check("it rolls back onto the pinned string, tag and proven digest", runningDigest(), TAGGED_PREVIOUS);
    check("a non-migration failure never restores the backup", calls.some((call) => call.includes("-xzf")), false);
    check("and the rollback recreates on the exact string .env records", calls.includes(`recreateWithImage ${await readFile(envFile(), "utf8").then((content) => parseEnv(content).OPENCLAW_IMAGE)}`), true);
  }

  // --- exit 78 (migration failure) rolls back AND restores the pre-upgrade backup --------------

  {
    await writeFile(envFile(), `OC_DATA_DIR=${DATA_DIR}\nOPENCLAW_IMAGE=${SHARED_TAG}\n`);
    const { ctx, calls, runningDigest } = makeUpgradeCtx("exit78");
    let failure: unknown;
    await withOutputSink(() => {}, async () => {
      try { await openclawCommands.upgrade.run(ctx, []); } catch (error) { failure = error; }
    });
    check("an exit-78 failure is reported as a failure", failure instanceof Error, true);
    check("the reported reason names the migration exit", failure instanceof Error && failure.message.includes("78"), true);
    // Compensation restores while stopped before recreating the exact previous digest.
    check("data is restored rather than merely recreated back", calls.some((call) => call.includes("-xzf")), true);
    check("the running digest is not left on the failed target", runningDigest() !== TARGET_DIGEST, true);
  }

  // --- a blocking doctor --lint finding rolls back like any other health failure ---------------

  {
    await writeFile(envFile(), `OC_DATA_DIR=${DATA_DIR}\nOPENCLAW_IMAGE=${SHARED_TAG}\n`);
    const { ctx, runningDigest } = makeUpgradeCtx("doctor-fail");
    let failure: unknown;
    await withOutputSink(() => {}, async () => {
      try { await openclawCommands.upgrade.run(ctx, []); } catch (error) { failure = error; }
    });
    check("a blocking doctor finding fails the upgrade", failure instanceof Error, true);
    check("and rolls back onto the pinned string", runningDigest(), TAGGED_PREVIOUS);
  }

  // --- a failed upgrade's rollback restores the OPENCLAW_IMAGE VALUE (tag + digest, exactly
  // what was validated pre-upgrade), so the next plain upgrade — even --dry-run — re-resolves the
  // channel instead of hitting the tagless-pin refusal. The parsed value is what is compared:
  // upsertEnvLine rewrites the file (LF, no quotes), so the bytes are not byte-identical.

  {
    await writeFile(envFile(), `OC_DATA_DIR=${DATA_DIR}\nOPENCLAW_IMAGE=${PINNED_WITH_TAG}\n`);
    // The container holds Docker's tagless spelling of the pin's own digest — what a healthy
    // bootstrap/upgrade leaves running.
    const { ctx } = makeUpgradeCtx("doctor-fail", { image: PINNED_WITH_TAG, running: PINNED_NO_TAG });
    let failure: unknown;
    await withOutputSink(() => {}, async () => {
      try { await openclawCommands.upgrade.run(ctx, []); } catch (error) { failure = error; }
    });
    check("a failed upgrade over a tagged pin is reported", failure instanceof Error, true);
    check("the rollback restores the exact pre-upgrade pin, tag and digest", parseEnv(await readFile(envFile(), "utf8")).OPENCLAW_IMAGE, PINNED_WITH_TAG);
    let retry: unknown;
    const dryCtx = makeUpgradeCtx("success", { image: PINNED_WITH_TAG }).ctx;
    await withOutputSink(() => {}, async () => {
      try { await openclawCommands.upgrade.run(dryCtx, ["--dry-run"]); } catch (error) { retry = error; }
    });
    check("the next upgrade --dry-run succeeds against the restored pin", retry, undefined);
  }

  // --- a rollback leaves the container and .env on the SAME content: the recreated gateway gets
  // the tagged pre-upgrade reference itself when that is the digest that ran (the recreated
  // container's image IS what Compose reads from OPENCLAW_IMAGE, so a tagless recreate under a
  // tagged pin would leave inspect/doctor reporting ENV_STALE and the next up recreating again);
  // when .env named a bare tag, the pin records that tag alongside the proven digest ----------

  {
    await writeFile(envFile(), `OC_DATA_DIR=${DATA_DIR}\nOPENCLAW_IMAGE=${PINNED_WITH_TAG}\n`);
    // The container carries Docker's own tagless RepoDigests spelling of the same digest.
    const { ctx, calls, runningDigest } = makeUpgradeCtx("doctor-fail", { image: PINNED_WITH_TAG, running: PINNED_NO_TAG });
    await withOutputSink(() => {}, async () => {
      try { await openclawCommands.upgrade.run(ctx, []); } catch { /* the rollback under test */ }
    });
    check("a rollback over a tagged pin recreates the gateway on the tagged reference itself", calls.includes(`recreateWithImage ${PINNED_WITH_TAG}`), true);
    check("the rolled-back container carries the tagged reference, not the tagless form", runningDigest(), PINNED_WITH_TAG);
    const facts = connectionFactDiffs({ image: runningDigest() }, parseEnv(await readFile(envFile(), "utf8")));
    check("inspect's connection-fact comparison sees no divergence after the rollback", facts, []);
  }

  {
    await writeFile(envFile(), `OC_DATA_DIR=${DATA_DIR}\nOPENCLAW_IMAGE=${SHARED_TAG}\n`);
    const { ctx, runningDigest } = makeUpgradeCtx("doctor-fail", { image: SHARED_TAG });
    let failure: unknown;
    await withOutputSink(() => {}, async () => {
      try { await openclawCommands.upgrade.run(ctx, []); } catch (error) { failure = error; }
    });
    check("a rollback over a bare-tag .env still rolls back", failure instanceof Error, true);
    const pinned = parseEnv(await readFile(envFile(), "utf8")).OPENCLAW_IMAGE;
    check("the pin records the tag alongside the digest that was proven", pinned, `${SHARED_TAG}@${PREVIOUS_DIGEST.split("@")[1]}`);
    check("and inspect's comparison still sees no divergence", connectionFactDiffs({ image: runningDigest() }, parseEnv(await readFile(envFile(), "utf8"))), []);
  }

  // --- an explicit --image repo@sha256:… of the tracked repository keeps the deployment's tag,
  // so the success pin stays a channel the next plain upgrade can re-resolve — a tagless digest
  // of a different repository still pins as-is --------------------------------------------

  {
    await writeFile(envFile(), `OC_DATA_DIR=${DATA_DIR}\nOPENCLAW_IMAGE=${PINNED_WITH_TAG}\n`);
    const { ctx } = makeUpgradeCtx("success", { image: PINNED_WITH_TAG });
    let failure: unknown;
    await withOutputSink(() => {}, async () => {
      try { await openclawCommands.upgrade.run(ctx, ["--image", PINNED_NO_TAG]); } catch (error) { failure = error; }
    });
    check("upgrading to a tagless digest of the tracked repository succeeds", failure, undefined);
    check("the success pin keeps the tag alongside the requested digest", parseEnv(await readFile(envFile(), "utf8")).OPENCLAW_IMAGE, PINNED_WITH_TAG);
  }

  // --- upgrade with no --image, after a tag-preserving pin, re-resolves the CHANNEL (`repo:tag`),
  // never the stale digest already sitting in the pin — a moved tag must still be caught, or
  // `upgrade` silently stops doing anything the moment bootstrap/a prior upgrade pins.

  {
    const { ctx, runningDigest } = makeUpgradeCtx("success", { image: PINNED_WITH_TAG });
    let failure: unknown;
    await withOutputSink(() => {}, async () => {
      try { await openclawCommands.upgrade.run(ctx, []); } catch (error) { failure = error; }
    });
    check("upgrading off a tag-preserving pin succeeds", failure, undefined);
    check("it recreates on the newly resolved digest, not the old pin", runningDigest(), TARGET_DIGEST);
  }

  // --- the same check, but the channel's registry digest has not moved — a no-op, not a
  // recreate onto the very reference already running -------------------------------------------

  {
    const { ctx, calls } = makeUpgradeCtx("success", { image: PINNED_WITH_TAG });
    (ctx.runtime as unknown as { resolveImageDigest: (reference: string) => Promise<string> }).resolveImageDigest = async () => PREVIOUS_DIGEST;
    await withOutputSink(() => {}, () => openclawCommands.upgrade.run(ctx, []));
    check("nothing recreates when the channel still resolves to what is running", calls.some((call) => call.startsWith("recreateWithImage")), false);
  }

  // --- a pin from before this fix (digest with no tag) cannot be re-resolved — refused with
  // the one remedy that applies, never guessed -----------------------------------------------

  {
    const { ctx, calls } = makeUpgradeCtx("success", { image: PINNED_NO_TAG });
    let failure: unknown;
    await withOutputSink(() => {}, async () => {
      try { await openclawCommands.upgrade.run(ctx, []); } catch (error) { failure = error; }
    });
    check("an untagged pin refuses rather than guessing a channel", failure instanceof Error, true);
    check("the refusal names the remedy", failure instanceof Error && failure.message.includes("--image"), true);
    check("and nothing recreates", calls.some((call) => call.startsWith("recreateWithImage")), false);
  }

  // Exercise the real DockerRuntime and Compose environment selection, with only the
  // transport standing in for Docker/the target filesystem. Backup uses the same POSIX
  // fixture as above; neither runOneOff nor recreateWithImage is independently mocked.
  type DockerScenario = "success" | "reject-b" | "cleanup" | "validator" | "pin" | "rollback" | "backup" | "prepare" | "migration-exception" | "identity";

  async function dockerUpgradeScenario(scenario: DockerScenario): Promise<void> {
    await writeFile(envFile(), `OC_DATA_DIR=${DATA_DIR}\nOPENCLAW_IMAGE=${PREVIOUS_DIGEST}\n`);
    const { ctx } = makeUpgradeCtx("success");
    const delegate = ctx.transport;
    const envFiles = new Map<string, string>();
    const recreations: string[] = [];
    const doctors: string[] = [];
    let running = PREVIOUS_DIGEST;
    let cleanupFailure = false;
    let pinFileHidden = false;
    let doctorDone = false;
    let restored = false;
    const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
    const settings = toSettings(parseEnv(await readFile(envFile(), "utf8")));
    // The success pin keeps the deployment's tag alongside the requested digest, so the
    // recreated container's image is that tagged string, not the tagless --image argument.
    const pinnedTarget = `${SHARED_TAG}@${TARGET_DIGEST.split("@")[1]}`;
    const transport = {
      ...delegate,
      async listFiles(): Promise<string[]> { return []; },
      async writeFile(path: string, content: string | Uint8Array): Promise<void> {
        envFiles.set(path, typeof content === "string" ? content : Buffer.from(content).toString("utf8"));
        if (scenario === "prepare" && path.endsWith("compose.env") && envFiles.get(path)?.includes(TARGET_DIGEST.split("@")[1])) {
          throw new Error("target environment write denied");
        }
      },
      async remove(path: string): Promise<void> {
        if (path.includes("/compose-") && cleanupFailure) {
          cleanupFailure = false;
          throw new Error("target env cleanup denied");
        }
      },
      async exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult> {
        if (command === "curl") {
          if (running === pinnedTarget && scenario === "migration-exception") throw new Error("probe transport lost");
          return ok("200");
        }
        if (command === "docker") {
          if (args[0] === "buildx" && args[1] === "imagetools" && args[2] === "inspect") {
            return ok(`Digest: ${(args[3] ?? "").split("@")[1] ?? ""}`);
          }
          if (args[0] === "ps") return ok("gateway-container");
          if (args[0] === "inspect") {
            if (args.includes("{{.State.ExitCode}}")) return ok(running === pinnedTarget && scenario === "migration-exception" ? "78" : "0");
            return ok(JSON.stringify({ Image: running, State: { Running: true } }));
          }
          if (args[0] === "image") {
            if (doctorDone && running === pinnedTarget && scenario === "pin" && !pinFileHidden) {
              await rename(envFile(), `${envFile()}.saved`);
              pinFileHidden = true;
            }
            return ok(JSON.stringify({ RepoDigests: [doctorDone && scenario === "identity" ? PREVIOUS_DIGEST : running] }));
          }
          if (args[0] === "compose") {
            const envPath = args[args.indexOf("--env-file") + 1] ?? "";
            const image = parseEnv(envFiles.get(envPath) ?? "").OPENCLAW_IMAGE;
            if (args.includes("up")) {
              recreations.push(image);
              if (image === PREVIOUS_DIGEST && recreations.includes(pinnedTarget)) {
                if (scenario === "rollback") throw new Error("previous image recreation denied");
                if (pinFileHidden) {
                  await rename(`${envFile()}.saved`, envFile());
                  pinFileHidden = false;
                }
              }
              running = image;
              if (image === pinnedTarget && scenario === "cleanup") cleanupFailure = true;
              return ok();
            }
            if (args.includes("run")) {
              if (args.includes("backup")) return { code: 1, stdout: "", stderr: "error: unknown command 'backup'" };
              if (args.includes("doctor")) {
                doctors.push(image);
                check(`${scenario}: durable pin stays A throughout doctor`, parseEnv(await readFile(envFile(), "utf8")).OPENCLAW_IMAGE, PREVIOUS_DIGEST);
                doctorDone = true;
                if (scenario === "validator" || scenario === "rollback") throw new Error("validator transport lost");
                const findings = scenario === "reject-b" && image === pinnedTarget ? [{ severity: "error", checkId: "schema", message: "B rejects configuration" }] : [];
                return ok(JSON.stringify({ findings }));
              }
            }
            if (args.includes("ps")) return ok("gateway-container");
            return ok();
          }
        }
        if (command === "tar" && args.includes("-czf") && scenario === "backup") throw new Error("backup archive failed");
        if (command === "tar" && args.includes("-xzf")) restored = true;
        return delegate.exec(command, args, options);
      },
    } as Transport;
    const paths = { ...ctx.paths, async toTarget(path: string): Promise<string> { return path; } };
    const dockerCtx: Context = {
      ...ctx, transport, paths,
      runtime: new DockerRuntime(transport, settings, paths, { service: "gateway", reconcileSettings: async () => settings }),
    };
    let failure: unknown;
    await withOutputSink(() => {}, async () => {
      try { await openclawCommands.upgrade.run(dockerCtx, ["--image", TARGET_DIGEST]); } catch (error) { failure = error; }
    });
    if (scenario === "success") {
      check("Docker success returns without failure", failure, undefined);
      check("Docker success running identity is B", running, pinnedTarget);
      // An explicit --image digest of the tracked repository keeps the deployment's tag in the pin.
      check("Docker success publishes B alongside the deployment's tag", parseEnv(await readFile(envFile(), "utf8")).OPENCLAW_IMAGE, pinnedTarget);
    } else {
      check(`${scenario}: upgrade reports failure`, failure instanceof Error, true);
      check(`${scenario}: B is not durably pinned`, parseEnv(await readFile(envFile(), "utf8")).OPENCLAW_IMAGE, PREVIOUS_DIGEST);
      const expectedReason: Partial<Record<DockerScenario, string>> = {
        "reject-b": "B rejects configuration",
        cleanup: "target env cleanup denied",
        validator: "validator transport lost",
        rollback: "validator transport lost",
        backup: "backup archive failed",
        prepare: "target environment write denied",
        "migration-exception": "probe transport lost",
        identity: "could not confirm the validated gateway",
        pin: "ENOENT",
      };
      check(`${scenario}: original failure is preserved`, failure instanceof Error && failure.message.includes(expectedReason[scenario] ?? ""), true);
      if (scenario === "backup" || scenario === "prepare") {
        check(`${scenario}: no target-image mutation begins before backup/preparation succeeds`, recreations.includes(TARGET_DIGEST), false);
      } else if (scenario === "rollback") {
        check("failed compensation retains both causes", failure instanceof AggregateError && failure.errors.length === 2 && failure.message.includes("validator transport lost") && failure.message.includes("previous image recreation denied"), true);
        check("failed compensation never claims rollback succeeded", failure instanceof Error && failure.message.includes("was rolled back"), false);
      } else {
        check(`${scenario}: exact previous digest is recreated`, recreations.includes(PREVIOUS_DIGEST), true);
        check(`${scenario}: running identity is restored to A`, running, PREVIOUS_DIGEST);
        check(`${scenario}: compensation outcome is reported`, failure instanceof Error && failure.message.includes("was rolled back") && failure.message.includes("pre-upgrade backup:"), true);
      }
    }
    if (doctors.length > 0) check(`${scenario}: actual Compose doctor image is B`, doctors, [pinnedTarget]);
    check(`${scenario}: backup restoration is restricted to migration failure`, restored, scenario === "migration-exception");
  }

  for (const scenario of ["success", "reject-b", "cleanup", "validator", "pin", "rollback", "backup", "prepare", "migration-exception", "identity"] as const) {
    await dockerUpgradeScenario(scenario);
  }

  // Deterministic two-command interleaving using actual DockerRuntime. Docker commands
  // operate on an image/data/filesystem model, not independent runtime method echoes.
  // Native backup deliberately never stops/resumes the gateway in the race witness.
  type PredecessorScenario = "race" | "race-noop" | "same" | "dry" | "unknown" | "stopped" | "unreadable" | "settings" | "migration";
  async function predecessorScenario(scenario: PredecessorScenario): Promise<void> {
    const d0 = `ghcr.io/openclaw/openclaw@sha256:${"0".repeat(64)}`;
    const d1 = `ghcr.io/openclaw/openclaw@sha256:${"1".repeat(64)}`;
    const d2 = `ghcr.io/openclaw/openclaw@sha256:${"2".repeat(64)}`;
    const initialEnv = `OC_DATA_DIR=${DATA_DIR}\nOC_BACKUP_DIR=/srv/clawwright/backups\nOC_TARGET_LOCATION=wsl\nOC_COMPOSE_PROJECT=upgrade-witness\nOPENCLAW_IMAGE=${d0}\n`;
    await writeFile(envFile(), initialEnv);
    let running = d0;
    let data = d0;
    let stopped = false;
    let unknown = false;
    let unreadable = false;
    let imageReads = 0;
    let lockClaims = 0;
    let resumed = 0;
    const snapshots: Array<{ image: string; running: string; data: string }> = [];
    const files = new Map<string, string>([[DATA_DIR, ""], [`${DATA_DIR}/config`, ""]]);
    const archives = new Map<string, string>();
    let stagedData = d0;
    let reached!: () => void;
    let release!: () => void;
    const barrierReached = new Promise<void>((resolve) => { reached = resolve; });
    const barrierRelease = new Promise<void>((resolve) => { release = resolve; });
    const gated = ["race", "race-noop", "unknown", "stopped", "unreadable", "settings"].includes(scenario);
    const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
    const transport: Transport = {
      description: "controlled POSIX Docker target",
      async readFile(path) {
        const value = files.get(path);
        if (value === undefined) throw new Error(`missing ${path}`);
        return value;
      },
      async writeFile(path, content) { files.set(path, typeof content === "string" ? content : Buffer.from(content).toString("utf8")); },
      async exists(path) { return files.has(path); },
      async mkdirp(path) { files.set(path, ""); },
      async remove(path) { for (const entry of files.keys()) if (entry === path || entry.startsWith(`${path}/`)) files.delete(entry); },
      async listFiles() { return []; },
      clientInvocation(entryPath, args) { return { command: "node", args: [entryPath, ...args] }; },
      async exec(rawCommand, rawArgs) {
        // File-test probes arrive as the shell builtin; the rules below key on `test`.
        const { command, args } = asDirectTest(rawCommand, rawArgs);
        if (command === "curl") return ok(stopped ? "000" : "200");
        if (command === "docker") {
          if (args[0] === "buildx" && args[1] === "imagetools" && args[2] === "inspect") {
            return ok(`Digest: ${(args[3] ?? "").split("@")[1] ?? ""}`);
          }
          if (args[0] === "ps") return ok(unknown || (stopped && !args.includes("--all")) ? "" : "gateway-container");
          if (args[0] === "inspect") {
            if (unreadable) throw new Error("current container read unavailable");
            if (args.includes("{{.State.ExitCode}}")) return ok(stopped && running === d2 ? "78" : "0");
            return ok(JSON.stringify({ Image: running, State: { Running: !stopped } }));
          }
          if (args[0] === "image") {
            const observed = running;
            imageReads++;
            if (gated && imageReads === 1) { reached(); await barrierRelease; }
            return ok(JSON.stringify({ RepoDigests: [observed] }));
          }
          if (args[0] === "compose") {
            const image = parseEnv(files.get(args[args.indexOf("--env-file") + 1] ?? "") ?? "").OPENCLAW_IMAGE;
            if (args.includes("up")) {
              resumed++;
              running = image;
              stopped = scenario === "migration" && image === d2;
              if (stopped) data = d2; // Target migrations alter the data before exiting 78.
              else if (image === d1) data = d1;
              return ok();
            }
            if (args.includes("stop") || args.includes("down")) { stopped = true; return ok(); }
            if (args.includes("ps")) return ok(unknown || stopped ? "" : "gateway-container");
            if (args.includes("run")) {
              if (args.includes("backup") && args.includes("create")) {
                snapshots.push({ image, running, data });
                const output = args[args.indexOf("--output") + 1];
                const targetPath = fromContainerPath(output, mountPoints(DATA_DIR));
                files.set(targetPath, "");
                archives.set(targetPath, data);
                return ok(JSON.stringify({ verified: true, archivePath: output }));
              }
              if (args.includes("doctor")) {
                return ok(JSON.stringify({ findings: image === d2 ? [{ severity: "error", checkId: "schema", message: "D2 rejected" }] : [] }));
              }
              return ok(JSON.stringify({ verified: true }));
            }
            return ok();
          }
          return ok();
        }
        if (command === "test") {
          if (args[0] === "-L") return { code: 1, stdout: "", stderr: "" };
          if (args[0] === "-e") return { code: files.has(args[1]) ? 0 : 1, stdout: "", stderr: "" };
          return ok();
        }
        if (command === "readlink") return ok(args.at(-1));
        if (command === "stat") return ok("1000:1000");
        if (command === "ln") {
          const [source, destination] = args;
          if (!files.has(source) || files.has(destination)) return { code: 1, stdout: "", stderr: "link refused" };
          files.set(destination, files.get(source)!);
          return ok();
        }
        if (command === "mkdir") {
          const path = args.at(-1)!;
          if (args.length === 1 && files.has(path)) return { code: 1, stdout: "", stderr: "exists" };
          if (path.endsWith("/operation.lock")) lockClaims++;
          files.set(path, "");
          return ok();
        }
        if (command === "mv") {
          const source = args.at(-2)!;
          const destination = args.at(-1)!;
          if (!files.has(source) || source === destination || destination.startsWith(`${source}/`)) return { code: 1, stdout: "", stderr: "move refused" };
          for (const [path, value] of files) {
            if (path === source || path.startsWith(`${source}/`)) {
              files.delete(path);
              files.set(`${destination}${path.slice(source.length)}`, value);
            }
          }
          if (archives.has(source)) { archives.set(destination, archives.get(source)!); archives.delete(source); }
          return ok();
        }
        if (command === "rm" || command === "rmdir") {
          const root = args.at(-1)!;
          if (command === "rmdir" && [...files.keys()].some((path) => path.startsWith(`${root}/`))) return { code: 1, stdout: "", stderr: "directory not empty" };
          for (const path of files.keys()) if (path === root || path.startsWith(`${root}/`)) files.delete(path);
          return ok();
        }
        if (command === "tar") {
          const archive = args[args.findIndex((arg) => ["-tzf", "-tvzf", "-xzf", "-czf"].includes(arg)) + 1];
          if (args.includes("-tzf")) return ok(archive.includes(".clawwright-native-")
            ? "native/\nnative/payload/posix/home/node/.openclaw/openclaw.json\n"
            : "data/\ndata/config/openclaw.json\n");
          if (args.includes("-xzf")) {
            const destination = args[args.indexOf("-C") + 1];
            if (archive.includes(".clawwright-native-")) {
              stagedData = archives.get(archive)!;
              files.set(`${destination}/native/payload/posix/home/node/.openclaw`, "");
            } else {
              data = archives.get(archive)!;
              files.set(`${destination}/data`, "");
              files.set(`${destination}/data/config`, "");
            }
          }
          if (args.includes("-czf")) { archives.set(archive, stagedData); files.set(archive, ""); }
          return ok();
        }
        // POSIX metadata/read-only discovery: no recipe stacks, no extra live files.
        if (command === "id") return ok("1000");
        if (command === "du") return ok(`4K\t${args.at(-1)}`);
        if (["find", "chmod", "chown"].includes(command)) return ok();
        throw new Error(`unmodelled target command: ${command} ${args.join(" ")}`);
      },
    };
    const paths = {
      async toTarget(path: string) { return path; },
      async toTool(path: string) { return path; },
      toContainer: (path: string) => toContainerPath(path, mountPoints(DATA_DIR)),
      fromContainer: (path: string) => fromContainerPath(path, mountPoints(DATA_DIR)),
    };
    const settings = toSettings(parseEnv(initialEnv));
    const ctx: Context = {
      settings, paths, transport,
      runtime: new DockerRuntime(transport, settings, paths, { service: "gateway", reconcileSettings: async () => toSettings(parseEnv(await readFile(envFile(), "utf8"))) }),
    };
    let failure: unknown;
    let outcome = "";
    const target = scenario === "same" || scenario === "race-noop" ? d0 : d2;
    const a = withOutputSink((chunk) => { outcome += chunk; }, async () => {
      try { await openclawCommands.upgrade.run(ctx, ["--image", target, ...(scenario === "dry" ? ["--dry-run"] : []), "--json"]); }
      catch (error) { failure = error; }
    });
    if (gated) {
      await barrierReached;
      if (scenario === "race" || scenario === "race-noop") {
        // B uses the public command, completes validation/pin and releases the real
        // instance-lock implementation before A receives its captured D0 observation.
        await withOutputSink(() => {}, () => openclawCommands.upgrade.run(ctx, ["--image", d1]));
        check(`${scenario}: B commits actual D1`, running, d1);
        check(`${scenario}: B commits durable D1`, parseEnv(await readFile(envFile(), "utf8")).OPENCLAW_IMAGE, d1);
      } else if (scenario === "unknown") unknown = true;
      else if (scenario === "stopped") stopped = true;
      else if (scenario === "unreadable") unreadable = true;
      else await writeFile(envFile(), `${initialEnv}OPENCLAW_GATEWAY_TOKEN=rotated\n`);
      release();
    }
    await a;
    const report = JSON.parse(outcome) as { ok: boolean; changed: boolean; current?: string; target?: string; pinnedImage?: string; upToDate?: boolean };
    const pin = parseEnv(await readFile(envFile(), "utf8")).OPENCLAW_IMAGE;
    if (scenario === "race" || scenario === "race-noop") {
      check(`${scenario}: stale A refuses before its backup`, failure instanceof Error, true);
      check(`${scenario}: refusal JSON does not claim a mutation`, [report.ok, report.changed], [false, false]);
      check(`${scenario}: only B snapshot exists and belongs to D0`, snapshots, [{ image: d0, running: d0, data: d0 }]);
      check(`${scenario}: no A recreation or classic backup resume`, resumed, 1);
      check(`${scenario}: running predecessor remains committed D1`, running, d1);
      check(`${scenario}: durable predecessor remains committed D1`, pin, d1);
      check(`${scenario}: D1 data remains intact`, data, d1);
    } else if (scenario === "same" || scenario === "dry") {
      check(`${scenario}: read-only outcome succeeds`, failure, undefined);
      check(`${scenario}: no snapshot or recreation`, [snapshots, resumed], [[], 0]);
      check(`${scenario}: actual state and pin stay D0`, [running, pin, data], [d0, d0, d0]);
      check(`${scenario}: only execute no-op takes a lock`, lockClaims, scenario === "same" ? 1 : 0);
      check(`${scenario}: reported observation is truthful`, [report.ok, report.changed, report.current, report.target, report.upToDate], [true, false, d0, target, scenario === "same"]);
      if (scenario === "dry") {
        check("dry: the JSON carries the pin the run would recreate on", report.pinnedImage, target);
        // The text plan names the pin it would recreate on; the JSON document carries the same
        // string, so neither mode can quietly drop the pin the other reports.
        let text = "";
        await withOutputSink((chunk) => { text += chunk; }, () => openclawCommands.upgrade.run(ctx, ["--image", target, "--dry-run"]));
        check("dry: the text plan names the pin the JSON reports", [text.includes(pinAdviceLine(target)), report.pinnedImage], [true, target]);
      }
    } else if (scenario === "migration") {
      check("migration: original exit-78 failure is reported", failure instanceof Error && failure.message.includes("78"), true);
      check("migration: data compensation completes before image compensation", failure instanceof Error && !(failure instanceof AggregateError) && failure.message.includes("was rolled back"), true);
      check("migration: native backup CLI, gateway and data share predecessor", snapshots, [{ image: d0, running: d0, data: d0 }]);
      check("migration: restored data, running image and durable pin share predecessor", [data, running, pin], [d0, d0, d0]);
    } else {
      check(`${scenario}: under-lock refusal preserves failure`, failure instanceof Error, true);
      check(`${scenario}: refusal JSON does not claim a mutation`, [report.ok, report.changed], [false, false]);
      check(`${scenario}: refusal takes no backup or recreation`, [snapshots, resumed], [[], 0]);
      check(`${scenario}: refusal does not publish a pin`, pin, d0);
      check(`${scenario}: refusal preserves image/data`, [running, data], [d0, d0]);
    }
  }
  for (const scenario of ["race", "race-noop", "same", "dry", "unknown", "stopped", "unreadable", "settings", "migration"] as const) {
    await predecessorScenario(scenario);
  }

});

await rm(deploymentDir, { recursive: true, force: true });

finish("upgrade");

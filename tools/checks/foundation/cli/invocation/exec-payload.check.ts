// The payload plumbing of `clawwright cli`/`clawwright exec`: --stdin reads this process's
// stdin and reaches the container command with `input` AND `stream: true` (finite input
// alone would make the transport pipe and swallow the child's output), --file stages a local
// file into the target data directory through publishPrivateTargetFile and replaces the
// exact @file token, and the staged copy is removed on every path out. Every refusal happens
// in prepare, before the pipeline builds any context or transport.

import { EventEmitter } from "node:events";
import { mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cli } from "#framework/commands/interface/cli.ts";
import { exec } from "#framework/commands/interface/exec.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import {
  capturedStdinRefusalMessage, cliFailureHeadline, limitMessage, noFileTokenRefusalMessage,
  PAYLOAD_LIMIT_BYTES, readPayloadFile, readStdinBounded, replaceFileTokens, stagePayload,
  ttyStdinRefusalMessage,
} from "#framework/commands/interface/groups/exec-payload.ts";
import { PRIVATE_STAGING_MARKER } from "#framework/runtime/transport/quoting.ts";
import { spawnLocal, spawnStdio } from "#framework/runtime/transport/exec.ts";
import { execTty } from "#framework/runtime/docker/helper-container.ts";
import { oneOffDisableTty } from "#framework/runtime/docker/compose-operations.ts";
import { OWNER } from "#framework/runtime/files/datadir.ts";
import { missingArtifactRefusal } from "#framework/core/values/plan.ts";
import { DockerRuntime } from "#framework/runtime/docker/runtime-docker.ts";
import { HelperNotRunning } from "#framework/runtime/runtime.ts";
import { executeCommand } from "#framework/core/command/execute.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { CommandFailedError } from "#framework/core/io/log.ts";
import { ArgumentError } from "#framework/core/command/index.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import type { AppDefinition } from "#framework/core/app.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult, Transport } from "#framework/runtime/transport/transport.ts";
import type { Settings } from "#framework/core/env.ts";
import type { PathBridge } from "#framework/core/paths.ts";
import type { Stage } from "#framework/core/command/execute.ts";
import { check, checkTrue, finish, requires } from "#checks/kit/harness.ts";

useDeployment(resolve(monorepoRoot, "apps", "example app"));

// --- fixtures --------------------------------------------------------------------------------------------

// readStdinBounded and prepare read process.stdin directly; Node defines it as a configurable
// getter with no setter, so the check swaps in an EventEmitter-based fake (data/end/destroy)
// via defineProperty and restores the original descriptor — no production seam needed. Every
// assertion that reads the fake (the destroyed flag in particular) runs inside the body,
// while the fake is still swapped in.
const STDIN_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, "stdin")!;

async function withStdin<T>(fake: ReturnType<typeof fakeStdin>, body: () => Promise<T>): Promise<T> {
  Object.defineProperty(process, "stdin", { value: fake, configurable: true, writable: true });
  try {
    return await body();
  } finally {
    Object.defineProperty(process, "stdin", STDIN_DESCRIPTOR);
  }
}

function fakeStdin(chunks: Buffer[], isTTY = false) {
  const stream = new EventEmitter() as EventEmitter & { isTTY: boolean; destroyed: boolean; destroy(): void };
  stream.isTTY = isTTY;
  stream.destroyed = false;
  stream.destroy = (): void => {
    stream.destroyed = true;
  };
  let started = false;
  const listen = stream.on.bind(stream);
  stream.on = ((event: string, listener: never) => {
    if (event === "data" && !started) {
      started = true;
      queueMicrotask(() => {
        for (const chunk of chunks) stream.emit("data", chunk);
        stream.emit("end");
      });
    }
    return listen(event, listener);
  }) as typeof stream.on;
  return stream;
}

const stubSettings = { env: {}, dataDir: "/srv/openclaw/data" } as Settings;

const paths = {
  async toTarget(path: string): Promise<string> {
    return path;
  },
  toContainer(path: string): string {
    return `/container${path}`;
  },
} as unknown as PathBridge;

// Records every runtime method the command touches, so a removal's "even after a failure"
// reads off one log.
function runtimeStub(calls: string[], overrides: {
  execInHelper?: (args: string[], options?: Record<string, unknown>) => Promise<ExecResult>;
  execCommand?: (head: string, tail: string[], options?: Record<string, unknown>) => Promise<ExecResult>;
  isRunning?: () => Promise<boolean>;
  runOneOff?: (args: string[], options?: Record<string, unknown>) => Promise<ExecResult>;
} = {}) {
  return {
    isRunning: async (): Promise<boolean> => {
      calls.push("isRunning");
      return overrides.isRunning ? overrides.isRunning() : true;
    },
    execInHelper: async (_service: string, args: string[], options?: Record<string, unknown>): Promise<ExecResult> => {
      calls.push("execInHelper");
      if (overrides.execInHelper === undefined) throw new HelperNotRunning("cli-helper");
      return overrides.execInHelper(args, options);
    },
    execCommand: async (_service: string, head: string, tail: string[], options?: Record<string, unknown>): Promise<ExecResult> => {
      calls.push("execCommand");
      if (overrides.execCommand === undefined) throw new HelperNotRunning("cli-helper");
      return overrides.execCommand(head, tail, options);
    },
    runOneOff: async (_service: string, args: string[], options?: Record<string, unknown>): Promise<ExecResult> => {
      calls.push("runOneOff");
      return overrides.runOneOff ? overrides.runOneOff(args, options) : { code: 0, stdout: "", stderr: "" };
    },
    waitForHealth: async (): Promise<void> => {},
    helperRunning: async (): Promise<boolean> => false,
    startHelper: async (): Promise<void> => {},
    stopHelper: async (): Promise<void> => {},
  };
}

function ctxWith(calls: string[], transport: Transport, overrides?: Parameters<typeof runtimeStub>[1]): Context {
  return {
    runtime: runtimeStub(calls, overrides),
    settings: stubSettings,
    transport,
    paths,
  } as unknown as Context;
}

// The transport stagePayload's publish path talks to. Directories exist (sudoFor's walk),
// staged files do not; the writability and id probes answer "no escalation needed", so the
// private write, chown and mv all land unprivileged on the recorded log. With
// writePrivateFile absent, publishPrivateTargetFile falls back to the `sh -c` script with the
// bytes on exec's input — recorded too, so either hand is assertable without faking the
// publisher's internals away.
interface TargetLog {
  writes: { path: string; content: Buffer }[];
  removes: string[];
  execs: { command: string; args: string[]; input?: string | Uint8Array }[];
}

function freshLog(): TargetLog {
  return { writes: [], removes: [], execs: [] };
}

function publishTransport(log: TargetLog, withPrivateWrite = true): Transport {
  // Exactly the commands publishPrivateTargetFile/datadir.ts can issue on the unprivileged
  // path (plus `rm` for the failure cleanup): anything else must fail loudly, so a wrong
  // publish sequence can never pass silently.
  const allowed = new Set(["test", "id", "sh", "chown", "mv", "rm"]);
  return {
    description: "stub",
    exists: async (path: string): Promise<boolean> =>
      !path.includes(PRIVATE_STAGING_MARKER) && !path.includes("clawwright-cli-input-"),
    exec: async (command: string, args: string[], options?: { input?: string | Uint8Array }): Promise<ExecResult> => {
      if (!allowed.has(command)) throw new Error(`publishTransport: unexpected command ${command} ${args.join(" ")}`);
      log.execs.push({ command, args, ...(options?.input === undefined ? {} : { input: options.input }) });
      if (command === "test") return { code: 0, stdout: "", stderr: "" };
      if (command === "id") return { code: 0, stdout: "1000\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    ...(withPrivateWrite ? {
      writePrivateFile: async (path: string, content: string | Uint8Array): Promise<void> => {
        log.writes.push({ path, content: Buffer.from(content) });
      },
    } : {}),
    writeFile: async (path: string, content: string | Uint8Array): Promise<void> => {
      log.writes.push({ path, content: Buffer.from(content) });
    },
    remove: async (path: string): Promise<void> => {
      log.removes.push(path);
    },
  } as unknown as Transport;
}

// A contact-logging transport that answers nothing: the pipeline's zero-target-contact
// refusals must leave this log empty (same shape as the neighbouring incident/apply-config
// checks' recording proxies).
function recordingTransport(): { transport: Transport; contacts: string[] } {
  const contacts: string[] = [];
  const transport = new Proxy({ description: "recording" }, {
    get: (target, property) => {
      if (Object.hasOwn(target, property)) return target[property as keyof typeof target];
      if (typeof property === "symbol" || property === "then") return undefined;
      return (...args: unknown[]): never => {
        contacts.push(`${String(property)} ${args.map(String).join(" ")}`);
        throw new Error("recording transport does not answer");
      };
    },
  }) as unknown as Transport;
  return { transport, contacts };
}

// The real command bodies, driven through the ONE pipeline for the refusal cases.
const APP: AppDefinition = {
  name: "exec-payload-fixture",
  description: "fixture",
  commands: { cli: openclawCommands.cli!, exec: openclawCommands.exec! },
};

interface PrepareOutcome {
  stage: Stage;
  error?: unknown;
  contacts: string[];
  stages: Stage[];
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function refusedRun(command: "cli" | "exec", argv: string[]): Promise<PrepareOutcome> {
  const { transport, contacts } = recordingTransport();
  const stages: Stage[] = [];
  const execution = await executeCommand(APP, command, { kind: "argv", argv: [...argv] }, {
    surface: "terminal",
    transport,
    observe: (stage) => stages.push(stage),
  });
  return { stage: execution.stage, error: execution.error, contacts, stages };
}

// --- the three prepare refusal messages are the production symbols themselves: cli.ts/exec.ts
// refuse with exactly these, so the expected operands below cannot drift from production.

// --- --stdin reaches the command's stdin, on the streaming path -------------------------------------------

const PIPED = Buffer.from("piped bytes\n");

{
  // The whole point of --stdin: the bytes piped into this process arrive as the container
  // command's input, and the runtime is told to stream (finite input alone would pipe and
  // accumulate the child's output) — this option pair is the contract both commands hand the
  // runtime (cli.ts/exec.ts run).
  const calls: string[] = [];
  let saw: Record<string, unknown> | undefined;
  await withStdin(fakeStdin([PIPED]), () => cli(ctxWith(calls, publishTransport(freshLog()), {
    execInHelper: async (_args, options) => {
      saw = options;
      return { code: 0, stdout: "", stderr: "" };
    },
  }), ["--stdin", "status"]));
  check("cli delivers --stdin as input with stream: true on the streaming path", saw, { allowFailure: true, input: PIPED.toString(), stream: true });

  let execSaw: Record<string, unknown> | undefined;
  await withStdin(fakeStdin([PIPED]), () => exec(ctxWith([], publishTransport(freshLog()), {
    execCommand: async (_head, _tail, options) => {
      execSaw = options;
      return { code: 0, stdout: "", stderr: "" };
    },
  }), ["--stdin", "curl", "-fsS", "http://x"]));
  check("exec delivers --stdin as input with stream: true on the streaming path", execSaw, { allowFailure: true, input: PIPED.toString(), stream: true });
}

// --- output forwarding over the REAL transport layer -------------------------------------------------------

{
  // Through the actual transport: under a sink streamToTerminal is false, so stdout/stderr
  // stay piped, and stream: true forwards every chunk to the sink (transport/exec.ts) — the
  // exact path a --stdin run takes without a TTY. A trivial child proves both streams arrive
  // and the exit code survives; a failing child proves its diagnostics arrive too.
  const chunks: string[] = [];
  const result = await withOutputSink((chunk) => chunks.push(chunk), () =>
    spawnLocal(process.execPath, ["-e", "process.stdout.write('OUT'); process.stderr.write('ERR')"], { input: "x\n", stream: true, allowFailure: true }));
  check("a streamed child's stdout and stderr both reach the sink", [chunks.join("").includes("OUT"), chunks.join("").includes("ERR")], [true, true]);
  check("a streamed child's exit code is preserved", result.code, 0);

  const failureChunks: string[] = [];
  const failing = await withOutputSink((chunk) => failureChunks.push(chunk), () =>
    spawnLocal(process.execPath, ["-e", "process.stderr.write('why'); process.exit(3)"], { input: "x\n", stream: true, allowFailure: true }));
  check("a failing child's stderr reaches the sink", failureChunks.join("").includes("why"), true);
  check("a failing child's exit code is preserved", failing.code, 3);
}

// --- the spawn stdio decision, as a pure unit ---------------------------------------------------------------

{
  // transport/exec.ts's inline terminal decision, now a pure function: terminal streaming
  // inherits both outputs (stdin piped only when finite input is delivered), everything else
  // is piped. These checks fail against the pre-extraction inline logic.
  check("a terminal run with input pipes stdin and inherits both outputs", spawnStdio(true, true), ["pipe", "inherit", "inherit"]);
  check("a terminal run without input inherits everything", spawnStdio(true, false), ["inherit", "inherit", "inherit"]);
  check("a captured or non-terminal run pipes everything", spawnStdio(false, true), ["pipe", "pipe", "pipe"]);
  check("a captured run without input pipes everything too", spawnStdio(false, false), ["pipe", "pipe", "pipe"]);
}

// --- a command-level failing run reports its own exit code and headline -------------------------------------

{
  // Through cli() with a fake runtime: the failure headline is built by the same production
  // renderer the command uses, and the exit code is the child's own.
  let failure: unknown;
  try {
    await cli(ctxWith([], publishTransport(freshLog()), {
      execInHelper: async () => ({ code: 3, stdout: "O", stderr: "E" }),
    }), ["status"]);
  } catch (error) {
    failure = error;
  }
  checkTrue("a failing cli run throws CommandFailedError with exit code 3",
    failure instanceof CommandFailedError && failure.exitCode === 3);
  check("a failing cli run's headline is the production-rendered one",
    failure instanceof CommandFailedError ? failure.message : failure,
    cliFailureHeadline(["status"], 3));
}

// --- the docker/compose PTY decisions, as pure units ---------------------------------------------------------

{
  // With finite input the docker client's stdin is a pipe: Docker rejects -t against it
  // ("the input device is not a TTY"), and compose run would allocate a PTY against the same
  // pipe. Without input on a terminal both keep today's flags (-t kept, no -T).
  check("docker exec keeps -t on a terminal without input", execTty(true, false), true);
  check("docker exec drops -t when finite input is piped, even on a terminal", execTty(true, true), false);
  check("docker exec never adds -t off a terminal", execTty(false, false), false);
  check("compose run forces -T with finite input even on a terminal", oneOffDisableTty(true, true, false), true);
  check("compose run keeps no -T on a terminal without input", oneOffDisableTty(true, false, false), false);
  check("compose run keeps -T in stdio-protocol mode", oneOffDisableTty(true, false, true), true);
}

// --- runtime-level stream plumbing -------------------------------------------------------------------------

{
  // DockerRuntime.runOneOff forwards the caller's stream flag; without one it derives the
  // old value (stream only when no input is given) — compose-operations.ts runOneOff.
  const seen: { stream?: boolean; input?: string }[] = [];
  const transport = {
    description: "stub",
    async exec(_command: string, _args: string[], options?: { stream?: boolean; input?: string }): Promise<ExecResult> {
      seen.push({ stream: options?.stream, input: options?.input });
      return { code: 0, stdout: "", stderr: "" };
    },
  } as unknown as Transport;
  const runtime = new DockerRuntime({
    ...transport,
    mkdirp: async (): Promise<void> => {},
    writeFile: async (): Promise<void> => {},
    remove: async (): Promise<void> => {},
  } as Transport, stubSettings, paths, { service: "gateway" });

  await runtime.runOneOff("cli", ["status"], { profile: "cli", input: "x\n", stream: true, allowFailure: true });
  check("runOneOff forwards stream: true with the input", seen[0], { stream: true, input: "x\n" });
  await runtime.runOneOff("cli", ["status"], { profile: "cli", input: "x\n", allowFailure: true });
  check("runOneOff without a stream flag keeps the old derived value with input (no streaming)", seen[1], { stream: false, input: "x\n" });
  await runtime.runOneOff("cli", ["status"], { profile: "cli" });
  check("runOneOff without a stream flag and without input streams", seen[2], { stream: true, input: undefined });
}

{
  // Same contract at execCommand, through the helper container's exec — helper-container.ts
  // derives stream from options.stream ?? options.input === undefined off the supervised path.
  const seen: { stream?: boolean; input?: string }[] = [];
  const transport = {
    description: "stub",
    async exec(_command: string, args: string[], options?: { stream?: boolean; input?: string }): Promise<ExecResult> {
      if (args[0] === "compose" || args.some((arg) => arg.startsWith("label=com.docker.compose.service="))) {
        return { code: 0, stdout: "abc123\n", stderr: "" };
      }
      seen.push({ stream: options?.stream, input: options?.input });
      return { code: 0, stdout: "", stderr: "" };
    },
  } as unknown as Transport;
  const runtime = new DockerRuntime(transport, stubSettings, paths, { service: "gateway" });

  await runtime.execCommand!("cli-helper", "curl", ["-fsS", "http://x"], { input: "x\n", stream: true, allowFailure: true });
  check("execCommand forwards stream: true with the input", seen[0], { stream: true, input: "x\n" });
  await runtime.execCommand!("cli-helper", "curl", ["-fsS", "http://x"], { input: "x\n", allowFailure: true });
  check("execCommand without a stream flag keeps the old derived value with input (no streaming)", seen[1], { stream: false, input: "x\n" });
  await runtime.execCommand!("cli-helper", "curl", ["-fsS", "http://x"], { allowFailure: true });
  check("execCommand without a stream flag and without input streams", seen[2], { stream: true, input: undefined });
}

// --- the two stdin refusals, through the real pipeline, before any target contact ----------

{
  // A terminal has no bytes to read; prepare refuses before the pipeline builds any context
  // or transport, so the recording transport never sees a single call.
  const tty = await withStdin(fakeStdin([], true), () => refusedRun("cli", ["--stdin", "status"]));
  check("cli refuses --stdin on a terminal at the prepare stage", tty.stage, "prepare");
  check("the TTY refusal stops the pipeline before context or run", tty.stages, ["parse", "confirm", "prepare"]);
  check("the TTY refusal's message is the prepare message", messageOf(tty.error), ttyStdinRefusalMessage);
  checkTrue("the TTY refusal names the stdin argument", tty.error instanceof ArgumentError && tty.error.argument === "stdin");
  check("the TTY refusal never contacts the target", tty.contacts, []);

  const execTty = await withStdin(fakeStdin([], true), () => refusedRun("exec", ["--stdin", "curl"]));
  check("exec refuses --stdin on a terminal at the prepare stage", execTty.stage, "prepare");
  check("the exec TTY refusal never contacts the target", execTty.contacts, []);
}

{
  // Under a sink stdin carries the MCP protocol itself; --stdin must refuse there too.
  let captured!: PrepareOutcome;
  await withStdin(fakeStdin([PIPED]), () => withOutputSink(() => {}, async () => {
    captured = await refusedRun("cli", ["--stdin", "status"]);
  }));
  check("cli refuses --stdin in captured mode at the prepare stage", captured.stage, "prepare");
  check("the captured refusal stops the pipeline before context or run", captured.stages, ["parse", "confirm", "prepare"]);
  check("the captured refusal's message is the prepare message", messageOf(captured.error), capturedStdinRefusalMessage);
  checkTrue("the captured refusal names the stdin argument", captured.error instanceof ArgumentError && captured.error.argument === "stdin");
  check("the captured refusal never contacts the target", captured.contacts, []);
}

// --- the payload limits ----------------------------------------------------------------------------------

{
  // The bound bites mid-stream (the excess byte arrives, the stream is destroyed) and at
  // lstat time for a file whose size is already known. Plain Errors: the command layer's
  // prepare maps each message into call.refuse.
  let destroyed = false;
  let overLimit: unknown;
  await withStdin(fakeStdin([Buffer.alloc(PAYLOAD_LIMIT_BYTES + 1)]), async () => {
    try {
      await readStdinBounded();
    } catch (error) {
      overLimit = error;
    }
    destroyed = process.stdin.destroyed;
  });
  check("readStdinBounded refuses past the payload limit", overLimit instanceof Error ? overLimit.message : overLimit,
    limitMessage("standard input", PAYLOAD_LIMIT_BYTES + 1));
  check("the refused stdin stream is destroyed, so a bottomless producer stops", destroyed, true);

  const dir = await mkdtemp(join(tmpdir(), "clawwright-exec-payload-"));
  try {
    const big = join(dir, "big.bin");
    const handle = await open(big, "w");
    await handle.truncate(PAYLOAD_LIMIT_BYTES + 1);
    await handle.close();
    let refused: unknown;
    try {
      await readPayloadFile(big);
    } catch (error) {
      refused = error;
    }
    check("readPayloadFile refuses an over-limit file", refused instanceof Error ? refused.message : refused,
      limitMessage(big, PAYLOAD_LIMIT_BYTES + 1));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- --file refusals, through the real pipeline, before any target contact ---------------------------------

{
  const dir = await mkdtemp(join(tmpdir(), "clawwright-exec-payload-"));
  try {
    // --file without the exact @file token: prepare refuses before the file is read — but the
    // file kind's resolve runs BEFORE prepare (spec.ts's preparedPlan resolves kinds first)
    // and rejects an absent file, so the fixture must create the file for this case to reach
    // the no-token refusal rather than the resolver's missing-artifact refusal.
    const payload = join(dir, "payload.bin");
    await writeFile(payload, "payload-bytes");
    const noToken = await refusedRun("cli", ["--file", payload, "config", "get"]);
    check("--file without an @file token is refused at the prepare stage", noToken.stage, "prepare");
    check("the no-token refusal stops the pipeline before context or run", noToken.stages, ["parse", "confirm", "prepare"]);
    check("the no-token refusal's message is the prepare message", messageOf(noToken.error), noFileTokenRefusalMessage);
    checkTrue("the no-token refusal names the file argument", noToken.error instanceof ArgumentError && noToken.error.argument === "file");
    check("the no-token refusal never contacts the target", noToken.contacts, []);

    const missing = await refusedRun("cli", ["--file", join(dir, "absent.bin"), "load", "@file"]);
    check("a missing file is refused at the prepare stage", missing.stage, "prepare");
    // The file kind's resolve refuses here, before prepare — with its own artifact text.
    check("the missing-file refusal is the resolver's own artifact text",
      messageOf(missing.error), missingArtifactRefusal(join(dir, "absent.bin")));
    checkTrue("the missing-file refusal is a file-argument error", missing.error instanceof ArgumentError && missing.error.argument === "file");
    check("the missing-file refusal never contacts the target", missing.contacts, []);

    const directory = await refusedRun("exec", ["--file", dir, "run", "@file"]);
    check("a directory is refused at the prepare stage", directory.stage, "prepare");
    // Same resolver, same text: stat's isFile check reports a directory as a missing artifact.
    check("the directory refusal is the resolver's artifact text too",
      messageOf(directory.error), missingArtifactRefusal(dir));
    checkTrue("the directory refusal is a file-argument error", directory.error instanceof ArgumentError && directory.error.argument === "file");
    check("the directory refusal never contacts the target", directory.contacts, []);

    // A symbolic link is not a plain file, whatever it points at — it resolves fine (stat
    // follows it), so prepare's readPayloadFile lstat check refuses. Asserted inside the gated
    // body so a skip never feeds undefined into an unconditional assertion.
    const payload2 = join(dir, "target.bin");
    await writeFile(payload2, "payload-bytes");
    await requires("symlink", "a symbolic link is refused", async () => {
      const link = join(dir, "link.bin");
      await symlink(payload2, link);
      const smuggled = await refusedRun("cli", ["--file", link, "load", "@file"]);
      checkTrue("a symbolic link is refused at the prepare stage", smuggled.stage === "prepare");
      checkTrue("the symlink refusal names the link", smuggled.error instanceof Error && smuggled.error.message.includes("link.bin"));
      check("the symlink refusal never contacts the target", smuggled.contacts, []);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- --file: staging through publishPrivateTargetFile, @file replacement, removal ---------------------------

{
  const calls: string[] = [];
  const dir = await mkdtemp(join(tmpdir(), "clawwright-exec-payload-"));
  try {
    const payload = join(dir, "payload.bin");
    await writeFile(payload, "payload-bytes");

    // Full cli() runs over the publish path; each run's mv target IS the staged file.
    const stagedRun = async (): Promise<{ stagedPath: string; seenArgs: string[]; log: TargetLog }> => {
      const log = freshLog();
      let seenArgs: string[] = [];
      await cli(ctxWith(calls, publishTransport(log), {
        execInHelper: async (args) => {
          seenArgs = args;
          return { code: 0, stdout: "", stderr: "" };
        },
      }), ["--file", payload, "load", "@file"]);
      const mv = log.execs.filter((entry) => entry.command === "mv").at(-1)!;
      return { stagedPath: mv.args.at(-1)!, seenArgs, log };
    };

    const first = await stagedRun();
    const second = await stagedRun();

    checkTrue("two runs stage under different names", first.stagedPath !== second.stagedPath);
    checkTrue("staged copies live in the data directory's config/ under the cli-input family",
      [first.stagedPath, second.stagedPath].every((path) => path.startsWith(`${stubSettings.dataDir}/config/clawwright-cli-input-`)));
    checkTrue("the private write stages beside the final name with the staging marker",
      [first.log, second.log].every((log) =>
        log.writes.length === 1 && log.writes[0]!.path.startsWith(`${log.execs.filter((e) => e.command === "mv").at(-1)!.args.at(-1)!}${PRIVATE_STAGING_MARKER}`)));
    check("the transport's private write got the payload bytes",
      [first.log.writes[0]!.content, second.log.writes[0]!.content], [Buffer.from("payload-bytes"), Buffer.from("payload-bytes")]);
    // Ownership: the chown names the production OWNER constant, targets the staging sibling
    // writePrivateFile wrote, and precedes the mv that publishes.
    checkTrue("the chown names the runtime owner, targets the staging sibling, and precedes the publish",
      [first.log, second.log].every((log) => {
        const chown = log.execs.find((entry) => entry.command === "chown");
        const mv = log.execs.find((entry) => entry.command === "mv");
        return chown !== undefined && mv !== undefined
          && log.execs.indexOf(chown) < log.execs.indexOf(mv)
          && chown.args[0] === OWNER && chown.args[1] === log.writes[0]!.path;
      }));
    check("the exact @file token is replaced by the staged copy's container path",
      [first.seenArgs, second.seenArgs],
      [first.stagedPath, second.stagedPath].map((path) => ["load", paths.toContainer(path)]));

    // A token merely CONTAINING @file is left alone.
    const partialLog = freshLog();
    let partial: string[] = [];
    await cli(ctxWith(calls, publishTransport(partialLog), {
      execInHelper: async (args) => {
        partial = args;
        return { code: 0, stdout: "", stderr: "" };
      },
    }), ["--file", payload, "load", "x@file", "@file"]);
    const partialStaged = partialLog.execs.filter((entry) => entry.command === "mv").at(-1)!.args.at(-1)!;
    check("a token containing @file is untouched, the exact token replaced", partial,
      ["load", "x@file", paths.toContainer(partialStaged)]);

    // And so is @file without --file: legitimate OpenClaw syntax, nothing staged at all.
    const untouchedLog = freshLog();
    let untouched: string[] = [];
    await cli(ctxWith(calls, publishTransport(untouchedLog), {
      execInHelper: async (args) => {
        untouched = args;
        return { code: 0, stdout: "", stderr: "" };
      },
    }), ["load", "@file"]);
    check("@file without --file is untouched", untouched, ["load", "@file"]);
    check("no staging write and no publish exec without --file",
      [untouchedLog.writes.length, untouchedLog.execs.length], [0, 0]);

    // exec splits head/tail only AFTER replacement; the headline keeps the raw command.
    const execLog = freshLog();
    let tail: string[] = [];
    await exec(ctxWith(calls, publishTransport(execLog), {
      execCommand: async (_head, rest) => {
        tail = rest;
        return { code: 0, stdout: "", stderr: "" };
      },
    }), ["--file", payload, "run", "@file"]);
    const execStaged = execLog.execs.filter((entry) => entry.command === "mv").at(-1)!.args.at(-1)!;
    check("exec replaces @file before the head/tail split", tail, [paths.toContainer(execStaged)]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

{
  // stagePayload directly: the name family, the container path mapping, and removal — and
  // the fallback publish (no writePrivateFile) delivering the bytes through the `sh -c`
  // private-write script's exec input.
  const log = freshLog();
  const staged = await stagePayload(ctxWith([], publishTransport(log)), Buffer.from("payload-bytes"));
  checkTrue("the staged name carries the cli-input family",
    staged.stagedTargetPath.startsWith(`${stubSettings.dataDir}/config/clawwright-cli-input-`));
  checkTrue("the publish renames onto the reported staged path",
    log.execs.some((entry) => entry.command === "mv" && entry.args.at(-1) === staged.stagedTargetPath));
  check("the container path is the bridge's view of the staged path", staged.containerPath, paths.toContainer(staged.stagedTargetPath));
  await staged.remove();
  check("staged.remove() removes the staged copy", log.removes, [staged.stagedTargetPath]);

  const fallbackLog = freshLog();
  const fallback = await stagePayload(ctxWith([], publishTransport(fallbackLog, false)), Buffer.from("fallback-bytes"));
  const write = fallbackLog.execs.find((entry) => entry.command === "sh" && entry.args[0] === "-c");
  checkTrue("the fallback publish runs the private-write shell script", write !== undefined);
  check("the fallback publish delivers the payload bytes on the script's stdin",
    Buffer.from(write!.input!), Buffer.from("fallback-bytes"));
  checkTrue("the fallback rename lands on the reported staged path too",
    fallbackLog.execs.some((entry) => entry.command === "mv" && entry.args.at(-1) === fallback.stagedTargetPath));
}

// --- the staged copy is removed on every path out -----------------------------------------------------------

{
  const dir = await mkdtemp(join(tmpdir(), "clawwright-exec-payload-"));
  try {
    const payload = join(dir, "payload.bin");
    await writeFile(payload, "payload-bytes");
    const stagedPathOf = (log: TargetLog): string => log.execs.filter((entry) => entry.command === "mv").at(-1)!.args.at(-1)!;

    const successLog = freshLog();
    await cli(ctxWith([], publishTransport(successLog), {
      execInHelper: async () => ({ code: 0, stdout: "", stderr: "" }),
    }), ["--file", payload, "load", "@file"]);
    check("a successful command's staged copy is removed", successLog.removes, [stagedPathOf(successLog)]);

    const failingLog = freshLog();
    let failure: unknown;
    try {
      await cli(ctxWith([], publishTransport(failingLog), {
        execInHelper: async () => ({ code: 3, stdout: "", stderr: "" }),
      }), ["--file", payload, "load", "@file"]);
    } catch (error) {
      failure = error;
    }
    check("a failing command reports its own exit code", failure instanceof CommandFailedError && failure.exitCode, 3);
    check("a failing command's staged copy is still removed", failingLog.removes, [stagedPathOf(failingLog)]);

    // The HelperNotRunning → runOneOff fallback removes too — both exits.
    const oneOffLog = freshLog();
    await cli(ctxWith([], publishTransport(oneOffLog), {
      runOneOff: async () => ({ code: 0, stdout: "", stderr: "" }),
    }), ["--file", payload, "load", "@file"]);
    check("the one-off fallback removes the staged copy", oneOffLog.removes, [stagedPathOf(oneOffLog)]);

    const oneOffFailing = freshLog();
    let fallbackFailure: unknown;
    try {
      await cli(ctxWith([], publishTransport(oneOffFailing), {
        runOneOff: async () => ({ code: 2, stdout: "", stderr: "" }),
      }), ["--file", payload, "load", "@file"]);
    } catch (error) {
      fallbackFailure = error;
    }
    check("a failing one-off reports its own exit code", fallbackFailure instanceof CommandFailedError && fallbackFailure.exitCode, 2);
    check("a failing one-off's staged copy is still removed", oneOffFailing.removes, [stagedPathOf(oneOffFailing)]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- the no-flag path is unchanged ---------------------------------------------------------------------------

{
  // Without --stdin/--file the streaming child gets no input option at all, exactly as before
  // the payload plumbing existed.
  let saw: Record<string, unknown> | undefined;
  await cli(ctxWith([], publishTransport(freshLog()), {
    execInHelper: async (_args, options) => {
      saw = options;
      return { code: 0, stdout: "", stderr: "" };
    },
  }), ["status"]);
  check("cli without the flags streams: no input option", saw, { allowFailure: true });

  let execSaw: Record<string, unknown> | undefined;
  await exec(ctxWith([], publishTransport(freshLog()), {
    execCommand: async (_head, _tail, options) => {
      execSaw = options;
      return { code: 0, stdout: "", stderr: "" };
    },
  }), ["curl", "-fsS", "http://127.0.0.1:18789/healthz"]);
  check("exec without the flags streams: no input option", execSaw, { allowFailure: true });
}

// replaceFileTokens is the single substitution rule both commands share: exact tokens only.
check("replaceFileTokens leaves every non-exact token alone",
  replaceFileTokens(["@file", "x@file", "@files", "load"], "/staged"),
  ["/staged", "x@file", "@files", "load"]);

finish("exec-payload");

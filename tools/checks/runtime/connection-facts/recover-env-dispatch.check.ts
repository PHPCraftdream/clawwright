// check:requires docker
// Two reachability holes, driven through the REAL surfaces rather than by calling
// the underlying functions — that is the whole point of the regression:
//
//   (1) the bootstrap order. `./clawwright recover-env` dispatched through the real
//       entry/cli.ts runApp with no OC_DATA_DIR in .env must REACH recovery — its own
//       refusal is the answer, never the settings parser's "OC_DATA_DIR is not set in
//       .env" that every other command still gets. The recovery-first bootstrap is then
//       proven to fill exactly that fact from a stubbed container: two docker calls, no
//       compose anywhere.
//
//   (2) --adopt-runtime over MCP. The tool schema is generated from the shared command
//       declaration, so the flag the parser accepts and the diagnostics recommend has to
//       be declared there: a real serveMcp session lists it in tools/list, accepts it in
//       tools/call where an undeclared argument is still rejected, and the shared
//       declaration alone drives the schema, the validation and the argv.
//
// The control case in the middle pins the boundary the fix must not blur: a command
// WITHOUT the recovery dispatch still dies in the settings parser on the same .env.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runApp } from "#framework/entry/cli.ts";
import { executeCommand } from "#framework/core/command/execute.ts";
import { callFactsFor } from "#framework/core/command/index.ts";
import { operateCommands } from "#framework/commands/interface/groups/openclawCommands.operate.ts";
import { inputSchema } from "#framework/integration/mcp/schema.ts";
import { validate } from "#framework/integration/mcp/legacy.ts";
import { useDeployment, deploymentDir, envFile } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { runningConnectionFactsWithoutContext } from "#framework/commands/operate/recover-env/bootstrap.ts";
import { command } from "#framework/core/io/invocation/advice.ts";
import { DATA_DIR_UNSET, type Env } from "#framework/core/env.ts";
import { UserError } from "#framework/core/io/log.ts";
import { unknownArgumentMessage } from "#framework/core/command/errors.ts";
import { NOT_RUNNING_CAUSE, RECOVERABLE_ONLY_FROM_RUNNING } from "#framework/commands/operate/recover-env/index.ts";
import { unreachableProblem } from "#framework/service/inspection.ts";
import { spawnLocal, TargetReadUnknownError, TransportUnreachableError, type ExecResult, type Transport } from "#framework/runtime/transport/transport.ts";
import type { AppDefinition } from "#framework/core/app.ts";
import { useLinuxHost } from "#checks/foundation/hygiene/linux-host.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

useLinuxHost();

/** Captures a run's output and turns a thrown refusal into its message. The body may be
 *  any runner — runApp resolves to a code, the recovery runners to void. */
async function capture(body: () => Promise<unknown>): Promise<{ output: string; error: string }> {
  let output = "";
  let error = "";
  try {
    await withOutputSink(
      (chunk) => {
        output += chunk;
      },
      body,
    );
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  return { output, error };
}

const TOKEN = "not-a-real-token-check-only-value";

interface InspectAnswer {
  State?: { Running?: boolean };
  Mounts?: { Destination?: string; Source?: string }[];
  NetworkSettings?: { Ports?: Record<string, { HostPort?: string }[]> };
  Config?: { Labels?: Record<string, string>; Image?: string };
}

function goodInspect(): InspectAnswer {
  return {
    State: { Running: true },
    Mounts: [{ Destination: "/home/node/.openclaw", Source: "/srv/data/config" }],
    NetworkSettings: { Ports: { "18789/tcp": [{ HostPort: "18790" }] } },
    Config: {
      Labels: { "com.docker.compose.project": "fresh-project" },
      Image: "ghcr.io/openclaw/openclaw:extended-stable",
    },
  };
}

/** Answers the recovery bootstrap's label-filtered `docker ps` and inspect calls. Anything
 *  else is a failure, which is itself the
 *  assertion that no compose invocation (and no environment file on the target) is needed. */
function recoveryTransport(
  ids = "c0ffee\n",
  inspectAnswers: Record<string, InspectAnswer> = { c0ffee: goodInspect() },
): { transport: Transport; dockerCalls: string[][] } {
  const dockerCalls: string[][] = [];
  const transport = {
    description: "stub",
    async exec(command: string, args: string[]): Promise<ExecResult> {
      if (command !== "docker") throw new Error(`unexpected exec: ${command} ${args.join(" ")}`);
      dockerCalls.push([...args]);
      if (args[0] === "ps") return { code: 0, stdout: ids, stderr: "" };
      if (args[0] === "inspect") {
        const answer = inspectAnswers[args[3] ?? ""];
        return answer === undefined
          ? { code: 1, stdout: "", stderr: "no such container" }
          : { code: 0, stdout: JSON.stringify(answer), stderr: "" };
      }
      throw new Error(`unexpected docker call: ${args.join(" ")}`);
    },
  } as unknown as Transport;
  return { transport, dockerCalls };
}

const previous = (() => {
  try { return deploymentDir(); } catch { return undefined; }
})();
const deployDir = await mkdtemp(join(tmpdir(), "clawwright-recover-env-dispatch-"));
useDeployment(deployDir);

const recoverDeclaration = operateCommands["recover-env"];
const recoverApp: AppDefinition = {
  name: "dispatch-fixture",
  description: "dispatcher fixture",
  service: { name: "gateway" },
  commands: { "recover-env": recoverDeclaration },
};

// .env WITHOUT OC_DATA_DIR — the fact recovery exists to fill, and the fact the settings
// parser dies on. Everything a transport needs is present.
const seedWithoutDataDir = [
  "OC_TARGET_LOCATION=local",
  "OPENCLAW_GATEWAY_PORT=9999",
  `OPENCLAW_GATEWAY_TOKEN=${TOKEN}`,
  "",
].join("\n");

try {
  // --- I14: unknown reads never become definite absence; later facts still win -----------
  {
    type Answer = ExecResult | Error;
    const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });
    const failed: ExecResult = { code: 17, stdout: "", stderr: "failure" };
    async function probe(listing: Answer, inspections: Answer[] = []) {
      let index = 0;
      const transport = {
        async exec(_command: string, args: string[]): Promise<ExecResult> {
          const answer = args[0] === "ps" ? listing : inspections[index++];
          if (answer instanceof Error) throw answer;
          if (answer === undefined) throw new Error("unexpected extra inspection");
          return answer;
        },
      } as unknown as Transport;
      try {
        return { facts: await runningConnectionFactsWithoutContext({ env: {} as Env, transport, service: "gateway" }), error: undefined };
      } catch (error) {
        return { facts: undefined, error };
      }
    }
    const sentinel = new Error("recovery-list-sentinel");
    const listed = await probe(sentinel);
    check("listing sentinel is an unknown read", listed.error instanceof TargetReadUnknownError, true);
    check("listing sentinel retains its cause", listed.error instanceof Error && listed.error.cause === sentinel, true);
    check("listing sentinel retains its message", listed.error instanceof Error ? listed.error.message.split(" ") : [], ["could", "not", "list", "recovery", "containers", "on", "the", "target:", "recovery-list-sentinel"]);
    check("listing unknown carries recovery diagnostic advice", listed.error instanceof UserError ? listed.error.advice.map((step) => ({ kind: step.kind, argv: "argv" in step ? step.argv : undefined })) : [], [{ kind: "clawwright", argv: ["recover-env", "--dry-run"] }]);
    const nonzeroList = await probe(failed);
    check("nonzero listing is unknown", nonzeroList.error instanceof TargetReadUnknownError, true);
    check("nonzero listing message", nonzeroList.error instanceof Error ? nonzeroList.error.message.split(" ") : [], ["could", "not", "list", "recovery", "containers", "on", "the", "target:", "docker", "ps", "exited", "with", "code", "17"]);

    const inspectSentinel = new Error("recovery-inspect-sentinel");
    const inspected = await probe(ok("old\n"), [inspectSentinel]);
    check("inspection sentinel is unknown", inspected.error instanceof TargetReadUnknownError, true);
    check("inspection sentinel retains cause", inspected.error instanceof Error && inspected.error.cause === inspectSentinel, true);
    check("inspection sentinel retains message", inspected.error instanceof Error ? inspected.error.message.split(" ") : [], ["could", "not", "inspect", "recovery", "container", "old", "on", "the", "target:", "recovery-inspect-sentinel"]);
    const nonzeroInspect = await probe(ok("old\n"), [failed]);
    check("nonzero inspection is unknown", nonzeroInspect.error instanceof TargetReadUnknownError, true);
    check("nonzero inspection message", nonzeroInspect.error instanceof Error ? nonzeroInspect.error.message.split(" ") : [], ["could", "not", "inspect", "recovery", "container", "old", "on", "the", "target:", "docker", "inspect", "exited", "with", "code", "17"]);
    const malformed = await probe(ok("old\n"), [ok("{invalid-json-sentinel")]);
    check("malformed JSON is unknown", malformed.error instanceof TargetReadUnknownError, true);
    check("malformed JSON retains parse cause", malformed.error instanceof Error && malformed.error.cause instanceof SyntaxError, true);
    for (const document of ["null", "[]", "{}", '{"State":{"Running":"false"}}']) {
      const result = await probe(ok("old\n"), [ok(document)]);
      check(`malformed structure ${document} is unknown`, result.error instanceof TargetReadUnknownError, true);
      check(`malformed structure ${document} message`, result.error instanceof Error ? result.error.message.split(" ") : [], ["could", "not", "inspect", "recovery", "container", "old", "on", "the", "target:", "malformed", "recovery", "container", "inspection:", "expected", "State.Running", "boolean"]);
      check(`malformed structure ${document} retains cause`, result.error instanceof Error && result.error.cause instanceof Error, true);
    }
    const retained = await probe(ok("old\nlater\n"), [inspectSentinel, failed]);
    check("first inspection unknown is retained", retained.error instanceof Error && retained.error.cause === inspectSentinel, true);
    for (const answer of [inspectSentinel, failed, ok("{invalid-json-sentinel"), ok("{}")]) {
      const result = await probe(ok("old\nlater\n"), [answer, ok(JSON.stringify(goodInspect()))]);
      check("a valid later match supersedes unknown", result.error, undefined);
      check("a valid later match returns literal facts", result.facts, { dataDir: "/srv/data", port: "18790", composeProject: "fresh-project", image: "ghcr.io/openclaw/openclaw:extended-stable" });
    }
    const unreachable = new TransportUnreachableError("recovery-unreachable-sentinel", "check target");
    const advised = new UserError("recovery-advised-sentinel", { advice: [command("status")] });
    for (const refusal of [unreachable, advised]) {
      check("listing preserves typed/advised refusal identity", (await probe(refusal)).error === refusal, true);
      check("inspection preserves typed/advised refusal before later valid match", (await probe(ok("old\nlater\n"), [refusal, ok(JSON.stringify(goodInspect()))])).error === refusal, true);
    }
    for (const result of [await probe(ok("")), await probe(ok("stopped\n"), [ok('{"State":{"Running":false}}')])]) {
      check("definite empty/stopped answer has no error", result.error, undefined);
      check("definite empty/stopped answer has no facts", result.facts, undefined);
    }
    const sparse = await probe(ok("running\n"), [ok('{"State":{"Running":true}}')]);
    check("valid running container without optional facts is not malformed", sparse.error, undefined);
    check("valid running container keeps absent optional facts", sparse.facts, {});
  }

  // --- (1) the real CLI dispatcher reaches recovery with no OC_DATA_DIR -----------------
  {
    await writeFile(envFile(), seedWithoutDataDir, "utf8");
    const { error } = await capture(() => runApp(recoverApp, ["recover-env"]));
    // The seen text goes to stderr beside the assertion, not into it: a host-dependent refusal is shown on failure.
    if (!error.includes(NOT_RUNNING_CAUSE)) process.stderr.write(`recover-env refused with: ${error}\n`);
    check(
      "the dispatcher reached recovery: the refusal is recovery's own, not the settings parser's",
      error.includes(NOT_RUNNING_CAUSE),
      true,
    );
    check("the settings parser's OC_DATA_DIR refusal never appears", error.includes(DATA_DIR_UNSET), false);
    check("a refused recovery leaves .env byte-identical", await readFile(envFile(), "utf8"), seedWithoutDataDir);
  }

  // --- the control: without the recovery dispatch, the same .env dies in the parser ------
  {
    await writeFile(envFile(), seedWithoutDataDir, "utf8");
    const plainApp: AppDefinition = {
      name: "control-fixture",
      description: "control fixture",
      commands: { noop: { summary: "noop", run: async () => {} } },
    };
    const { error } = await capture(() => runApp(plainApp, ["noop"]));
    check("a command without the recovery dispatch still dies on the missing fact", error.includes(DATA_DIR_UNSET), true);
  }

  // --- (1) --help answers before anything is built, from the shared declaration ----------
  {
    const { output, error } = await capture(() => runApp(recoverApp, ["recover-env", "--help"]));
    check("recover-env --help runs without a Context and without error", error, "");
    check("the help lists --adopt-runtime from the shared declaration", output.includes("--adopt-runtime"), true);
    check("the help still lists --dry-run", output.includes("--dry-run"), true);
  }

  // --- (1) the recovery-first bootstrap fills the missing fact from the container --------
  {
    await writeFile(envFile(), seedWithoutDataDir, "utf8");
    const { transport, dockerCalls } = recoveryTransport();
    const { output, error } = await capture(() => executeCommand(recoverApp, "recover-env", { kind: "argv", argv: [] }, { surface: "terminal", transport }));
    check("the bootstrap run succeeds against a stubbed container", error, "");
    const merged = await readFile(envFile(), "utf8");
    check("the missing OC_DATA_DIR is filled from the container", merged.includes("OC_DATA_DIR=/srv/data"), true);
    // OC_COMPOSE_PROJECT is absent here too, but the divergence check compares an absent (or empty) value
    // against its own EFFECTIVE default — the directory-derived project name, exactly as
    // composeProjectName() falls back — rather than the raw string. "fresh-project" is a
    // genuinely different explicit value from that default, so it is diverged, not missing,
    // and a plain run must not silently adopt it any more than the diverged port below.
    check("a compose project genuinely different from the directory default is NOT silently filled", merged.includes("OC_COMPOSE_PROJECT=fresh-project"), false);
    check("the missing image is filled", merged.includes("OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:extended-stable"), true);
    check("a diverged port is NOT written without --adopt-runtime", merged.includes("OPENCLAW_GATEWAY_PORT=9999"), true);
    check("the container's port is nowhere in the file", merged.includes("18790"), false);
    check("the direction choice is reported", output.includes("--adopt-runtime"), true);
    check("the direction choice names the compose project too", output.includes("OC_COMPOSE_PROJECT"), true);
    check("the token line passes through untouched", merged.includes(`OPENCLAW_GATEWAY_TOKEN=${TOKEN}`), true);
    check("the read is two docker calls — no compose anywhere", dockerCalls.length, 2);
    check(
      "the ps lookup filters by Docker's own compose labels: this deployment's project, the app's service",
      dockerCalls[0]?.[0] === "ps" &&
        dockerCalls[0].includes(`label=com.docker.compose.project=${basename(deploymentDir())}`) &&
        dockerCalls[0].includes("label=com.docker.compose.service=gateway"),
      true,
    );
    check(
      "the inspect asks the found container for one whole-object JSON document",
      dockerCalls[1],
      ["inspect", "--format", "{{json .}}", "c0ffee"],
    );
  }

  // --- an unreachable target: the transport's own refusal, not docker-not-running --------
  {
    await writeFile(envFile(), seedWithoutDataDir, "utf8");
    const stubRefusal = new TransportUnreachableError("ssh: connect to host nonexistent.invalid port 22: no route", "check OC_SSH_HOST");
    const unreachable = {
      description: "stub",
      exec(): never {
        throw stubRefusal;
      },
      exists(): never {
        throw stubRefusal;
      },
      readFile(): never {
        throw stubRefusal;
      },
    } as unknown as Transport;
    const execution = await executeCommand(recoverApp, "recover-env", { kind: "argv", argv: [] }, { surface: "terminal", transport: unreachable });
    const error = execution.error instanceof Error ? execution.error.message : String(execution.error ?? "");
    const problem = unreachableProblem(stubRefusal);
    check("an unreachable target is refused as unreachable", execution.error instanceof UserError && execution.error.message.includes("TARGET_UNREACHABLE"), true);
    check("the unreachable refusal carries the transport's next step as advice", execution.error instanceof UserError ? execution.error.advice : [], [problem.next]);
    check("the unreachable target never reads as docker-not-running", error.includes(NOT_RUNNING_CAUSE), false);
    check("a refused recovery leaves .env byte-identical", await readFile(envFile(), "utf8"), seedWithoutDataDir);
  }

  // --- (1b) --adopt-runtime through the bootstrap merges the diverged values too ---------
  {
    await writeFile(envFile(), seedWithoutDataDir, "utf8");
    const { transport } = recoveryTransport();
    const { error } = await capture(() => executeCommand(recoverApp, "recover-env", { kind: "argv", argv: ["--adopt-runtime"] }, { surface: "terminal", transport }));
    check("the adopt-runtime bootstrap run succeeds", error, "");
    const merged = await readFile(envFile(), "utf8");
    check("a diverged port IS written under --adopt-runtime", merged.includes("OPENCLAW_GATEWAY_PORT=18790"), true);
    check(
      "every fact is adopted",
      merged.includes("OC_DATA_DIR=/srv/data") &&
        merged.includes("OC_COMPOSE_PROJECT=fresh-project") &&
        merged.includes("OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:extended-stable"),
      true,
    );
    check("the token survives the adoption", merged.includes(`OPENCLAW_GATEWAY_TOKEN=${TOKEN}`), true);
  }

  // --- (1c) --dry-run through the bootstrap writes nothing -------------------------------
  {
    await writeFile(envFile(), seedWithoutDataDir, "utf8");
    const { transport } = recoveryTransport();
    const { output, error } = await capture(() => executeCommand(recoverApp, "recover-env", { kind: "argv", argv: ["--dry-run"] }, { surface: "terminal", transport }));
    check("the dry-run bootstrap run succeeds", error, "");
    check("a dry run leaves .env byte-identical", await readFile(envFile(), "utf8"), seedWithoutDataDir);
    check("the dry run names the fact it would fill", output.includes("OC_DATA_DIR=/srv/data"), true);
  }

  // --- (1d) stopped matches from `docker ps --all` must not hide a running instance ------
  {
    await writeFile(envFile(), seedWithoutDataDir, "utf8");
    const stopped = goodInspect();
    stopped.State = { Running: false };
    const { transport, dockerCalls } = recoveryTransport("stopped-id\nrunning-id\n", {
      "stopped-id": stopped,
      "running-id": {
        ...goodInspect(),
        Mounts: [{ Destination: "/home/node/.openclaw", Source: "/srv/live-data/config" }],
      },
    });
    const { error } = await capture(() => executeCommand(recoverApp, "recover-env", { kind: "argv", argv: [] }, { surface: "terminal", transport }));
    check("a stopped matching container does not prevent recovery", error, "");
    check("the running container supplies the recovered data directory", (await readFile(envFile(), "utf8")).includes("OC_DATA_DIR=/srv/live-data"), true);
    check("all matching IDs are inspected until a running one is found", dockerCalls.filter((args) => args[0] === "inspect").map((args) => args[3]), ["stopped-id", "running-id"]);
  }

  // --- (2) the shared declaration drives the schema, the validation and the argv ---------
  {
    const schema = inputSchema(recoverDeclaration) as {
      properties: Record<string, { type?: string; description?: string }>;
      required: string[];
    };
    check("the generated tool schema exposes adopt-runtime", schema.properties["adopt-runtime"]?.type, "boolean");
    check("the generated tool schema still exposes dry-run", schema.properties["dry-run"]?.type, "boolean");
    check("the tool schema exposes nothing else", Object.keys(schema.properties).sort(), ["adopt-runtime", "dry-run", "json"]);
    check("the schema carries the flag's meaning to the client", (schema.properties["adopt-runtime"]?.description ?? "").includes("authoritative"), true);
    check("validate accepts adopt-runtime", validate(recoverDeclaration, { "adopt-runtime": true }), []);
    check("validate accepts both flags together", validate(recoverDeclaration, { "dry-run": true, "adopt-runtime": true }), []);
    check("validate still rejects an undeclared argument", validate(recoverDeclaration, { "no-such-arg": true }), ["unknown argument: no-such-arg"]);
    check("validate rejects adopt-runtime given a value instead of a flag", validate(recoverDeclaration, { "adopt-runtime": "yes" }), ["adopt-runtime takes true or false"]);
    check("adopt-runtime alone is not read-only", callFactsFor(recoverDeclaration, ["--adopt-runtime"]).effect === "read", false);
    check("dry-run alone is still read-only", callFactsFor(recoverDeclaration, ["--dry-run"]).effect, "read");
    check("a plain call is neither read-only nor destructive", callFactsFor(recoverDeclaration, []).effect, "change");
    check("the command details name the flag's meaning", (recoverDeclaration.details ?? "").includes("--adopt-runtime"), true);
  }

  // --- (2) a REAL serveMcp session: tools/list advertises it, tools/call accepts it ------
  {
    // OC_DATA_DIR is absent on purpose: MCP must run recovery without building a Context.
    const moduleUrl = (name: string) => new URL(`../../../../packages/clawwright/${name}.ts`, import.meta.url).href;
    const mcpScript = `
      const { serveMcp } = await import(${JSON.stringify(moduleUrl("integration/mcp/server"))});
      const { commandBody, materializeCommands } = await import(${JSON.stringify(moduleUrl("core/command/index"))});
      const { operateCommands } = await import(${JSON.stringify(moduleUrl("commands/interface/groups/openclawCommands.operate"))});
      const { useDeployment } = await import(${JSON.stringify(moduleUrl("runtime/deployment"))});
      const kinds = await import(${JSON.stringify(moduleUrl("core/values/kinds"))});
      useDeployment(${JSON.stringify(deployDir)});
      // A spec command with choices, so the MCP refusal comes from the shared parser and
      // not from the schema's own check.
      const PICK = commandBody({
        effect: "change",
        arguments: [{ name: "action", description: "which one", kind: "positional", required: true, value: kinds.choice(["a", "b"]) }],
        run: async () => {},
      });
      await serveMcp({
        name: "recover-fixture",
        description: "MCP fixture",
        commands: {
          "recover-env": operateCommands["recover-env"],
          ...materializeCommands({ pick: { summary: "picks", group: "low-level", ...PICK } }),
        },
      });
    `;
    await writeFile(
      envFile(),
      [
        "OC_TARGET_LOCATION=local",
        `OPENCLAW_GATEWAY_TOKEN=${TOKEN}`,
        "",
      ].join("\n"),
      "utf8",
    );
    const mcp = await spawnLocal(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", mcpScript], {
      input:
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n` +
        `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "recover-env", arguments: { "adopt-runtime": true } } })}\n` +
        `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "recover-env", arguments: { "no-such": true } } })}\n` +
        `${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "pick", arguments: { action: "zzz" } } })}\n` +
        `${JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "pick", arguments: {} } })}\n`,
      timeoutMs: 30000,
    });
    check("the MCP session exits cleanly", mcp.code, 0);

    interface RpcResponse {
      id: number;
      result?: {
        tools?: { name: string; inputSchema?: { properties?: Record<string, { type?: string }> } }[];
        content?: { text?: string }[];
      };
    }
    const responses = mcp.stdout.trim().split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as RpcResponse);

    const listed = responses.find((response) => response.id === 1);
    const tool = listed?.result?.tools?.find((entry) => entry.name === "recover-env");
    const properties = tool?.inputSchema?.properties ?? {};
    check("the live tools/list schema advertises adopt-runtime", properties["adopt-runtime"]?.type, "boolean");
    check("the live tools/list schema still advertises dry-run", properties["dry-run"]?.type, "boolean");

    const adopted = responses.find((response) => response.id === 2);
    const adoptedText = adopted?.result?.content?.[0]?.text ?? "";
    check("tools/call with adopt-runtime is not rejected as an unknown argument", adoptedText.includes(unknownArgumentMessage("adopt-runtime")), false);
    if (!adoptedText.includes(RECOVERABLE_ONLY_FROM_RUNNING)) process.stderr.write(`MCP recover-env answered with: ${adoptedText}\n`);
    check("MCP recovery reaches its own missing-container refusal with OC_DATA_DIR absent", adoptedText.includes(RECOVERABLE_ONLY_FROM_RUNNING), true);
    check("MCP recovery never reaches the settings parser's refusal", adoptedText.includes(DATA_DIR_UNSET), false);

    const rejected = responses.find((response) => response.id === 3);
    const rejectedText = rejected?.result?.content?.[0]?.text ?? "";
    check("tools/call with an undeclared argument IS still rejected", rejectedText.includes(unknownArgumentMessage("no-such")), true);

    // A spec command's choices and required refusals come from the parser, in one voice
    // with the console — and as a bare tool error, without an envelope (the call never ran).
    interface RpcResult { result?: { isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: unknown } }
    const badChoice = responses.find((response) => response.id === 4) as (RpcResponse & RpcResult) | undefined;
    const badChoiceText = badChoice?.result?.content?.[0]?.text ?? "";
    check("a spec command's bad choice is refused in the parser's own words", badChoiceText, "<action> takes one of a, b, not \"zzz\"");
    checkTrue("the parser refusal is a tool error", badChoice?.result?.isError === true);
    check("the parser refusal carries no envelope", badChoice?.result?.structuredContent, undefined);
    const missing = responses.find((response) => response.id === 5) as (RpcResponse & RpcResult) | undefined;
    check("a spec command's missing required argument is refused by the parser", missing?.result?.content?.[0]?.text, "pick needs <action>");
  }

  // --- (3) a throw past the pipeline is still an ordinary masked tool error ---------------
  //
  // captureRun runs inside handleAppToolCall's catch: a command whose own declaration
  // predicate throws while the pipeline reads its facts must answer as a masked isError
  // tool result — never as a JSON-RPC error that skips the caller's content handling.
  {
    const moduleUrl = (name: string) => new URL(`../../../../packages/clawwright/${name}.ts`, import.meta.url).href;
    const mcpScript = `
      const { serveMcp } = await import(${JSON.stringify(moduleUrl("integration/mcp/server"))});
      const { useDeployment } = await import(${JSON.stringify(moduleUrl("runtime/deployment"))});
      useDeployment(${JSON.stringify(deployDir)});
      await serveMcp({
        name: "predicate-fixture",
        description: "MCP fixture",
        commands: {
          jinxed: {
            summary: "a declaration predicate that explodes",
            changedWhen: () => { throw new Error("predicate exploded"); },
            run: async () => {},
          },
        },
      });
    `;
    await writeFile(envFile(), ["OC_TARGET_LOCATION=local", `OPENCLAW_GATEWAY_TOKEN=${TOKEN}`, ""].join("\n"), "utf8");
    const mcp = await spawnLocal(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", mcpScript], {
      input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jinxed", arguments: {} } })}\n`,
      timeoutMs: 30000,
    });
    check("the jinxed session exits cleanly", mcp.code, 0);
    const responses = mcp.stdout.trim().split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
    check("one reply for the call", responses.length, 1);
    const reply = responses[0]?.result as { isError?: boolean; content?: Array<{ text?: string }> } | undefined;
    checkTrue("a throw past the pipeline is a tool error reply, not a JSON-RPC error", reply?.isError === true);
    const maskedFailure = "predicate exploded";
    checkTrue("the tool error carries the masked failure text", (reply?.content?.[0]?.text ?? "").includes(maskedFailure));
  }
} finally {
  if (previous !== undefined) useDeployment(previous);
  await rm(deployDir, { recursive: true, force: true });
}

finish("recover-env dispatch");

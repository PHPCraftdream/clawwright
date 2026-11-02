// Where `apply-config` stages its payload, and why the two runs must not share a name.
//
// The real run stages a shared file while holding the instance lock. Dry runs take no lock,
// so their isolated payload name must not collide with that real staging name.

import { appliedHeadline, stagedFileName, declarationExistsRefusal, missingLiveConfigRefusal, RECOVERED_VALUES_NOTE, RESTART_ADVICE } from "#framework/commands/orchestration/config.ts";
import { desiredStateFile } from "#framework/runtime/deployment.ts";
import { orchestrationCommands } from "#framework/commands/interface/groups/openclawCommands.orchestration.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Context } from "#framework/core/context.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { ConfirmationRequiredError, callFactsFor } from "#framework/core/command/index.ts";
import { executeCommand } from "#framework/core/command/execute.ts";
import { inputSchema } from "#framework/integration/mcp/schema.ts";
import type { AppDefinition, AppCommand } from "#framework/core/app.ts";
import type { Transport } from "#framework/runtime/transport/transport.ts";

check("a real run stages under the shared name the container reads", stagedFileName(false), "clawwright-declared-config-patch.json");
check("a dry run does not", stagedFileName(true) === stagedFileName(false), false);

// Two dry runs at once are as ordinary as one dry run beside a real one — neither takes a
// lock, so neither can rely on being alone.
check("two dry runs do not collide with each other", stagedFileName(true) === stagedFileName(true), false);

// Still recognisable in a directory listing, and still JSON to anything that reads by
// extension.
const dry = stagedFileName(true);
check("the dry-run name says what it is", dry.startsWith("clawwright-declared-config-patch.dry-"), true);
check("and stays a .json file", dry.endsWith(".json"), true);

// --- the run that leaves a file behind is the one that failed ---------------------------------
//
// Cleaning up only after a successful run meant every rejected payload left an
// clawwright-declared-config-patch.dry-<hex>.json in the config directory. Those accumulate, travel into an
// archive, and get the snapshot refused by the share allow-list — the same failure the
// operation journal caused, arriving by a different route.

{
  const deployment = await mkdtemp(join(tmpdir(), "clawwright-apply-config-check-"));
  try {
    await mkdir(resolve(deployment, "config"), { recursive: true });
    await writeFile(resolve(deployment, "config", "desired-state.json"), JSON.stringify([{ path: "gateway.mode", value: "local" }]));
    useDeployment(deployment);

    const written = new Set<string>();
    const remote = new Map<string, string>([["/srv/clawwright/config/openclaw.json", JSON.stringify({ gateway: { mode: "remote" } })]]);
    let stageCalls = 0;
    let runtimeCalls = 0;
    const cliError = new Error();
    const ctx = {
      settings: { dataDir: "/srv/clawwright" },
      transport: {
        async exists(path: string): Promise<boolean> { return remote.has(path); },
        async readFile(path: string): Promise<string> { const content = remote.get(path); if (content === undefined) { const error = new Error(); (error as NodeJS.ErrnoException).code = "ENOENT"; throw error; } return content; },
        async writeFile(path: string): Promise<void> {
          stageCalls += 1;
          written.add(path);
        },
        async remove(path: string): Promise<void> {
          written.delete(path);
        },
      },
      paths: { toContainer: (path: string) => path },
      runtime: {
        async isRunning(): Promise<boolean> { return true; },
        async runOneOff(): Promise<never> {
          runtimeCalls += 1;
          // What a payload the CLI rejects looks like from here.
          throw cliError;
        },
      },
    } as unknown as Context;

    let threw = false;
    await withOutputSink(
      () => {},
      async () => {
        try {
          await orchestrationCommands["apply-config"].run(ctx, ["--dry-run"]);
        } catch (error) {
          threw = error === cliError;
        }
      },
    );

    check("dry-run rejection surfaced", threw, true);
    check("rejected payload counts", { stageCalls, runtimeCalls }, { stageCalls: 1, runtimeCalls: 1 });
    check("rejected payload files", { remainingStaged: [...written] }, { remainingStaged: [] });
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
}

{
  const deployment = await mkdtemp(join(tmpdir(), "clawwright-apply-config-map-check-"));
  try {
    await mkdir(resolve(deployment, "config"), { recursive: true });
    await writeFile(resolve(deployment, "config", "desired-state.json"), JSON.stringify([{ path: "gateway.mode", value: "local" }]));
    useDeployment(deployment);
    const staged = new Set<string>();
    let writes = 0;
    let runtimeCalls = 0;
    const mappingError = new Error();
    const partialWriteError = new Error();
    const runtimeError = new Error();
    let failure: unknown;
    let failStage = true;
    let rejectRuntime = true;
    const ctx = {
      settings: { dataDir: "/srv/clawwright" },
      transport: {
        async exists(path: string): Promise<boolean> { return path.endsWith("openclaw.json"); },
        async readFile(path: string): Promise<string> {
          if (path.endsWith("openclaw.json")) return JSON.stringify({ gateway: { mode: "remote" } });
          const error = new Error(`missing: ${path}`); (error as NodeJS.ErrnoException).code = "ENOENT"; throw error;
        },
        async writeFile(path: string): Promise<void> {
          writes += 1;
          staged.add(path);
          if (failStage) throw partialWriteError;
        },
        async remove(path: string): Promise<void> { staged.delete(path); },
      },
      paths: { toContainer: (): never => { throw mappingError; } },
      runtime: {
        async isRunning(): Promise<boolean> { return true; },
        async runOneOff(): Promise<{ code: number; stdout: string; stderr: string }> {
          runtimeCalls += 1;
          if (rejectRuntime) throw runtimeError;
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    } as unknown as Context;

    await withOutputSink(() => {}, async () => {
      try { await orchestrationCommands["apply-config"].run(ctx, ["--dry-run"]); } catch (error) { failure = error; }
    });
  checkTrue("mapping failure preserves error identity and performs no actions", failure === mappingError && writes === 0 && runtimeCalls === 0);

    ctx.paths.toContainer = (path: string) => path;
    failure = undefined;
    await withOutputSink(() => {}, async () => {
      try { await orchestrationCommands["apply-config"].run(ctx, ["--dry-run"]); } catch (error) { failure = error; }
    });
    checkTrue("partial write preserves error identity with no runtime call", failure === partialWriteError && writes === 1 && runtimeCalls === 0);
    check("partial write attempt facts", { writes, runtimeCalls }, { writes: 1, runtimeCalls: 0 });
    check("partial write residual files", { remainingStaged: [...staged] }, { remainingStaged: [] });
    failStage = false;
    failure = undefined;
    await withOutputSink(() => {}, async () => {
      try { await orchestrationCommands["apply-config"].run(ctx, ["--dry-run"]); } catch (error) { failure = error; }
    });
    checkTrue("runtime rejection preserves identity and attempts staging once", failure === runtimeError && writes === 2 && runtimeCalls === 1);
    check("runtime rejection performs staging cleanup", { remainingStaged: [...staged] }, { remainingStaged: [] });
    rejectRuntime = false;
    failure = undefined;
    await withOutputSink(() => {}, async () => {
      try { await orchestrationCommands["apply-config"].run(ctx, ["--dry-run"]); } catch (error) { failure = error; }
    });
    check("successful dry-run stages and invokes runtime once", { failed: failure !== undefined, writes, runtimeCalls }, { failed: false, writes: 3, runtimeCalls: 2 });
    check("successful dry-run residual files", { remainingStaged: [...staged] }, { remainingStaged: [] });
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
}

// --- declared paths reconcile as a JSON Merge Patch, with durable pruning evidence ---------
{
  const deployment = await mkdtemp(join(tmpdir(), "clawwright-apply-config-patch-check-"));
  try {
    await mkdir(resolve(deployment, "config"), { recursive: true });
    await writeFile(resolve(deployment, "config", "desired-state.json"), JSON.stringify([
      { path: "gateway.mode", value: "local" },
      { path: "gateway.controlUi.allowedOrigins", value: ["https://new.example"] },
    ]));
    useDeployment(deployment);
    const live = { gateway: { mode: "remote", obsolete: "remove-me", controlUi: { allowedOrigins: ["https://old.example", "https://keep.example"] } }, agents: { keep: true } };
    const initial = JSON.stringify(live);
    const remote = new Map<string, string>([["/srv/clawwright/config/openclaw.json", initial], ["/srv/clawwright/clawwright-declared.json", JSON.stringify({ version: 1, entries: [{ path: "gateway.obsolete", value: "remove-me" }] })]]);
    const argsSeen: string[][] = [];
    const runtimeRejection = new Error();
    let rejectNextRun = false;
    let runtimeRejectionObserved = false;
    const merge = (base: unknown, delta: unknown): unknown => {
      if (delta === null || typeof delta !== "object" || Array.isArray(delta)) return delta;
      const target: Record<string, unknown> = base && typeof base === "object" && !Array.isArray(base) ? { ...(base as Record<string, unknown>) } : {};
      for (const [key, value] of Object.entries(delta as Record<string, unknown>)) if (value === null) delete target[key]; else target[key] = merge(target[key], value);
      return target;
    };
    const ctx = {
      settings: { dataDir: "/srv/clawwright" },
      transport: {
        async exists(path: string) { return remote.has(path); },
        async readFile(path: string) { const value = remote.get(path); if (value === undefined) { const e = new Error("missing"); (e as NodeJS.ErrnoException).code = "ENOENT"; throw e; } return value; },
        async writeFile(path: string, content: string) { remote.set(path, content); },
        async remove(path: string) { remote.delete(path); },
        async exec(command: string, args: string[]) { if (command === "mv") { const from = args.at(-2)!; const to = args.at(-1)!; if (remote.has(from)) { remote.set(to, remote.get(from)!); remote.delete(from); } } return { code: 0, stdout: "", stderr: "" }; },
      },
      paths: { toContainer: (path: string) => path },
      runtime: {
        async isRunning() { return true; },
        async runOneOff(_service: string, args: string[]) { argsSeen.push(args); const file = args[args.indexOf("--file") + 1]; const patched = merge(JSON.parse(remote.get("/srv/clawwright/config/openclaw.json")!), JSON.parse(remote.get(file)!)); if (!args.includes("--dry-run")) remote.set("/srv/clawwright/config/openclaw.json", JSON.stringify(patched)); if (rejectNextRun) { rejectNextRun = false; runtimeRejectionObserved = true; throw runtimeRejection; } return { code: 0, stdout: "", stderr: "" }; },
      },
    } as unknown as Context;
    await withOutputSink(() => {}, () => orchestrationCommands["apply-config"].run(ctx, []));
    const patchCall = argsSeen[0] ?? [];
    const liveAfter = JSON.parse(remote.get("/srv/clawwright/config/openclaw.json")!);
  check("runtime patch invocation uses the file argument form", patchCall.slice(0, 4), ["dist/index.js", "config", "patch", "--file"]);
    check("nested objects merge while arrays replace", liveAfter, { gateway: { mode: "local", controlUi: { allowedOrigins: ["https://new.example"] } }, agents: { keep: true } });
    check("success staged-file cleanup", { remains: [...remote.keys()].some((path) => path.endsWith("/clawwright-declared-config-patch.json")) }, { remains: false });
    const successfulLedger = remote.get("/srv/clawwright/clawwright-declared.json");
    check("successful apply records the current declared paths", JSON.parse(successfulLedger!).entries.map((entry: { path: string }) => entry.path), ["gateway.mode", "gateway.controlUi.allowedOrigins"]);

    // A rejected real runtime patch must clean up its shared staging name and preserve the prior ledger.
    remote.set("/srv/clawwright/config/openclaw.json", JSON.stringify({ gateway: { mode: "rejected" }, agents: { keep: true } }));
    runtimeRejectionObserved = false;
    rejectNextRun = true;
    let realApplyRefusal: unknown;
    try { await withOutputSink(() => {}, () => orchestrationCommands["apply-config"].run(ctx, [])); }
    catch (error) { realApplyRefusal = error; }
    checkTrue("runtime patch refusal captured", realApplyRefusal === runtimeRejection);
    checkTrue("runtime patch rejection was observed", runtimeRejectionObserved);
    check("rejected staging cleanup", { remains: [...remote.keys()].some((path) => path.endsWith("/clawwright-declared-config-patch.json")) }, { remains: false });
    check("rejected apply retained prior ledger", { ledger: remote.get("/srv/clawwright/clawwright-declared.json") }, { ledger: successfulLedger });
    remote.set("/srv/clawwright/config/openclaw.json", JSON.stringify(liveAfter));
    const unchanged = JSON.stringify(liveAfter);
    argsSeen.length = 0;
    await withOutputSink(() => {}, () => orchestrationCommands["apply-config"].run(ctx, []));
    check("matched declaration leaves live config and runtime untouched", { calls: argsSeen.length, live: remote.get("/srv/clawwright/config/openclaw.json") }, { calls: 0, live: unchanged });

    // Selector declarations create missing list entries, reconcile keyed rows, and prune only
    // the formerly-owned selector matches. Values outside the declaration remain opaque.
    const selectorLive = {
      links: [{ owner: "public", to: "old1" }, { owner: "private", to: "keep" }, { owner: "public", to: "old2" }],
      removed: [{ owner: "public", value: 1 }, { owner: "private", value: 2 }, { owner: "public", value: 3 }],
      config: { secret: { SecretRef: { name: "TOKEN" } }, placeholder: "${TOKEN}" },
    };
    const selectorDeclarations = [
      { path: "rows[id=public].tools", value: { allow: ["read"] } },
      { path: "links[owner=public]", value: [{ to: "new1" }, { to: "new2" }] },
    ];
    await writeFile(resolve(deployment, "config", "desired-state.json"), JSON.stringify(selectorDeclarations));
    remote.set("/srv/clawwright/config/openclaw.json", JSON.stringify(selectorLive));
    remote.set("/srv/clawwright/clawwright-declared.json", JSON.stringify({ version: 1, entries: [{ path: "removed[owner=public]", value: [{ value: 1 }, { value: 3 }] }] }));
    argsSeen.length = 0;
    let stagedPatch: unknown;
    const originalRunOneOff = ctx.runtime.runOneOff;
    ctx.runtime.runOneOff = async (_service: string, args: string[]) => {
      argsSeen.push(args);
      const file = args[args.indexOf("--file") + 1]!;
      stagedPatch = JSON.parse(remote.get(file)!);
      const patched = merge(JSON.parse(remote.get("/srv/clawwright/config/openclaw.json")!), stagedPatch);
      remote.set("/srv/clawwright/config/openclaw.json", JSON.stringify(patched));
      return { code: 0, stdout: "", stderr: "" };
    };
    await withOutputSink(() => {}, () => orchestrationCommands["apply-config"].run(ctx, []));
    const selectorAfter = JSON.parse(remote.get("/srv/clawwright/config/openclaw.json")!);
    check("selector paths create and reconcile entries while pruning only owned matches", selectorAfter, {
      rows: [{ id: "public", tools: { allow: ["read"] } }],
      links: [{ owner: "private", to: "keep" }, { owner: "public", to: "new1" }, { owner: "public", to: "new2" }],
      removed: [{ owner: "private", value: 2 }],
      config: selectorLive.config,
    });
    checkTrue("selector patch contains selector-specific fields", stagedPatch !== undefined && stagedPatch !== null && typeof stagedPatch === "object" && "links" in stagedPatch && "removed" in stagedPatch && "rows" in stagedPatch);
    check("selector declarations are recorded", JSON.parse(remote.get("/srv/clawwright/clawwright-declared.json")!).entries.map((entry: { path: string }) => entry.path), selectorDeclarations.map((entry) => entry.path));
    argsSeen.length = 0;
    await withOutputSink(() => {}, () => orchestrationCommands["apply-config"].run(ctx, []));
    check("selector no-op reapply invokes no CLI commands", argsSeen.length, 0);

    await writeFile(resolve(deployment, "config", "desired-state.json"), "[]");
    remote.set("/srv/clawwright/clawwright-declared.json", JSON.stringify({ version: 1, entries: [{ path: "rows[0].tools", value: { allow: ["read"] } }] }));
    argsSeen.length = 0;
    let numericRefusal = "";
    try { await withOutputSink(() => {}, () => orchestrationCommands["apply-config"].run(ctx, [])); } catch (error) { numericRefusal = (error as Error).message; }
    check("numeric-index refusal precedes actions", { refused: numericRefusal.length > 0, calls: argsSeen.length }, { refused: true, calls: 0 });
    check("numeric-index refusal preserves ownership record", JSON.parse(remote.get("/srv/clawwright/clawwright-declared.json")!).entries[0].path, "rows[0].tools");
    await writeFile(resolve(deployment, "config", "desired-state.json"), JSON.stringify([
      { path: "gateway.mode", value: "local" },
      { path: "gateway.controlUi.allowedOrigins", value: ["https://new.example"] },
    ]));
    remote.set("/srv/clawwright/config/openclaw.json", initial);
    remote.set("/srv/clawwright/clawwright-declared.json", JSON.stringify({ version: 1, entries: [{ path: "gateway.obsolete", value: "remove-me" }] }));
    ctx.runtime.runOneOff = originalRunOneOff;

    const malformed = "{broken";
    remote.set("/srv/clawwright/clawwright-declared.json", malformed);
    let strictRefusal = "";
    try { await withOutputSink(() => {}, () => orchestrationCommands["apply-config"].run(ctx, [])); } catch (error) { strictRefusal = (error as Error).message; }
    check("malformed ownership record blocks writes", strictRefusal.length > 0, true);
    check("malformed declaration refusal facts", { calls: argsSeen.length, ledger: remote.get("/srv/clawwright/clawwright-declared.json") }, { calls: 0, ledger: malformed });
    remote.set("/srv/clawwright/config/openclaw.json", JSON.stringify({ gateway: { mode: "different" }, agents: { keep: true } }));
    const dryRunLiveBefore = remote.get("/srv/clawwright/config/openclaw.json")!;
    const malformedBefore = remote.get("/srv/clawwright/clawwright-declared.json")!;
    rejectNextRun = true;
    let dryRunRejected = false;
    try { await withOutputSink(() => {}, () => orchestrationCommands["apply-config"].run(ctx, ["--dry-run"])); } catch { dryRunRejected = true; }
    check("dry-run rejection is surfaced", dryRunRejected, true);
    check("dry-run treats malformed record as empty and stages only a unique temporary file", argsSeen.length === 1 && argsSeen[0]!.some((arg) => arg.includes(".dry-")), true);
    check("dry-run cleans its unique staged file after CLI rejection", ![...remote.keys()].some((path) => path.includes(".dry-")), true);
    check("dry-run leaves live config unchanged", remote.get("/srv/clawwright/config/openclaw.json"), dryRunLiveBefore);
    check("dry-run leaves the malformed ledger untouched", remote.get("/srv/clawwright/clawwright-declared.json"), malformedBefore);
  } finally { await rm(deployment, { recursive: true, force: true }); }
}

// --- --dump: the reverse run, rebuilding the declaration from the instance's own config -------
//
// When the operator's copy of desired-state.json is lost, the live openclaw.json is the only
// place the values still exist. Only the target's config file is read and only the local
// declaration is written, so the stub context answers for the transport alone.

{
  const deployment = await mkdtemp(join(tmpdir(), "clawwright-apply-config-dump-check-"));
  try {
    await mkdir(resolve(deployment, "config"), { recursive: true });
    useDeployment(deployment);

    // Mutable so each case can bend what the target answers with — that is the whole point of
    // stubbing the transport rather than building a real one.
    let liveConfig = `{
  // The live config is OpenClaw's own JSON5 format — a comment or trailing comma is
  // legitimate there (readLiveConfigOrThrow parses it as JSON5 for exactly this reason),
  // so the fixture is one: parsing it as plain JSON would throw.
  "gateway": { "mode": "local", "bind": "0.0.0.0", "extra": "not ours to declare" },
  "agents": { "defaults": { "model": { "primary": "openai/gpt-5" } } },
}`;
    let targetHasConfig = true;
    const ctx = {
      settings: { dataDir: "/srv/clawwright" },
      transport: {
        async exists(path: string): Promise<boolean> {
          return targetHasConfig && path.endsWith("openclaw.json");
        },
        async readFile(): Promise<string> {
          return liveConfig;
        },
      },
      runtime: {
        async isRunning(): Promise<boolean> { return true; },
      },
    } as unknown as Context;

    const desiredState = resolve(deployment, "config", "desired-state.json");
    const dump = async (...args: string[]): Promise<string> => {
      let output = "";
      await withOutputSink(
        (chunk: string) => {
          output += chunk;
        },
        async () => {
          await orchestrationCommands["apply-config"].run(ctx, args);
        },
      );
      return output;
    };

    await dump("--dump");
    const recovered = await readFile(desiredState, "utf8");
    check("a dump recovers exactly the curated paths from the live config", JSON.parse(recovered) as unknown[], [
      { path: "gateway.mode", value: "local" },
      { path: "gateway.bind", value: "0.0.0.0" },
      { path: "agents.defaults.model.primary", value: "openai/gpt-5" },
    ]);
    check("and a live key outside the curated set does not leak in", { leaked: recovered.includes("not ours to declare") }, { leaked: false });

    let refusal = "";
    try {
      await dump("--dump");
    } catch (error) {
      refusal = (error as Error).message;
    }
    check("a dump onto an existing declaration is refused", { refusalNamesExisting: refusal.includes(declarationExistsRefusal(desiredStateFile())) }, { refusalNamesExisting: true });
    check("and the refusal names the way past it", { forceNamed: refusal.includes("--force") }, { forceNamed: true });
    check("and the refused attempt leaves the file byte-identical", await readFile(desiredState, "utf8"), recovered);

    liveConfig = liveConfig.replace(`"mode": "local"`, `"mode": "remote"`);
    await dump("--dump", "--force");
    const overwritten = JSON.parse(await readFile(desiredState, "utf8")) as { path: string; value: unknown }[];
    check("--force overwrites, so a changed live value is recovered", overwritten.find((entry) => entry.path === "gateway.mode")?.value, "remote");

    // A target that only ever set one of the curated paths must yield exactly that one — the
    // other two have no value to recover, and guessing one would fabricate a declaration.
    liveConfig = `{ "gateway": { "mode": "local" } }`;
    const partial = await dump("--dump", "--force");
    const partialContent = await readFile(desiredState, "utf8");
    check("a live config missing two of the paths yields only what exists", JSON.parse(partialContent) as unknown[], [
      { path: "gateway.mode", value: "local" },
    ]);
    check("and the omitted ones are not emitted as null", { nullEmitted: partialContent.includes("null") }, { nullEmitted: false });
    check("nor as undefined", { undefinedEmitted: partialContent.includes("undefined") }, { undefinedEmitted: false });
    check("each omission is named in the output", { bindNamed: partial.includes("gateway.bind") }, { bindNamed: true });
    check("beside the note that recovered values are not the original declaration", { recoveryNote: partial.includes(RECOVERED_VALUES_NOTE) }, { recoveryNote: true });
    check("and that recipes are not part of the file", { recipesMentioned: partial.includes("recipes") }, { recipesMentioned: true });

    targetHasConfig = false;
    const beforeMissing = await readFile(desiredState, "utf8");
    let missing = "";
    try {
      await dump("--dump", "--force");
    } catch (error) {
      missing = (error as Error).message;
    }
    check("a target with no live config is refused even under --force", { missingConfigRefusal: missing.includes(missingLiveConfigRefusal("/srv/clawwright")) }, { missingConfigRefusal: true });
    check("and the declaration survives the refused dump", { sameBytes: await readFile(desiredState, "utf8") === beforeMissing }, { sameBytes: true });
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
}

// --- flag combinations that mean nothing together are refused before anything runs ------------
//
// The parser accepted any combination and let branch order rank them: the dump branch ran
// first, so --dry-run --dump --force reached the dump with the dry run never consulted, and
// the recovered file — curated paths only — replaced a declaration naming settings dump
// never attempts. A preview must not be able to destroy what it previews. The bytes of the
// existing declaration are the assertion: every refusal below leaves it byte-identical, and
// the same flags refuse the same way whichever order they arrive in.

{
  const deployment = await mkdtemp(join(tmpdir(), "clawwright-apply-config-flags-check-"));
  try {
    await mkdir(resolve(deployment, "config"), { recursive: true });
    // gateway.extra is deliberately outside RECOVERABLE_PATHS: the file's whole value is the
    // one setting a dump would drop, which is what makes byte-identity the right assertion.
    const declared = `${JSON.stringify([{ path: "gateway.extra", value: "declared by hand" }], null, 2)}\n`;
    await writeFile(resolve(deployment, "config", "desired-state.json"), declared, "utf8");
    useDeployment(deployment);

    const ctx = {
      settings: { dataDir: "/srv/clawwright" },
      transport: {
        async exists(path: string): Promise<boolean> {
          return path.endsWith("openclaw.json");
        },
        async readFile(): Promise<string> {
          return `{ "gateway": { "mode": "local" } }`;
        },
      },
      runtime: {
        async isRunning(): Promise<boolean> { return true; },
      },
    } as unknown as Context;

    const desiredState = resolve(deployment, "config", "desired-state.json");
    const refusal = async (...args: string[]): Promise<string> => {
      let message = "";
      await withOutputSink(
        () => {},
        async () => {
          try {
            await orchestrationCommands["apply-config"].run(ctx, args);
          } catch (error) {
            message = (error as Error).message;
          }
        },
      );
      return message;
    };
    const untouched = async (): Promise<string> => readFile(desiredState, "utf8");

    // The audit's exact repro, in both argv orders.
    const first = await refusal("--dry-run", "--dump", "--force");
    check("dump force option validation", { dryRun: first.includes("--dry-run"), dump: first.includes("--dump") }, { dryRun: true, dump: true });
    check("and the declaration survives byte-identical", await untouched(), declared);
    const second = await refusal("--force", "--dry-run", "--dump");
    check("reversed flag order refusal", { dryRun: second.includes("--dry-run"), dump: second.includes("--dump") }, { dryRun: true, dump: true });
    check("and the declaration still survives byte-identical", await untouched(), declared);

    // Without --force the same refusal fires, not the existing-declaration one: validation
    // precedes the dump's own checks, so the answer never depends on the file's state.
    const dryDump = await refusal("--dry-run", "--dump");
    check("dump dry-run validation order", { dryRunRefusal: dryDump.includes("--dry-run"), existsRefusal: dryDump.includes(declarationExistsRefusal(desiredStateFile())) }, { dryRunRefusal: true, existsRefusal: false });
    check("and the declaration survives byte-identical", await untouched(), declared);

    // --break-lock is meaningful only where a lock is taken; --force only where an existing
    // declaration can be overwritten. Both used to be silently dropped.
    const breakDump = await refusal("--break-lock", "--dump");
    check("--break-lock with --dump is refused rather than silently ignored", breakDump.includes("--break-lock"), true);
    check("and the declaration survives byte-identical", await untouched(), declared);
    const dryBreak = await refusal("--dry-run", "--break-lock");
    check("--break-lock with a dry run is refused too — neither takes a lock", dryBreak.includes("--break-lock"), true);

    // --break-foreign-lock is the same story as --break-lock: meaningful only where a lock is
    // taken, so combining it with --dump or --dry-run must refuse rather than silently no-op.
    const breakForeignDump = await refusal("--break-foreign-lock", "host-x", "--dump");
    check("--break-foreign-lock with --dump is refused rather than silently ignored", breakForeignDump.includes("--break-foreign-lock"), true);
    check("and the declaration survives byte-identical", await untouched(), declared);
    const dryBreakForeign = await refusal("--dry-run", "--break-foreign-lock", "host-x");
    check("--break-foreign-lock with a dry run is refused too — neither takes a lock", dryBreakForeign.includes("--break-foreign-lock"), true);

    const forceApply = await refusal("--force");
    check("--force without --dump is refused rather than silently ignored", forceApply.includes("--force"), true);
    check("and the declaration survives every one of these refusals byte-identical", await untouched(), declared);

    // The working combination still works — a guard that refuses valid work fails here
    // rather than silently.
    await withOutputSink(
      () => {},
      async () => {
        await orchestrationCommands["apply-config"].run(ctx, ["--dump", "--force"]);
      },
    );
    const overwritten = await untouched();
    check("a plain --dump --force still overwrites the declaration", overwritten !== declared, true);
    check("with exactly the curated paths the live config holds", JSON.parse(overwritten) as unknown[], [
      { path: "gateway.mode", value: "local" },
    ]);
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
}

// --- the restart advice is suppressed exactly when a caller starts/restarts itself -----------

check("by default (a bare ./clawwright apply-config), the restart advice is printed", appliedHeadline(true), "desired state applied — restart to pick it up: ./clawwright restart");
check("with restartAdvice: false, it is not — the caller starts/restarts itself", appliedHeadline(false).includes(RESTART_ADVICE), false);
check("...but the headline still confirms the write happened", appliedHeadline(false), "desired state applied");

{
  // Every internal caller that runs applyConfig one step before starting or restarting the
  // gateway itself must pass restartAdvice: false — a plain source check, same reasoning as
  // bootstrap-provider-order.check.ts's own set-try source check: proving the two calls stay
  // in the right relationship costs nothing here, next to fully faking each caller's lock and
  // transport just to observe the same two-argument call.
  const read = async (path: string): Promise<string> =>
    (await import("node:fs/promises")).readFile(new URL(path, import.meta.url), "utf8");
  const bootstrapSource = await read("../../../../packages/clawwright/commands/lifecycle/bootstrap/index.ts");
  const setTrySource = await read("../../../../packages/clawwright/commands/sets/set-try.ts");
  const applySource = await read("../../../../packages/clawwright/commands/orchestration/apply.ts");
  check("bootstrap suppresses the restart advice only for a gateway it is about to start", bootstrapSource.includes("await applyConfig(live, [], { restartAdvice: wasRunning })"), true);
  check("set try suppresses it too (same reason, a throwaway instance)", setTrySource.includes("applyConfig(tryCtx, [], { restartAdvice: false })"), true);
  check("apply's own plan runner suppresses it (always paired with up/restart in the same plan)", applySource.includes("applyConfig(ctx, [], { restartAdvice: false })"), true);
}


// --- --dump --force replaces the recovered declaration with no backup: it confirms over MCP

{
  const command = orchestrationCommands["apply-config"] as AppCommand;
  const app: AppDefinition = { name: "apply-config-fixture", description: "fixture", commands: { "apply-config": command } };
  const transport = new Proxy({}, { get: () => () => { throw new Error("CONTACT"); } }) as unknown as Transport;
  check(`--dump --force reads as destroy, --dump alone as change`, callFactsFor(command, ["--dump", "--force"]).effect, "destroy");
  check(`--dump alone stays change`, callFactsFor(command, ["--dump"]).effect, "change");
  check(`--dry-run stays read`, callFactsFor(command, ["--dry-run"]).effect, "read");
  const schema = inputSchema(command) as { properties: Record<string, unknown>; required: string[] };
  checkTrue(`the MCP schema offers confirm`, schema.properties.confirm !== undefined);
  checkTrue(`confirm is offered, not required (a dump without --force is a change)`, !schema.required.includes("confirm"));
  const refused = await executeCommand(app, "apply-config", { kind: "argv", argv: ["--dump", "--force"] }, { surface: "mcp", transport });
  check(`an MCP call without confirm stops at the confirm stage`, refused.stage, "confirm");
  checkTrue(`the refusal is the confirmation one`, refused.error instanceof ConfirmationRequiredError);
  const confirmed = await executeCommand(app, "apply-config", { kind: "argv", argv: ["--dump", "--force"] }, { surface: "mcp", transport, confirmed: true });
  checkTrue(`confirm: true gets past the confirm stage`, confirmed.stage !== "confirm");
  const terminal = await executeCommand(app, "apply-config", { kind: "argv", argv: ["--dump", "--force"] }, { surface: "terminal", transport });
  checkTrue(`the console still asks no confirmation flag`, terminal.stage !== "confirm");
}

finish("apply-config");

// The contract between Clawwright and ssjack: the runtime requirements and supply pinned in
// package.json, then the ssjack-app-v1 descriptor `clawwright ssjack-descriptor` writes for it
// (commands/management/configuration/ssjack-app): the reviewed classification of every command,
// the descriptor's content and limits, and writing the file.

import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { frameworkRoot } from "#framework/core/env.ts";
import { SSJACK_REQUIREMENTS, validateSsjackSupply } from "#framework/runtime/transport/remote/ssjack-contract.ts";
import { SSJACK_CLASSIFICATION, commandsOf } from "#framework/commands/management/configuration/ssjack-app/classification.ts";
import { buildDescriptor, descriptorProblems, serializeDescriptor } from "#framework/commands/management/configuration/ssjack-app/descriptor.ts";
import type { DescriptorSource } from "#framework/commands/management/configuration/ssjack-app/descriptor.ts";
import { writeSsjackDescriptor } from "#framework/commands/management/configuration/ssjack-app/index.ts";
import { resolveCliEntry } from "#framework/commands/management/configuration/ssjack-app/launch.ts";
import type { EntryFacts } from "#framework/commands/management/configuration/ssjack-app/launch.ts";
import { isVerbatim, specData, specOf } from "#framework/core/command/index.ts";
import type { ArgumentSpec } from "#framework/core/command/index.ts";
import type { CommandBody } from "#framework/core/command/spec.ts";
import { surfaceRegistry } from "#framework/entry/registry.ts";
import { UserError } from "#framework/core/io/log.ts";
import { withPrivateFileRenamer } from "#framework/security/privacy/private-file.ts";
import { check, checkTrue, finish, requires } from "#checks/kit/harness.ts";

const metadata = JSON.parse(await readFile(resolve(frameworkRoot, "package.json"), "utf8")) as {
  ssjackRuntime?: { requirements: unknown; supply: unknown };
};
assert.ok(metadata.ssjackRuntime);
assert.deepEqual(metadata.ssjackRuntime.requirements, SSJACK_REQUIREMENTS);
validateSsjackSupply(metadata.ssjackRuntime.supply);

assert.equal(SSJACK_REQUIREMENTS.optional, true);
assert.equal(SSJACK_REQUIREMENTS.protocol, 1);
assert.equal(SSJACK_REQUIREMENTS.chunkSize, 16384);
assert.deepEqual(SSJACK_REQUIREMENTS.capabilities, ["exec", "stdin", "binary", "backpressure", "cancel"]);
assert.equal(SSJACK_REQUIREMENTS.cancellation, "connection-only");

const base = {
  repository: "PHPCraftdream/ssjack",
  commit: "1".repeat(40),
  platform: "windows-amd64",
  archiveSHA256: "2".repeat(64),
  executableSHA256: "3".repeat(64),
};
const ci = { ...base, kind: "ci", runId: 123, artifactId: 456, artifactName: "verified-cli-Windows-X64" };
const release = { ...base, kind: "release", version: "v1.2.3", asset: "ssjack_windows_amd64.exe" };
assert.deepEqual(validateSsjackSupply(ci), ci);
assert.deepEqual(validateSsjackSupply(release), release);
for (const invalid of [
  undefined, null, [], {},
  { ...ci, repository: "other/ssjack" },
  { ...ci, commit: "main" },
  { ...ci, commit: "1".repeat(7) },
  { ...ci, archiveSHA256: "" },
  { ...ci, executableSHA256: "latest" },
  { ...ci, artifactId: 0 },
  { ...ci, runId: 1.5 },
  { ...ci, runId: Number.MAX_SAFE_INTEGER + 1 },
  { ...ci, platform: "auto" },
  { ...ci, artifactName: "../archive.zip" },
  { ...ci, endpoint: "https://127.0.0.1:12345/mcp" },
  { ...ci, token: "must-not-persist" },
  { ...ci, version: "v1.2.3" },
  { ...release, version: "latest" },
  { ...release, artifactId: 456 },
  { ...release, asset: "/private/binary" },
]) assert.throws(() => validateSsjackSupply(invalid), /SSJACK_SUPPLY_INVALID/);

// --- the classification of every command ------------------------------------------------------------
//
// The observational / refused command lists ssjack receives come from one reviewed table next
// to the registry. This check fails when a command is added without being classified, pins
// the two lists the descriptor carries, and holds the table to what the registry declares:
// an observational command is read-only in every action and flag, a command that exports
// secrets or passes its arguments through to another program is refused.

{
  interface Part {
    readonly effect: string;
    readonly resolver: unknown;
    readonly arguments: readonly ArgumentSpec[];
  }

  /** Every call of the command is a read: each action's effect (else the body's), each flag's,
   *  and no per-call resolver that could raise it. */
  function alwaysRead(body: CommandBody): boolean {
    const data = specData(body);
    const parts: readonly Part[] = data.kind === "single"
      ? [{ effect: data.effect, resolver: data.effectOf, arguments: data.arguments }]
      : Object.values(data.actions).map((action) => ({ effect: action.effect ?? data.effect, resolver: action.effectOf, arguments: action.arguments }));
    return parts.every((part) => part.effect === "read" && part.resolver === undefined
      && part.arguments.every((argument) => argument.kind !== "flag" || argument.effect === undefined || argument.effect === "read"));
  }

  const registry = surfaceRegistry();
  const registryNames: readonly string[] = registry.names;

  const missing = (names: readonly string[], table: Readonly<Record<string, string>>): string[] => names.filter((name) => !(name in table));
  const stale = (names: readonly string[], table: Readonly<Record<string, string>>): string[] => Object.keys(table).filter((name) => !names.includes(name));

  // --- a new command cannot ship unclassified -------------------------------------------------------

  check("every command of the registry is classified", missing(registryNames, SSJACK_CLASSIFICATION), []);
  check("the table names no command the registry lacks", stale(registryNames, SSJACK_CLASSIFICATION), []);
  check("the guard reports a command added without a classification", missing([...registryNames, "brand-new"], SSJACK_CLASSIFICATION), ["brand-new"]);
  check("the guard reports a classification left behind by a removed command", stale(registryNames.filter((name) => name !== "status"), SSJACK_CLASSIFICATION), ["status"]);
  checkTrue("the registry is read in full, deployment commands and the dispatcher's own", registryNames.length > 40 && registryNames.includes("help") && registryNames.includes("control-mcp"));

  // --- the two lists, as reviewed ---------------------------------------------------------------------

  check("observational commands", commandsOf("observational"), ["completion", "doctor", "help", "inspect", "list", "logs", "plan", "status", "verify", "version"]);
  check("refused commands", commandsOf("refused"), ["cli", "control-mcp", "exec", "host", "mcp-creds", "mcp-serve"]);
  const refusedNames = commandsOf("refused");
  checkTrue("the refusal list holds mcp-serve and control-mcp", refusedNames.includes("mcp-serve") && refusedNames.includes("control-mcp"));
  check("no command is both observational and refused", commandsOf("observational").filter((name) => refusedNames.includes(name)), []);

  // --- what the registry declares must agree with the table ---------------------------------------------

  for (const name of commandsOf("observational")) {
    const entry = registry.find(name);
    const body = entry?.command !== undefined ? specOf(entry.command) : entry?.gate?.body;
    if (entry?.origin === "dispatcher") {
      checkTrue(`${name}: the dispatcher's own command carries no body to read`, body === undefined);
      continue;
    }
    checkTrue(`${name}: read-only in every action and flag, by its declaration`, body !== undefined && alwaysRead(body));
  }

  // The predicate must be able to say no: these keep a mutating action or flag behind a read base.
  for (const name of ["operations", "files", "backup", "secrets", "watch", "expose", "memory", "recipe", "set", "apply", "lock"]) {
    const declared = registry.find(name)?.command;
    const body = declared === undefined ? undefined : specOf(declared);
    checkTrue(`${name}: has a call that is not a read, so it is not observational`, body !== undefined && !alwaysRead(body));
    check(`${name}: is not observational`, commandsOf("observational").includes(name), false);
  }

  const exporters = registry.entries.filter((entry) => entry.command?.exportsSecrets === true).map((entry) => entry.name);
  checkTrue("at least one command exports secrets on purpose", exporters.length > 0);
  check("every command that exports secrets is refused", exporters.filter((name) => !refusedNames.includes(name)), []);

  const passThrough = registry.entries
    .filter((entry) => entry.command !== undefined && isVerbatim((entry.arguments ?? []) as readonly ArgumentSpec[]))
    .map((entry) => entry.name);
  checkTrue("the pass-through commands were found", passThrough.length >= 3);
  check("every command that passes its arguments to another program is refused", passThrough.filter((name) => !refusedNames.includes(name)), []);
}

// --- the descriptor ----------------------------------------------------------------------------------
//
// The ssjack-app-v1 descriptor: its exact content for a typical installation, every limit of
// the contract (name, command names and lists, launch arguments, workdir, control characters,
// size), and what the launch executable must look like on Windows and on POSIX hosts. The
// expected values are literals taken from the contract, never computed from the product.

{
  const NODE = "/usr/local/bin/node";
  const ENTRY = "/usr/local/lib/node_modules/@phpcraftdream/clawwright/dist/entry/bin.js";
  const FLAG = "--experimental-strip-types";

  const base: DescriptorSource = {
    host: "posix",
    node: NODE,
    entry: ENTRY,
    entryArgs: [],
    observational: ["inspect", "status"],
    refused: ["control-mcp", "mcp-serve"],
  };

  /** How many contract problems the descriptor built from `base` plus `change` has. */
  const problemCount = (change: Partial<DescriptorSource>, host: "win32" | "posix" = "posix"): number =>
    descriptorProblems(buildDescriptor({ ...base, host, ...change }), host).length;

  const refused = (action: () => unknown): boolean => {
    try {
      action();
      return false;
    } catch (error) {
      return error instanceof UserError;
    }
  };

  // --- the typical installation, byte for byte ---------------------------------------------------

  const typical = serializeDescriptor(buildDescriptor(base), "posix");
  check(
    "a typical POSIX installation produces exactly this compact document",
    typical,
    '{"format":"ssjack-app-v1","name":"clawwright","launch":{"executable":"/usr/local/bin/node","args":["--experimental-strip-types","/usr/local/lib/node_modules/@phpcraftdream/clawwright/dist/entry/bin.js"]},"workdir":".","commands":{"observational":["inspect","status"],"refused":["control-mcp","mcp-serve"]}}',
  );
  checkTrue("the document is one line and ends with its closing brace", !/[\r\n\t]/.test(typical) && typical.endsWith("}"));
  check("serializing twice gives the same bytes", serializeDescriptor(buildDescriptor(base), "posix"), typical);
  check("the field order is the contract's", Object.keys(JSON.parse(typical) as object), ["format", "name", "launch", "workdir", "commands"]);

  const checkout = JSON.parse(serializeDescriptor(buildDescriptor({ ...base, entry: "/srv/checkout/tools/clawwright.ts", entryArgs: ["--app", "demo"] }), "posix")) as { launch: { args: string[] } };
  check("a checkout deployment passes its --app after the entry", checkout.launch.args, [FLAG, "/srv/checkout/tools/clawwright.ts", "--app", "demo"]);

  const windows = JSON.parse(serializeDescriptor(buildDescriptor({ ...base, host: "win32", node: "C:\\nodejs\\node.exe", entry: "C:\\pkg\\dist\\entry\\bin.js" }), "win32")) as { launch: { executable: string; args: string[] } };
  check("a Windows executable survives the JSON round trip with its backslashes", windows.launch, { executable: "C:\\nodejs\\node.exe", args: [FLAG, "C:\\pkg\\dist\\entry\\bin.js"] });

  check("the base descriptor breaks nothing", problemCount({}), 0);

  // --- the executable: Windows needs a native .exe, never a shim; POSIX any absolute path ---------

  const WINDOWS_NODES: readonly (readonly [string, number])[] = [
    ["C:\\tools\\node.exe", 0],
    ["C:\\Program Files\\nodejs\\NODE.EXE", 0],
    ["\\\\host\\share\\node.exe", 0],
    ["C:\\tools\\node.cmd", 1],
    ["C:\\tools\\npm.bat", 1],
    ["C:\\tools\\node", 1],
    ["node.exe", 1],
  ];
  for (const [node, expected] of WINDOWS_NODES) check(`win32 executable ${node}`, problemCount({ node }, "win32"), expected);

  const POSIX_NODES: readonly (readonly [string, number])[] = [
    [NODE, 0],
    ["/opt/node/bin/node", 0],
    ["node", 1],
    ["./node", 1],
    ["bin/node", 1],
    ["C:\\tools\\node.exe", 1],
    ["", 1],
  ];
  for (const [node, expected] of POSIX_NODES) check(`posix executable ${node}`, problemCount({ node }, "posix"), expected);

  // --- the name ------------------------------------------------------------------------------------

  const withName = (name: string): number => descriptorProblems({ ...buildDescriptor(base), name }, "posix").length;
  check("name: lowercase with a hyphen", withName("my-app"), 0);
  check("name: 32 characters is the longest", withName(`a${"b".repeat(31)}`), 0);
  check("name: 33 characters is refused", withName(`a${"b".repeat(32)}`), 1);
  check("name: uppercase is refused", withName("Clawwright"), 1);
  check("name: a leading digit is refused", withName("1app"), 1);
  check("name: an underscore is refused", withName("my_app"), 1);
  check("name: empty is refused", withName(""), 1);

  // --- the command lists -----------------------------------------------------------------------------

  const withLists = (observational: readonly string[], refusedList: readonly string[] = []): number => problemCount({ observational, refused: refusedList });
  const numbered = (count: number): string[] => Array.from({ length: count }, (_, index) => `cmd-${index}`);
  check("commands: 64 entries is the longest list", withLists(numbered(64)), 0);
  check("commands: 65 entries is refused", withLists(numbered(65)), 1);
  check("commands: 64 characters is the longest name", withLists([`a${"b".repeat(63)}`]), 0);
  check("commands: 65 characters is refused", withLists([`a${"b".repeat(64)}`]), 1);
  for (const bad of ["Status", "status_x", "1st", "", "a b", "mcp.serve"]) check(`commands: ${JSON.stringify(bad)} is refused`, withLists([bad]), 1);
  check("commands: a name twice in one list is refused", withLists(["status", "status"]), 1);
  check("commands: a name in both lists is refused", withLists(["status"], ["status"]), 1);
  check("commands: the same names across the two lists, distinct, are fine", withLists(["status", "inspect"], ["mcp-serve"]), 0);
  check("commands: empty lists are fine", withLists([], []), 0);

  // --- launch arguments --------------------------------------------------------------------------------

  const withEntry = (entry: string, entryArgs: readonly string[] = []): number => problemCount({ entry, entryArgs });
  check("args: 16 entries is the most", problemCount({ entryArgs: Array.from({ length: 14 }, () => "a") }), 0);
  check("args: 17 entries is refused", problemCount({ entryArgs: Array.from({ length: 15 }, () => "a") }), 1);
  check("args: 1024 bytes in one entry is the most", withEntry("a".repeat(1024)), 0);
  check("args: 1025 bytes in one entry is refused", withEntry("a".repeat(1025)), 1);
  check("args: the limit counts UTF-8 bytes, not characters", withEntry("\u00e9".repeat(513)), 1);
  check("args: 4096 bytes in total is not exceeded by 4026", withEntry("x".repeat(1000), ["y".repeat(1000), "y".repeat(1000), "y".repeat(1000)]), 0);
  check("args: more than 4096 bytes in total is refused", withEntry("x".repeat(1000), ["y".repeat(1000), "y".repeat(1000), "y".repeat(1000), "y".repeat(1000)]), 1);

  // --- control characters and workdir ------------------------------------------------------------------

  check("control: NUL in the executable is refused", problemCount({ node: "/usr/bin/no\u0000de" }), 1);
  check("control: BEL in an argument is refused", withEntry("/srv/a\u0007b"), 1);
  check("control: DEL in an argument is refused", withEntry("/srv/a\u007fb"), 1);
  check("control: a C1 control in an argument is refused", withEntry("/srv/a\u0085b"), 1);

  const withWorkdir = (workdir: string): number => descriptorProblems({ ...buildDescriptor(base), workdir }, "posix").length;
  for (const [workdir, expected] of [[".", 0], ["apps/demo", 0], ["", 1], ["..", 1], ["../up", 1], ["/abs", 1], ["C:\\abs", 1], ["a\\..\\b", 1], ["bad\u0001", 1]] as const) {
    check(`workdir ${JSON.stringify(workdir)}`, withWorkdir(workdir), expected);
  }
  check("the format field must be ssjack-app-v1", descriptorProblems({ ...buildDescriptor(base), format: "ssjack-app-v2" as never }, "posix").length, 1);

  // --- refusal and size --------------------------------------------------------------------------------

  checkTrue("serializing refuses a contract violation with a user error", refused(() => serializeDescriptor(buildDescriptor({ ...base, host: "win32", node: "C:\\tools\\node.cmd" }), "win32")));
  checkTrue("serializing refuses a relative executable on POSIX", refused(() => serializeDescriptor(buildDescriptor({ ...base, node: "node" }), "posix")));
  checkTrue("serializing refuses a document over 16 KiB", refused(() => serializeDescriptor(buildDescriptor({ ...base, node: `/${"a".repeat(17000)}` }), "posix")));
  checkTrue("a large document within 16 KiB is accepted", !refused(() => serializeDescriptor(buildDescriptor({ ...base, node: `/${"a".repeat(8000)}`, entry: "b".repeat(1000) }), "posix")));
}

// --- writing the descriptor ----------------------------------------------------------------------------
//
// Writing ssjack-app.json: which entry the launch points at for each layout, the exact document
// for a typical installation, no silent overwrite, an atomic publish that a failed rename cannot
// half-complete, the deployment's .gitignore, and the Windows / POSIX executable rules end to
// end. Everything is written into a temporary directory; the expected document is built here
// from literals, not from the product.

{
  /** What a rejected action threw, undefined when it did not throw. */
  async function thrown(action: () => Promise<unknown>): Promise<unknown> {
    try {
      await action();
      return undefined;
    } catch (error) {
      return error;
    }
  }

  const present = (paths: readonly string[]): EntryFacts["exists"] => {
    const known = new Set(paths);
    return async (path) => known.has(path);
  };

  // --- which entry the launch points at ----------------------------------------------------------------

  const CHECKOUT = resolve("/srv/clawwright");
  const SOURCES = resolve(CHECKOUT, "packages", "clawwright");
  const GATE = resolve(CHECKOUT, "tools", "clawwright.ts");
  const SOURCE_BIN = resolve(SOURCES, "entry", "bin.ts");
  const PACKAGE_DIST = resolve("/srv/pkg/dist");
  const PACKAGE_BIN = resolve(PACKAGE_DIST, "entry", "bin.js");
  const checkoutFacts = (exists: EntryFacts["exists"]): EntryFacts => ({ frameworkRoot: SOURCES, monorepoRoot: CHECKOUT, appsRoot: resolve(CHECKOUT, "apps"), exists });
  const packageFacts = (exists: EntryFacts["exists"]): EntryFacts => ({ frameworkRoot: PACKAGE_DIST, monorepoRoot: resolve("/srv/nowhere"), appsRoot: resolve("/srv/nowhere", "apps"), exists });

  const demo = { name: "demo", dir: resolve(CHECKOUT, "apps", "demo") };
  check("an apps/<name> deployment of a checkout runs the checkout gate with its --app", await resolveCliEntry(demo, checkoutFacts(present([GATE, SOURCE_BIN]))), { path: GATE, args: ["--app", "demo"] });
  check("without the gate script the source entry is used", await resolveCliEntry(demo, checkoutFacts(present([SOURCE_BIN]))), { path: SOURCE_BIN, args: [] });
  check("a deployment outside apps/ runs this copy's entry", await resolveCliEntry({ name: "app", dir: resolve("/srv/elsewhere/app") }, checkoutFacts(present([GATE, SOURCE_BIN]))), { path: SOURCE_BIN, args: [] });
  check("a directory below apps/<name> is not a deployment of the checkout", await resolveCliEntry({ name: "sub", dir: resolve(CHECKOUT, "apps", "demo", "sub") }, checkoutFacts(present([GATE, SOURCE_BIN]))), { path: SOURCE_BIN, args: [] });
  check("an installed package runs its own dist/entry/bin.js", await resolveCliEntry(demo, packageFacts(present([PACKAGE_BIN]))), { path: PACKAGE_BIN, args: [] });
  check("bin.js wins over bin.ts when both exist", await resolveCliEntry(demo, packageFacts(present([PACKAGE_BIN, resolve(PACKAGE_DIST, "entry", "bin.ts")]))), { path: PACKAGE_BIN, args: [] });
  checkTrue("a copy without any entry file is a user error", (await thrown(() => resolveCliEntry(demo, packageFacts(present([]))))) instanceof UserError);

  // --- the document written for a typical installation --------------------------------------------------

  const NODE = "/usr/local/bin/node";
  const installed = packageFacts(present([PACKAGE_BIN]));
  const typicalDocument = JSON.stringify({
    format: "ssjack-app-v1",
    name: "clawwright",
    launch: { executable: NODE, args: ["--experimental-strip-types", PACKAGE_BIN] },
    workdir: ".",
    commands: {
      observational: ["completion", "doctor", "help", "inspect", "list", "logs", "plan", "status", "verify", "version"],
      refused: ["cli", "control-mcp", "exec", "host", "mcp-creds", "mcp-serve"],
    },
  });

  const root = await mkdtemp(join(tmpdir(), "clawwright-ssjack-descriptor-"));
  try {
    // created, then current
    const created = join(root, "created");
    await mkdir(created);
    const deployment = { name: "created", dir: created };
    const options = { force: false, host: "posix", node: NODE, facts: installed } as const;
    const first = await writeSsjackDescriptor(deployment, options);
    check("the first run creates the descriptor", first.state, "created");
    check("the file holds exactly the typical document", await readFile(join(created, "ssjack-app.json"), "utf8"), typicalDocument);
    check("the outcome reports the same text", first.text, typicalDocument);
    check("the deployment ignores the file, which holds this machine's paths", await readFile(join(created, ".gitignore"), "utf8"), "/ssjack-app.json\n");
    check("no temporary file is left behind", (await readdir(created)).sort(), [".gitignore", "ssjack-app.json"]);

    const second = await writeSsjackDescriptor(deployment, options);
    check("an identical descriptor is left as it is", second.state, "current");
    check("the second run changed nothing", [await readFile(join(created, "ssjack-app.json"), "utf8"), await readFile(join(created, ".gitignore"), "utf8")], [typicalDocument, "/ssjack-app.json\n"]);

    // no silent overwrite
    const file = join(created, "ssjack-app.json");
    await writeFile(file, '{"edited":true}');
    checkTrue("a different descriptor is refused without force", (await thrown(() => writeSsjackDescriptor(deployment, options))) instanceof UserError);
    check("the refused run left the edit alone", await readFile(file, "utf8"), '{"edited":true}');
    check("the refused run left no temporary file", (await readdir(created)).sort(), [".gitignore", "ssjack-app.json"]);

    // atomic: a rename that fails leaves the old file whole, and nothing temporary
    const failure = await thrown(() => withPrivateFileRenamer(async () => { throw new Error("rename refused"); }, () => writeSsjackDescriptor(deployment, { ...options, force: true })));
    checkTrue("a failing rename surfaces its error", failure instanceof Error);
    check("a failed publish leaves the previous file intact", await readFile(file, "utf8"), '{"edited":true}');
    check("a failed publish leaves no temporary file", (await readdir(created)).sort(), [".gitignore", "ssjack-app.json"]);

    const forced = await writeSsjackDescriptor(deployment, { ...options, force: true });
    check("force replaces a different descriptor", forced.state, "replaced");
    check("the replacement is the typical document", await readFile(file, "utf8"), typicalDocument);

    // .gitignore: appended once, never duplicated, existing content kept
    const unterminated = join(root, "unterminated");
    await mkdir(unterminated);
    await writeFile(join(unterminated, ".gitignore"), "node_modules");
    await writeSsjackDescriptor({ name: "unterminated", dir: unterminated }, options);
    check("an ignore file without a final newline gets the entry on its own line", await readFile(join(unterminated, ".gitignore"), "utf8"), "node_modules\n/ssjack-app.json\n");
    await writeSsjackDescriptor({ name: "unterminated", dir: unterminated }, options);
    check("a second run does not repeat the entry", await readFile(join(unterminated, ".gitignore"), "utf8"), "node_modules\n/ssjack-app.json\n");
    const listed = join(root, "listed");
    await mkdir(listed);
    await writeFile(join(listed, ".gitignore"), "ssjack-app.json\r\n");
    await writeSsjackDescriptor({ name: "listed", dir: listed }, options);
    check("an entry already listed is not added again", await readFile(join(listed, ".gitignore"), "utf8"), "ssjack-app.json\r\n");

    // Windows and POSIX executables, end to end
    const windows = join(root, "windows");
    await mkdir(windows);
    const onWindows = await writeSsjackDescriptor({ name: "windows", dir: windows }, { ...options, host: "win32", node: "C:\\nodejs\\node.exe" });
    check("a native .exe is accepted on Windows", (JSON.parse(await readFile(join(windows, "ssjack-app.json"), "utf8")) as { launch: { executable: string } }).launch.executable, "C:\\nodejs\\node.exe");
    check("the Windows outcome says created", onWindows.state, "created");

    const shim = join(root, "shim");
    await mkdir(shim);
    checkTrue("a .cmd shim is refused on Windows", (await thrown(() => writeSsjackDescriptor({ name: "shim", dir: shim }, { ...options, host: "win32", node: "C:\\nodejs\\node.cmd" }))) instanceof UserError);
    checkTrue("a bare executable name is refused on POSIX", (await thrown(() => writeSsjackDescriptor({ name: "shim", dir: shim }, { ...options, node: "node" }))) instanceof UserError);
    check("a refused descriptor writes nothing, not even the ignore file", await readdir(shim), []);

    // a link is never followed
    await requires("symlink", "a linked descriptor is refused", async () => {
      const linked = join(root, "linked");
      await mkdir(linked);
      const target = join(root, "elsewhere.json");
      await writeFile(target, "untouched");
      await symlink(target, join(linked, "ssjack-app.json"));
      checkTrue("a descriptor that is a link is refused", (await thrown(() => writeSsjackDescriptor({ name: "linked", dir: linked }, { ...options, force: true }))) instanceof UserError);
      check("the link's target was not written through", await readFile(target, "utf8"), "untouched");
    });

    // the real process: this Node, an entry that exists, and a contract-clean document
    const real = join(root, "real");
    await mkdir(real);
    const live = await writeSsjackDescriptor({ name: "real", dir: real }, { force: false });
    check("the launch is the Node that ran the command", live.descriptor.launch.executable, process.execPath);
    check("the entry it launches exists", await access(live.descriptor.launch.args[1] ?? "").then(() => true, () => false), true);
    check("the real run's document is what the file holds", await readFile(join(real, "ssjack-app.json"), "utf8"), live.text);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

finish("ssjack contract");

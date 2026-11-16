// Writing ssjack-app.json: which entry the launch points at for each layout, the exact document
// for a typical installation, no silent overwrite, an atomic publish that a failed rename cannot
// half-complete, the deployment's .gitignore, and the Windows / POSIX executable rules end to
// end. Everything is written into a temporary directory; the expected document is built here
// from literals, not from the product.

import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeSsjackDescriptor } from "#framework/commands/management/configuration/ssjack-app/index.ts";
import { resolveCliEntry } from "#framework/commands/management/configuration/ssjack-app/launch.ts";
import type { EntryFacts } from "#framework/commands/management/configuration/ssjack-app/launch.ts";
import { UserError } from "#framework/core/io/log.ts";
import { withPrivateFileRenamer } from "#framework/security/privacy/private-file.ts";
import { check, checkTrue, finish, requires } from "#checks/kit/harness.ts";

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

finish("ssjack descriptor writing");

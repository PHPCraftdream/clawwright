// The ssjack-app-v1 descriptor: its exact content for a typical installation, every limit of
// the contract (name, command names and lists, launch arguments, workdir, control characters,
// size), and what the launch executable must look like on Windows and on POSIX hosts. The
// expected values are literals taken from the contract, never computed from the product.

import { buildDescriptor, descriptorProblems, serializeDescriptor } from "#framework/commands/management/configuration/ssjack-app/descriptor.ts";
import type { DescriptorSource } from "#framework/commands/management/configuration/ssjack-app/descriptor.ts";
import { UserError } from "#framework/core/io/log.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

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

finish("ssjack descriptor");

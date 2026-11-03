// Local-tar ownership hygiene for packages/clawwright, enforced as an invariant: the single
// owner of LOCAL tar spawns is packages/clawwright/set/artifacts/tar.ts — no other file may
// hand a local process runner the literal program "tar" (tar over ctx.transport runs on
// the target and is legitimate). The owner itself must pass every "-C" value through
// tarLocalPath(...) (rf6-fix33). The analysis lives in local-tar-rules.ts; this file
// self-checks it on in-memory snippets, then scans the real tree. ALLOW is empty and must
// stay empty — a hit fails by name; legitimate shapes are handled by tightening the rule,
// never by allow-listing.

import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { check, finish } from "#checks/kit/harness.ts";
import { analyze } from "./local-tar-rules.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const frameworkRoot = resolve(repoRoot, "packages", "clawwright");

async function walk(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

// --- self-check: table-driven, in-memory, every case asserts the exact classification -----

type SelfCase = { name: string; source: string; owner?: boolean; spawns: string[]; unnormalized: string[] };

// spawns/unnormalized entries are "call[classification]" — the exact expected classification.
const SELF_CASES: SelfCase[] = [
  {
    name: "spawnLocal with the literal program tar",
    source: `await spawnLocal("tar", ["-tzf", archive]);`,
    spawns: ["spawnLocal[LOCAL TAR SPAWN]"],
    unnormalized: [],
  },
  {
    name: "exec with a tar command string",
    source: `const r = await exec("tar -tzf x");`,
    spawns: ["exec[LOCAL TAR SPAWN]"],
    unnormalized: [],
  },
  {
    name: "spawn of bash -c with a tar token",
    source: `spawn("bash", ["-c", "tar -czf out ."]);`,
    spawns: ["spawn[LOCAL TAR SPAWN]"],
    unnormalized: [],
  },
  {
    name: "owner spawnLocal with a bare -C value",
    source: `await spawnLocal("tar", ["-czf", out, "-C", dir, "."]);`,
    owner: true,
    spawns: ["spawnLocal[LOCAL TAR SPAWN]"],
    unnormalized: ["spawnLocal[UNNORMALIZED -C]"],
  },
  {
    name: "owner spawnLocal with tarLocalPath(-C value) is clean",
    source: `await spawnLocal("tar", ["-czf", out, "-C", tarLocalPath(dir), "."]);`,
    owner: true,
    spawns: ["spawnLocal[LOCAL TAR SPAWN]"],
    unnormalized: [],
  },
  {
    name: "receiver-qualified spawn of the literal program tar",
    source: `childProcess.spawn("tar", ["-tzf", a]);`,
    spawns: ["spawn[LOCAL TAR SPAWN]"],
    unnormalized: [],
  },
  {
    name: "receiver-qualified execFile of the literal program tar",
    source: `cp.execFile("tar", ["-tzf", a]);`,
    spawns: ["execFile[LOCAL TAR SPAWN]"],
    unnormalized: [],
  },
  {
    name: "exec with a shell pipeline carrying tar",
    source: `exec("gzip -dc input | tar -xf -");`,
    spawns: ["exec[LOCAL TAR SPAWN]"],
    unnormalized: [],
  },
  {
    name: "the owner's localTarRunner spelling is a local spawn",
    source: `await localTarRunner("tar", ["-tzf", x]);`,
    spawns: ["localTarRunner[LOCAL TAR SPAWN]"],
    unnormalized: [],
  },
  {
    name: "docker is not tar",
    source: `await spawnLocal("docker", ["run", "x"]);`,
    spawns: [],
    unnormalized: [],
  },
  {
    name: "tar over the transport runs on the target, not locally",
    source: `const rest = [...prefix, "tar", "--numeric-owner", "-czf", out, "."];\nawait ctx.transport.exec(head, rest);`,
    spawns: [],
    unnormalized: [],
  },
  {
    name: "the owner's public API is not a raw spawn",
    source: `const result = await tarCreateArchive(a, b);`,
    spawns: [],
    unnormalized: [],
  },
  {
    name: "prose and comments mentioning tar do not count",
    source: `// runLocalTar spawns tar locally; see docs "tar over ssh".\nconst note = "tar is the archiver";`,
    spawns: [],
    unnormalized: [],
  },
  {
    name: "the owner's runLocalTar wrapper is the sanctioned path",
    source: `await runLocalTar(["-tzf", x]);`,
    spawns: [],
    unnormalized: [],
  },
  {
    name: "regex .exec is not a process runner",
    source: `const m = /recipe "(.+)"/u.exec(entry.detail);`,
    spawns: [],
    unnormalized: [],
  },
  {
    name: "transport receiver exec is a target-side call",
    source: `await ctx.transport.exec("tar", ["-tzf", a]);`,
    spawns: [],
    unnormalized: [],
  },
  {
    name: "non-tar pipeline is not a local tar spawn",
    source: `exec("gzip -dc input | sha256sum");`,
    spawns: [],
    unnormalized: [],
  },
  {
    name: "non-tar command string is not a local tar spawn",
    source: `exec("git status");`,
    spawns: [],
    unnormalized: [],
  },
  {
    name: "the substitution wrapper is not a raw spawn",
    source: `withLocalTarRunner(sub, body);`,
    spawns: [],
    unnormalized: [],
  },
  {
    name: "transport method exec is a target-side call",
    source: `await this.exec("tar", ["-tzf", path]);`,
    spawns: [],
    unnormalized: [],
  },
];

for (const selfCase of SELF_CASES) {
  const result = analyze(selfCase.source, selfCase.owner === true);
  const actual = {
    spawns: result.spawns.map((hit) => `${hit.call}[${hit.classification}]`),
    unnormalized: result.unnormalized.map((hit) => `${hit.call}[${hit.classification}]`),
  };
  check(`local-tar self: ${selfCase.name}`, actual, { spawns: selfCase.spawns, unnormalized: selfCase.unnormalized });
}

// --- real-tree scan -----------------------------------------------------------------------

const SKIP_SEGMENTS = new Set(["node_modules", "dist"]);
function isSkipped(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some((segment) => SKIP_SEGMENTS.has(segment));
}

// Must stay empty — any hit fails the check by name; tighten the rule instead.
const ALLOW: readonly string[] = [];

const OWNER = "packages/clawwright/set/artifacts/tar.ts";
// The guard's own file is excluded from the real scan: its self-check table contains the
// flagged patterns by construction (that is exactly what SELF_CASES asserts the analyzer
// flags), so scanning it only re-reports the self-check snippets.
const GUARD_SELF = "tools/checks/foundation/hygiene/static/local-tar-owner.check.ts";

const files = (await walk(frameworkRoot)).sort();
const spawnOffenders: Array<{ file: string; call: string }> = [];
const unnormalizedOffenders: Array<{ file: string; call: string }> = [];
let scanned = 0;
for (const file of files) {
  const rel = relative(repoRoot, file).replaceAll("\\", "/");
  if (isSkipped(rel) || rel === GUARD_SELF) continue;
  scanned++;
  const result = analyze(await readFile(file, "utf8"), rel === OWNER);
  // The owner is held only to the UNNORMALIZED -C rule — its sanctioned local spawns are
  // exactly what the ownership invariant points at, so they are not "outside" hits.
  if (rel !== OWNER) for (const hit of result.spawns) spawnOffenders.push({ file: rel, call: hit.call });
  for (const hit of result.unnormalized) unnormalizedOffenders.push({ file: rel, call: hit.call });
}

check(
  "local-tar: no local tar spawn outside set/artifacts/tar.ts",
  spawnOffenders.filter((entry) => !ALLOW.includes(entry.file)).map((entry) => `${entry.file} [${entry.call}]`),
  [],
);
check(
  "local-tar: no unnormalized -C in the owner",
  unnormalizedOffenders.map((entry) => `${entry.file} [${entry.call}]`),
  [],
);

console.log(
  `local tar owner: ${scanned} files scanned (${files.length} found, guard self-check excluded, owner held to unnormalized -C only), ${spawnOffenders.length} local tar spawns, ${unnormalizedOffenders.length} unnormalized -C, ${ALLOW.length} allow entries (must stay 0)`,
);
finish("local tar owner");

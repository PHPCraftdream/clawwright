// Write-isolation hygiene for the checks tree, enforced as an invariant: every write-shaped
// call must target an isolated sandbox (tmpdir/mkdtemp/isolatedAppsRoot/apps.root or a
// value propagated from one), never a path anchored at the physical checkout — and every
// createApp call must be sandboxed. The analysis lives in write-isolation-rules.ts; this
// file self-checks it on in-memory snippets, then scans the real tree. ALLOW is empty and
// must stay empty — a hit fails by name; legitimate shapes are handled by tightening the
// rule, never by allow-listing.

import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { inspectBody, sourcePath } from "./write-isolation-syntax/body.ts";
import { closeCalleeSyntax, childBodyCapable } from "./write-isolation-syntax/index.ts";
import { analyze, type Hit } from "./write-isolation-syntax/write-isolation-rules.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const checksRoot = resolve(repoRoot, "tools", "checks");

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
const defaultParameterWrites = analyze(`
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
async function fixture(root: string, tor = false): Promise<unknown> {
  const data = tor ? "tor" : "data"; return { data };
}
async function run() { await execute("sh", ["-c", "true"]); }
`).writes;
checkTrue("default parameter does not capture later callable bodies", !defaultParameterWrites.some(hit => hit.target === "tor"));
check("descriptor metadata reads cannot mutate the checkout", analyze('import * as fs from "node:fs"; const metadata = fs.fstatSync(fd);').writes, []);
checkTrue("descriptor permission mutations remain capabilities", analyze('import * as fs from "node:fs"; fs.fchmodSync(fd, 0o600);').writes.some(hit => hit.classification === "UNKNOWN"));
check("filesystem access constants are scalar metadata, not writer capabilities", analyze('import fs,{constants} from "node:fs"; consume(constants.R_OK); consume(fs.constants.X_OK);').writes, []);
check("regex quotes cannot hide checkout writes", analyze('import {writeFile} from "node:fs/promises"; const pattern=/"/.test(input); writeFile("./checkout","bytes");').writes.map(hit => hit.classification), ["ANCHORED"]);
check("regex quotes preserve caller-owned temporary writes", analyze('import {writeFile} from "node:fs/promises"; import {tmpdir} from "node:os"; import {join} from "node:path"; const pattern=/"/.test(input); const root=tmpdir(); writeFile(join(root,"owned"),"bytes");').writes, []);
check("filesystem types in callable signatures are not runtime capabilities", analyze('import * as fs from "node:fs"; const metadata=(stat:fs.Stats):fs.Stats=>stat;').writes, []);
check("filesystem types in erased declarations are not runtime capabilities", analyze('import * as fs from "node:fs"; type Shape={path:fs.PathLike};').writes, []);
checkTrue("typed writer aliases retain checkout mutations", analyze('import * as fs from "node:fs"; const writer:typeof fs.writeFile=fs.writeFile; writer("./checkout","bytes");').writes.some(hit => hit.classification === "ANCHORED"));
for (const [source, expected] of [
  ['import {execFile} from "node:child_process"; import {promisify} from "node:util"; const run=promisify(execFile); run("git",["clean","-fd"],{cwd:monorepoRoot});', ["ANCHORED"]],
  ['import {execFile} from "node:child_process"; import {promisify} from "node:util"; const run=promisify(execFile); run("git",["status"],{cwd:monorepoRoot});', []],
  ['import {writeFile} from "node:fs"; import {promisify as asyncFunction} from "node:util"; const put=asyncFunction(writeFile); put("./checkout","bytes");', ["ANCHORED"]],
  ['import {writeFile} from "node:fs"; import {promisify} from "./unknown.ts"; const put=promisify(writeFile); put("./checkout","bytes");', ["UNKNOWN", "UNKNOWN"]],
] as const) check("native promisify preserves capability classification", analyze(source).writes.map(hit => hit.classification), expected);


const CREATE_APP = `import { createApp } from "#framework/integration/deployment/scaffold.ts";`;

type SelfCase = { name: string; source: string; createApp: boolean; writes: string[] };

// writes entries are "call[classification]" — the exact expected classification per hit.
const SELF_CASES: SelfCase[] = [
  {
    name: "3-argument resolve(monorepoRoot, apps, name) write",
    source: `await writeFile(resolve(monorepoRoot, "apps", "probe"), "x");`,
    createApp: false,
    writes: ["writeFile[ANCHORED]"],
  },
  {
    name: "mkdir under monorepoRoot",
    source: `await mkdir(resolve(monorepoRoot, "docs", "x"), { recursive: true });`,
    createApp: false,
    writes: ["mkdir[ANCHORED]"],
  },
  {
    name: "rm over the checkout apps dir",
    source: `await rm(join(monorepoRoot, "apps"));`,
    createApp: false,
    writes: ["rm[ANCHORED]"],
  },
  {
    name: "appendFile onto a repo-root log",
    source: `await appendFile(join(monorepoRoot, "log"), "x");`,
    createApp: false,
    writes: ["appendFile[ANCHORED]"],
  },
  {
    name: "copyFile with a bare relative destination",
    source: `await copyFile(resolve(monorepoRoot, "a"), "b");`,
    createApp: false,
    writes: ["copyFile[ANCHORED]", "copyFile[ANCHORED]"],
  },
  {
    name: "fs.writeFileSync anchored at process.cwd()",
    source: `fs.writeFileSync(path.resolve(process.cwd(), "o.txt"), "");`,
    createApp: false,
    writes: ["writeFileSync[ANCHORED]"],
  },
  {
    name: "bare relative string-literal target",
    source: `await writeFile("tools/clawwright.ts", "x");`,
    createApp: false,
    writes: ["writeFile[ANCHORED]"],
  },
  {
    name: "import.meta-derived root write (upward URL escape)",
    source: `await writeFile(new URL("../../probe.txt", import.meta.url), "x");`,
    createApp: false,
    writes: ["writeFile[ANCHORED]"],
  },
  {
    name: "createApp with no isolation anywhere",
    source: `${CREATE_APP}\nawait createApp("x");`,
    createApp: true,
    writes: [],
  },
  {
    name: "isolatedAppsRoot imported but never called + createApp",
    source: `${CREATE_APP}\nimport { isolatedAppsRoot } from "#checks/kit/harness.ts";\nawait createApp("x");`,
    createApp: true,
    writes: [],
  },
  {
    name: "isolatedAppsRoot variable + apps.root write",
    source: `const apps = await isolatedAppsRoot("probe");\nawait createApp("x");\nawait writeFile(resolve(apps.root, "f"), "x");`,
    createApp: false,
    writes: [],
  },
  {
    name: "mkdtemp(tmpdir()) root + write under it",
    source: `const root = await mkdtemp(join(tmpdir(), "p-"));\nawait writeFile(join(root, "f"), "x");`,
    createApp: false,
    writes: [],
  },
  {
    name: "three-line propagation sc -> scApps -> write",
    source: `const sc = await mkdtemp(join(tmpdir(), "sc-"));\nconst scApps = join(sc, "apps");\nawait writeFile(resolve(scApps, "f"), "x");`,
    createApp: false,
    writes: [],
  },
  {
    name: "createApp alongside an isolatedAppsRoot CALL",
    source: `${CREATE_APP}\nconst apps = await isolatedAppsRoot("probe");\nawait createApp("x");`,
    createApp: false,
    writes: [],
  },
  {
    name: "clean apps-dir env redirect + createApp",
    source: `const sc = await mkdtemp(join(tmpdir(), "sc-"));\nprocess.env["CLAWWRIGHT_CHECKS_APPS_DIR"] = join(sc, "apps");\nawait createApp("x");`,
    createApp: false,
    writes: [],
  },
  {
    name: "readdir is a read, not a write",
    source: `await readdir(resolve(monorepoRoot, "apps"));`,
    createApp: false,
    writes: [],
  },
  {
    name: "file-local new URL(./, import.meta.url) fixture write",
    source: `await writeFile(new URL("./fixtures/f.txt", import.meta.url), "x");`,
    createApp: false,
    writes: ["writeFile[ANCHORED]"],
  },
];

for (const [name, source, expected] of [
  ["reviewer B resolve alias", `const p=resolve(monorepoRoot,'.claude'); writeFile(resolve(p,'file'), 'x');`, "ANCHORED"],
  ["direct alias", `const p=monorepoRoot; writeFile(p,'x');`, "ANCHORED"],
  ["let assignment", `let p; p=join(monorepoRoot,'.claude'); writeFile(p,'x');`, "ANCHORED"],
  ["destructuring", `const {root:p}={root:monorepoRoot}; writeFile(p,'x');`, "ANCHORED"],
  ["array destructuring anchored", `const [p]=[monorepoRoot]; writeFile(p,'x');`, "ANCHORED"],
  ["array destructuring clean", `const [p]=[tmpdir()]; writeFile(p,'x');`, "CLEAN"],
  ["unknown direct", `writeFile(missing,'x');`, "UNKNOWN"],
  ["anchored helper caller", `function put(root) { writeFile(resolve(root,'f'),'x'); } put(monorepoRoot);`, "ANCHORED"],
  ["clean helper caller", `function put(root) { writeFile(resolve(root,'f'),'x'); } put(tmpdir());`, "CLEAN"],
  ["root not leaf", `const p=tmpdir(); writeFile(join(p,monorepoRoot),'x');`, "CLEAN"],
  ["destructuring distinct properties", `const {safe:p}={safe:tmpdir(),bad:monorepoRoot}; writeFile(p,'x');`, "CLEAN"],
  ["unknown", `writeFile(resolve(missing,'file'),'x');`, "UNKNOWN"],
  ["unknown helper", `function helper(root) { writeFile(root,'x'); }`, "UNKNOWN"],
  ["clean alias", `const p=tmpdir(); writeFile(resolve(p,'file'),'x');`, "CLEAN"],
  ["clean let", `let p=tmpdir(); p=join(p,'fixture'); writeFile(p,'x');`, "CLEAN"],
  ["clean destructuring", `const {root:p}=await isolatedAppsRoot('p'); writeFile(p,'x');`, "CLEAN"],
  ["scope shadow", `const p=tmpdir(); { const p=monorepoRoot; writeFile(p,'x'); }`, "ANCHORED"],
  ["scope sibling", `{ const p=tmpdir(); } { writeFile(p,'x'); }`, "UNKNOWN"],
  ["copy destination clean", `copyFile(monorepoRoot,join(tmpdir(),'file'));`, "ANCHORED"],
  ["copy destination anchored", `copyFile(tmpdir(),join(monorepoRoot,'file'));`, "ANCHORED"],
  ["floor: template literal", "writeFile(`${monorepoRoot}/x`,'x');", "ANCHORED"],
  ["floor: concatenation", `writeFile(monorepoRoot + '/x','x');`, "ANCHORED"],
  ["floor: conditional", `writeFile(cond ? monorepoRoot : t,'x');`, "ANCHORED"],
  ["floor: imported checksRoot", `import { checksRoot } from '../run.ts'; writeFile(resolve(checksRoot,'x'),'x');`, "ANCHORED"],
  ["floor: imported repoRoot", `import { repoRoot } from './root.ts'; writeFile(join(repoRoot,'x'),'x');`, "ANCHORED"],
  ["realpath temp root", `const p=await realpath(await mkdtemp(join(tmpdir(),'p-'))); writeFile(join(p,'x'),'x');`, "CLEAN"],
  ["realpath anchored", `const p=await realpath(monorepoRoot); writeFile(p,'x');`, "ANCHORED"],
  ["realpath unknown", `const p=realpath(missing); writeFile(p,'x');`, "UNKNOWN"],
  ["native sync temp root", `const p=realpathSync.native(mkdtempSync(join(tmpdir(),'p-'))); writeFile(p,'x');`, "CLEAN"],
  ["native fs namespace canonical temp", `import * as actualFs from 'node:fs'; const p=actualFs.realpathSync.native(mkdtempSync(join(tmpdir(),'p-'))); actualFs.writeFileSync(p,'x');`, "CLEAN"],
  ["native fs namespace canonical checkout", `import * as actualFs from 'node:fs'; const p=actualFs.realpathSync.native(process.cwd()); actualFs.writeFileSync(p,'x');`, "ANCHORED"],
  ["canonical foreign receiver stays unknown", `import { writeFileSync } from 'node:fs'; const p=foreign.realpathSync.native(mkdtempSync(join(tmpdir(),'p-'))); writeFileSync(p,'x');`, "UNKNOWN"],
  ["canonical namespace parameter shadow stays unknown", `import * as actualFs from 'node:fs'; import { writeFileSync } from 'node:fs'; function f(actualFs){const p=actualFs.realpathSync.native(mkdtempSync(join(tmpdir(),'p-')));writeFileSync(p,'x');}`, "UNKNOWN"],
  ["template clean root", "const p=tmpdir(); const f=`${p}/fixture.txt`; writeFile(f,'x');", "CLEAN"],
  ["template anchored alias", "const p=monorepoRoot; const f=`${p}/fixture.txt`; writeFile(f,'x');", "ANCHORED"],
  ["template unknown root", "const p=external(); writeFile(`${p}/fixture.txt`,'x');", "UNKNOWN"],
  ["template prefixed root", "const p=tmpdir(); writeFile(`prefix/${p}/fixture.txt`,'x');", "UNKNOWN"],
  ["template upward escape", "const p=tmpdir(); writeFile(`${p}/../fixture.txt`,'x');", "UNKNOWN"],
  ["template dynamic suffix", "const p=tmpdir(); writeFile(`${p}/${missing}`,'x');", "UNKNOWN"],
  ["zero arg arrow path", `const p=tmpdir(); const envFile=()=>resolve(p,'.env'); writeFile(envFile(),'x');`, "CLEAN"],
  ["zero arg function path", `const p=tmpdir(); function recipeFile(){ return join(p,'recipe.json'); } writeFile(recipeFile(),'x');`, "CLEAN"],
  ["zero arg block arrow path", `const p=tmpdir(); const file=(): string => { return join(p,'x'); }; writeFile(file(),'x');`, "CLEAN"],
  ["zero arg helper anchored", `const p=monorepoRoot; const envFile=()=>resolve(p,'.env'); writeFile(envFile(),'x');`, "ANCHORED"],
  ["zero arg function anchored", `function recipeFile(){ return join(monorepoRoot,'recipe.json'); } writeFile(recipeFile(),'x');`, "ANCHORED"],
  ["zero arg helper capture reassigned", `let p=tmpdir(); const file=()=>join(p,'x'); p=monorepoRoot; writeFile(file(),'x');`, "ANCHORED"],
  ["zero arg helper caller shadow", `const p=monorepoRoot; const file=()=>join(p,'x'); { const p=tmpdir(); writeFile(file(),'x'); }`, "ANCHORED"],
  ["zero arg helper shadow", `const file=()=>join(tmpdir(),'x'); { const file=()=>join(monorepoRoot,'x'); writeFile(file(),'x'); }`, "ANCHORED"],
  ["zero arg helper reassigned", `let file=()=>join(tmpdir(),'x'); file=external; writeFile(file(),'x');`, "UNKNOWN"],
  ["zero arg helper cycle", `const file=()=>file(); writeFile(file(),'x');`, "UNKNOWN"],
  ["zero arg helper conditional return", `function file(){ if (cond) return monorepoRoot; return tmpdir(); } writeFile(file(),'x');`, "UNKNOWN"],
  ["imported path helper unresolved", `import {envFile} from './deployment.ts'; writeFile(envFile(),'x');`, "UNKNOWN"],
  ["sandbox root arbitrary binding", `const sandbox=await isolatedAppsRoot('p'); writeFile(join(sandbox.root,'x'),'x');`, "CLEAN"],
  ["apps root unbound", `writeFile(apps.root,'x');`, "UNKNOWN"],
  ["apps root unrelated object", `const apps={root:external()}; writeFile(apps.root,'x');`, "UNKNOWN"],
  ["sandbox unrelated member", `const apps=await isolatedAppsRoot('p'); writeFile(apps.other,'x');`, "UNKNOWN"],
  ["sandbox member reassigned", `let apps=await isolatedAppsRoot('p'); apps=external(); writeFile(apps.root,'x');`, "UNKNOWN"],
  ["sandbox member shadow", `const apps=await isolatedAppsRoot('p'); { const apps=external(); writeFile(apps.root,'x'); }`, "UNKNOWN"],
  ["namespace import fs.promises", `import * as fsx from "node:fs"; await fsx.promises.writeFile(resolve(monorepoRoot,"operator-notes.txt"),"GONE");`, "ANCHORED"],
  ["renamed named import", `import { writeFile as wf } from "node:fs/promises"; await wf(resolve(monorepoRoot,"x"),"y");`, "ANCHORED"],
  ["default import", `import fsd from "node:fs"; fsd.writeFileSync(join(monorepoRoot,"x"),"y");`, "ANCHORED"],
  ["named promises import", `import { promises as p } from "node:fs"; await p.unlink(join(monorepoRoot,"x"));`, "ANCHORED"],
  ["require binding", `const f = require("node:fs"); f.rmSync(join(monorepoRoot,"x"));`, "ANCHORED"],
  ["unlink", `await unlink(join(monorepoRoot,"x"));`, "ANCHORED"],
  ["unlinkSync", `unlinkSync(join(monorepoRoot,"x"));`, "ANCHORED"],
  ["rm", `await rm(join(monorepoRoot,"x"),{recursive:true});`, "ANCHORED"],
  ["rmSync", `rmSync(join(monorepoRoot,"x"),{force:true});`, "ANCHORED"],
  ["rmdir", `await rmdir(join(monorepoRoot,"x"));`, "ANCHORED"],
  ["truncate", `await truncate(join(monorepoRoot,"x"),0);`, "ANCHORED"],
  ["open write flag", `import { open } from "node:fs/promises"; await open(join(monorepoRoot,"x"),"w");`, "ANCHORED"],
  ["openSync append flag", `openSync(join(monorepoRoot,"x"),"a+");`, "ANCHORED"],
  ["openSync variable flag", `openSync(join(monorepoRoot,"x"),flag);`, "ANCHORED"],
  ["createWriteStream", `createWriteStream(join(monorepoRoot,"x"));`, "ANCHORED"],
  ["cp destination", `await cp(join(tmpdir(),"a"),join(monorepoRoot,"b"),{recursive:true});`, "ANCHORED"],
  ["cpSync destination", `cpSync(join(tmpdir(),"a"),join(monorepoRoot,"b"));`, "ANCHORED"],
  ["symlink link path", `await symlink(join(tmpdir(),"a"),join(monorepoRoot,"l"));`, "ANCHORED"],
  ["link new path", `await link(join(tmpdir(),"a"),join(monorepoRoot,"l"));`, "ANCHORED"],
  ["utimes", `await utimes(join(monorepoRoot,"x"),0,0);`, "ANCHORED"],
  ["chmod", `await chmod(join(monorepoRoot,"x"),0o644);`, "ANCHORED"],
  ["chown", `chownSync(join(monorepoRoot,"x"),0,0);`, "ANCHORED"],
  ["mkdtemp inside checkout", `await mkdtemp(join(monorepoRoot,"t-"));`, "ANCHORED"],
  ["rename source anchored", `await rename(join(monorepoRoot,"x"),join(tmpdir(),"x"));`, "ANCHORED"],
  ["renameSync source anchored", `renameSync(join(monorepoRoot,"x"),join(tmpdir(),"x"));`, "ANCHORED"],
  ["FAIL backtick git unresolved argv", "spawnSync(`git`,externalArgs,{cwd:monorepoRoot});", "ANCHORED"],
  ["backtick git read-only argv", "spawnSync(`git`,[`status`],{cwd:monorepoRoot});", "CLEAN"],
  ["backtick git unresolved argv temp cwd", "spawnSync(`git`,externalArgs,{cwd:tmpdir()});", "CLEAN"],
  ["interpolated program is not a fixed git word", "spawnSync(`git${suffix}`,externalArgs,{cwd:monorepoRoot});", "CLEAN"],
  ["backtick argv ordinary dollar is fixed", "spawnSync(`git`,[`status`,`$value`],{cwd:monorepoRoot});", "CLEAN"],
  ["FAIL backtick argv interpolation unresolved", "spawnSync(`git`,[`${command}`],{cwd:monorepoRoot});", "ANCHORED"],
  ["git clean", `import { spawnSync } from "node:child_process"; spawnSync("git",["clean","-fdx"],{cwd:monorepoRoot});`, "ANCHORED"],
  ["git checkout -- via runProcess", `import { runProcess } from "#checks/kit/spawn.ts"; await runProcess("git",["checkout","--","."],{cwd:monorepoRoot});`, "ANCHORED"],
  ["git reset --hard exec", `execSync("git reset --hard",{cwd:repoRoot});`, "ANCHORED"],
  ["rm -rf exec", `execSync("rm -rf "+monorepoRoot);`, "ANCHORED"],
  ["Remove-Item spawn", `spawn("powershell",["-Command","Remove-Item",join(monorepoRoot,"x")],{cwd:tmpdir()});`, "ANCHORED"],
  ["del execFile", `execFile("cmd",["/c","del",resolve(monorepoRoot,"x")],{cwd:tmpdir()});`, "ANCHORED"],
  ["git clean without cwd", `spawnSync("git",["clean","-fd"]);`, "ANCHORED"],
  ["namespace child_process", `import * as cp from "node:child_process"; cp.spawnSync("git",["clean","-fd"],{cwd:monorepoRoot});`, "ANCHORED"],
  ["namespace import under temp", `import * as fsx from "node:fs"; await fsx.promises.writeFile(join(tmpdir(),"x"),"y");`, "CLEAN"],
  ["renamed import under temp", `import { writeFile as wf } from "node:fs/promises"; await wf(join(tmpdir(),"x"),"y");`, "CLEAN"],
  ["default import under temp", `import fsd from "node:fs"; fsd.writeFileSync(join(tmpdir(),"x"),"y");`, "CLEAN"],
  ["unlink under temp", `await unlink(join(tmpdir(),"x"));`, "CLEAN"],
  ["rmSync under temp", `rmSync(join(tmpdir(),"x"),{force:true});`, "CLEAN"],
  ["rename within temp", `await rename(join(tmpdir(),"a"),join(tmpdir(),"b"));`, "CLEAN"],
  ["openSync read flag", `openSync(join(monorepoRoot,"x"),"r");`, "CLEAN"],
  ["open without flag", `import { open } from "node:fs/promises"; await open(join(monorepoRoot,"x"));`, "CLEAN"],
  ["git clean in mkdtemp cwd", `const sc = await mkdtemp(join(tmpdir(),"g-")); spawnSync("git",["clean","-fdx"],{cwd:sc});`, "CLEAN"],
  ["git status at checkout", `spawnSync("git",["status"],{cwd:monorepoRoot});`, "CLEAN"],
  ["transport receiver", `transport.writeFile(resolve(monorepoRoot,"x"),"y");`, "CLEAN"],
  ["non-fs import named writeFile", `import { writeFile } from "./transport.ts"; writeFile(resolve(monorepoRoot,"x"),"y");`, "CLEAN"],
  ["copyFile both temp", `copyFile(join(tmpdir(),'a'),join(tmpdir(),'b'));`, "CLEAN"],
  ["writeFile under temp", `writeFile(join(tmpdir(),'x'),'x');`, "CLEAN"],
  ["appendFile under temp", `appendFile(join(tmpdir(),'x'),'x');`, "CLEAN"],
  ["mkdir under temp", `mkdir(join(tmpdir(),'x'));`, "CLEAN"],
  ["mkdtemp under temp", `mkdtemp(join(tmpdir(),'x-'));`, "CLEAN"],
  ["mkdtempSync under temp", `mkdtempSync(join(tmpdir(),'x-'));`, "CLEAN"],
  ["rm under temp", `rm(join(tmpdir(),'x'));`, "CLEAN"],
  ["rmdir under temp", `rmdir(join(tmpdir(),'x'));`, "CLEAN"],
  ["unlinkSync under temp", `unlinkSync(join(tmpdir(),'x'));`, "CLEAN"],
  ["truncate under temp", `truncate(join(tmpdir(),'x'),0);`, "CLEAN"],
  ["createWriteStream under temp", `createWriteStream(join(tmpdir(),'x'));`, "CLEAN"],
  ["utimes under temp", `utimes(join(tmpdir(),'x'),0,0);`, "CLEAN"],
  ["lutimes under temp", `lutimes(join(tmpdir(),'x'),0,0);`, "CLEAN"],
  ["chmod under temp", `chmod(join(tmpdir(),'x'),0o644);`, "CLEAN"],
  ["lchmod under temp", `lchmod(join(tmpdir(),'x'),0o644);`, "CLEAN"],
  ["chown under temp", `chown(join(tmpdir(),'x'),0,0);`, "CLEAN"],
  ["lchown under temp", `lchown(join(tmpdir(),'x'),0,0);`, "CLEAN"],
  ["open under temp", `open(join(tmpdir(),'x'),'w');`, "CLEAN"],
  ["openSync under temp", `openSync(join(tmpdir(),'x'),'a');`, "CLEAN"],
  ["cp both temp", `cp(join(tmpdir(),'a'),join(tmpdir(),'b'));`, "CLEAN"],
  ["cpSync both temp", `cpSync(join(tmpdir(),'a'),join(tmpdir(),'b'));`, "CLEAN"],
  ["symlink both temp", `symlink(join(tmpdir(),'a'),join(tmpdir(),'b'));`, "CLEAN"],
  ["link both temp", `link(join(tmpdir(),'a'),join(tmpdir(),'b'));`, "CLEAN"],
  ["renameSync both temp", `renameSync(join(tmpdir(),'a'),join(tmpdir(),'b'));`, "CLEAN"],
  ["numeric open read", `open(monorepoRoot,0);`, "CLEAN"],
  ["numeric openSync read", `openSync(monorepoRoot,0);`, "CLEAN"],
  ["numeric open conservative", `open(monorepoRoot,1);`, "ANCHORED"],
  ["unprefixed fs", `import * as disk from 'fs'; disk.unlink(monorepoRoot);`, "ANCHORED"],
  ["unprefixed fs promises", `import {unlink as destroy} from 'fs/promises'; destroy(monorepoRoot);`, "ANCHORED"],
  ["unprefixed fs temp", `import * as disk from 'fs'; disk.unlink(join(tmpdir(),'x'));`, "CLEAN"],
  ["unprefixed fs promises temp", `import {unlink as destroy} from 'fs/promises'; destroy(join(tmpdir(),'x'));`, "CLEAN"],
  ["rename source floor", "rename(`${monorepoRoot}/x`,join(tmpdir(),'x'));", "ANCHORED"],
  ["rename destination floor", "rename(join(tmpdir(),'x'),`${monorepoRoot}/x`);", "ANCHORED"],
  ["rmdir child", `spawn('rmdir',[join(monorepoRoot,'x')],{cwd:tmpdir()});`, "ANCHORED"],
  ["exec async destructive", `exec('git reset --hard',{cwd:monorepoRoot});`, "ANCHORED"],
  ["execFileSync destructive", `execFileSync('git',['clean','-fd'],{cwd:monorepoRoot});`, "ANCHORED"],
  ["renamed child binding", `import {spawn as launch} from 'child_process'; launch('git',['clean','-fd'],{cwd:monorepoRoot});`, "ANCHORED"],
  ["child command anchored path", `exec('rm -rf '+join(monorepoRoot,'x'),{cwd:tmpdir()});`, "ANCHORED"],
  ["child literal relative path", `spawn('rm',['-rf','tools/notes.txt'],{cwd:tmpdir()});`, "ANCHORED"],
  ["child literal bare path", `spawn('rm',['-rf','notes.txt'],{cwd:tmpdir()});`, "ANCHORED"],
  ["child git literal path", `spawn('git',['checkout','--','tools/notes.txt'],{cwd:tmpdir()});`, "ANCHORED"],
  ["child shell literal path", `exec('rm -rf tools/notes.txt',{cwd:tmpdir()});`, "ANCHORED"],
  ["child literal absolute temp path", `spawn('rm',['-rf','/tmp/fixture'],{cwd:tmpdir()});`, "CLEAN"],
  ["child command flags not paths", `execFileSync('git',['clean','-fdx'],{cwd:tmpdir()});`, "CLEAN"],
  ["exec async temp", `exec('git clean -fdx',{cwd:tmpdir()});`, "CLEAN"],
  ["rmdir child temp", `spawn('rmdir',[join(tmpdir(),'x')],{cwd:tmpdir()});`, "CLEAN"],
  ["renamed child temp", `import {spawn as launch} from 'child_process'; launch('git',['clean','-fd'],{cwd:tmpdir()});`, "CLEAN"],
  ["FAIL open interpolated flag", "open(monorepoRoot,`${mode}`);", "ANCHORED"],
  ["open interpolated flag temp", "open(join(tmpdir(),'x'),`${mode}`);", "CLEAN"],
  ["open literal template read", "open(monorepoRoot,`r`);", "CLEAN"],
  ["FAIL commented named import", `import { /* destroy */ unlink /* alias */ as wipe } /* module */ from /* specifier */ 'node:fs/promises'; wipe(monorepoRoot);`, "ANCHORED"],
  ["commented import clean", `import { unlink // alias\n as wipe } from 'node:fs/promises'; wipe(join(tmpdir(),'x'));`, "CLEAN"],
  ["commented foreign import", `import { /* foreign */ unlink as wipe } from './transport.ts'; wipe(monorepoRoot);`, "CLEAN"],
  ["comment markers in module preserved", `import { unlink as wipe } from './transport//node:fs'; wipe(monorepoRoot);`, "CLEAN"],
  ["FAIL commented child import", `import { spawnSync /* alias */ as launch } from 'node:child_process'; launch('git',['clean'],{cwd:monorepoRoot});`, "ANCHORED"],
  ["FAIL const argv", `const args=['clean','-fdx']; spawnSync('git',args,{cwd:monorepoRoot});`, "ANCHORED"],
  ["const argv clean cwd", `const args=['clean','-fdx']; spawnSync('git',args,{cwd:tmpdir()});`, "CLEAN"],
  ["const argv status", `const args=['status']; spawnSync('git',args,{cwd:monorepoRoot});`, "CLEAN"],
  ["FAIL let argv reassigned", `let args=['status']; args=['reset','--hard']; spawnSync('git',args,{cwd:monorepoRoot});`, "ANCHORED"],
  ["argv reassigned safe", `let args=['clean']; args=['status']; spawnSync('git',args,{cwd:monorepoRoot});`, "CLEAN"],
  ["argv future assignment ignored", `let args=['status']; spawnSync('git',args,{cwd:monorepoRoot}); args=['clean'];`, "CLEAN"],
  ["FAIL argv lexical shadow", `const args=['status']; { const args=['clean']; spawnSync('git',args,{cwd:monorepoRoot}); }`, "ANCHORED"],
  ["argv lexical clean shadow", `const args=['clean']; { const args=['status']; spawnSync('git',args,{cwd:monorepoRoot}); }`, "CLEAN"],
  ["FAIL argv nearest assignment", `let args=['status']; { args=['clean']; } spawnSync('git',args,{cwd:monorepoRoot});`, "ANCHORED"],
  ["argv sibling assignment", `let args=['status']; { let args=['status']; args=['clean']; } spawnSync('git',args,{cwd:monorepoRoot});`, "CLEAN"],
  ["FAIL unknown argv git", `spawn('git',externalArgs,{cwd:monorepoRoot});`, "ANCHORED"],
  ["FAIL unknown argv rm", `spawn('rm',externalArgs,{cwd:monorepoRoot});`, "ANCHORED"],
  ["FAIL unknown argv del", `spawn('del',externalArgs,{cwd:monorepoRoot});`, "ANCHORED"],
  ["FAIL unknown argv rmdir", `spawn('rmdir',externalArgs,{cwd:monorepoRoot});`, "ANCHORED"],
  ["FAIL unknown argv Remove-Item", `spawn('Remove-Item',externalArgs,{cwd:monorepoRoot});`, "ANCHORED"],
  ["FAIL unknown shell argv", `spawn('sh',['-c',command],{cwd:monorepoRoot});`, "UNKNOWN"],
  ["FAIL unknown cmd argv", `spawn('cmd',['/c',command],{cwd:monorepoRoot});`, "UNKNOWN"],
  ["unknown argv clean cwd", `spawn('git',externalArgs,{cwd:tmpdir()});`, "CLEAN"],
  ["unknown argv unknown cwd", `spawn('git',externalArgs,{cwd:externalCwd});`, "CLEAN"],
  ["FAIL unknown argv inherited cwd", `spawn('git',externalArgs);`, "ANCHORED"],
  ["unknown program unknown argv", `spawn(program,externalArgs,{cwd:monorepoRoot});`, "CLEAN"],
  ["unknown Node argv fails closed", `spawn('node',externalArgs,{cwd:monorepoRoot});`, "UNKNOWN"],
  ["FAIL known destructive unknown program", `spawn(program,['git clean -fd'],{cwd:monorepoRoot});`, "ANCHORED"],
  ["FAIL resolved destructive unknown cwd", `const args=['clean']; spawn('git',args,{cwd:externalCwd});`, "UNKNOWN"],
  ["read-only git spread", `spawn('git',['status',...unknownArgs],{cwd:monorepoRoot});`, "CLEAN"],
  ["read-only git loop table", `for (const args of [['ls-files','-z'],['ls-files','-o']]) { spawn('git',args,{cwd:monorepoRoot}); }`, "CLEAN"],
  ["FAIL mixed git loop table", `for (const args of [['status'],['clean']]) { spawn('git',args,{cwd:monorepoRoot}); }`, "ANCHORED"],
  ["sh stdin not command fallback", `spawn('sh',['-s','--',path,mode]);`, "CLEAN"],
  ["sh command unknown cwd", `spawn('sh',['-c',line],{cwd:externalCwd});`, "UNKNOWN"],
  ["cmd command unknown cwd", `spawn('cmd',['/d','/c',line],{cwd:externalCwd});`, "UNKNOWN"],
  ["FAIL known shell destructive unknown cwd", `spawn('sh',['-c','git clean -fd'],{cwd:externalCwd});`, "UNKNOWN"],
  ["R3 computed fs", `import * as fs from 'node:fs/promises'; fs["writeFile"](join(monorepoRoot,'notes'),'lost');`, "ANCHORED"],
  ["R3 unknown fs member", `import * as fs from 'node:fs'; fs[method](target,'lost');`, "UNKNOWN"],
  ["R3 bound fs", `import {writeFile} from 'node:fs/promises'; const w=writeFile.bind(null); w(join(monorepoRoot,'notes'),'lost');`, "ANCHORED"],
  ["R3 Reflect fs", `import * as fs from 'node:fs'; Reflect.apply(fs.writeFile,null,[join(monorepoRoot,'notes'),'lost']);`, "ANCHORED"],
  ["R3 optional fs", `import * as fs from 'node:fs'; fs.writeFile?.(monorepoRoot,'lost');`, "ANCHORED"],
  ["R3 call fs", `import * as fs from 'node:fs'; fs.writeFile.call(null,monorepoRoot,'lost');`, "ANCHORED"],
  ["R3 apply fs", `import * as fs from 'node:fs'; fs.writeFile.apply(null,[monorepoRoot,'lost']);`, "ANCHORED"],
  ["R3 Node eval writer", `spawnSync(process.execPath,['-e',"require('node:fs').writeFileSync('notes','LOST')"],{cwd:monorepoRoot});`, "ANCHORED"],
  ["R3 Node print writer", `spawnSync('node',['-p',"require('node:fs').unlinkSync('notes')"],{cwd:monorepoRoot});`, "ANCHORED"],
  ["R3 Node script writer", `spawnSync('node',['writeFile-writer.mjs'],{cwd:monorepoRoot});`, "UNKNOWN"],
  ["R3 PowerShell writer", `spawnSync('powershell.exe',['-Command','Set-Content notes LOST'],{cwd:monorepoRoot});`, "ANCHORED"],
  ["R3 shell writer", `spawnSync('bash',['-c','echo LOST > notes'],{cwd:monorepoRoot});`, "ANCHORED"],
  ["R3 unknown apply", `import * as fs from 'node:fs'; fs.writeFile.apply(null,args);`, "UNKNOWN"],
  ["R3 Reflect construct", `import * as fs from 'node:fs'; Reflect.construct(fs.writeFile,[monorepoRoot,'x']);`, "ANCHORED"],
  ["R3 bound target", `import {writeFile} from 'node:fs'; const w=writeFile.bind(null,monorepoRoot); w('x');`, "ANCHORED"],
  ["R3 unknown named member", `import * as fs from 'node:fs'; fs.mystery(target);`, "UNKNOWN"],
  ["R3 computed isolated", `import * as fs from 'node:fs'; fs['writeFile'](join(tmpdir(),'notes'),'x');`, "CLEAN"],
  ["R3 Node isolated", `spawnSync(process.execPath,['-e',"require('node:fs').writeFileSync('notes','x')"],{cwd:tmpdir()});`, "CLEAN"],
  ["R3 prefix assertion", `import * as fs from 'node:fs'; (<any>fs.writeFile)(monorepoRoot,'x');`, "ANCHORED"],
  ["R3 exec shell writer", `execSync('echo LOST > notes',{cwd:monorepoRoot});`, "ANCHORED"],
  ["R3 exec unknown source", `execSync(command,{cwd:monorepoRoot});`, "UNKNOWN"],
  ["R3 exec readonly", `execSync('echo read',{cwd:monorepoRoot});`, "CLEAN"],
  ["R3 parenthesized fs", `import * as fs from 'node:fs'; (fs.writeFile)(monorepoRoot,'x');`, "ANCHORED"],
  ["R3 asserted fs", `import * as fs from 'node:fs'; (fs.writeFile as any)!(monorepoRoot,'x');`, "ANCHORED"],
  ["R3 fallback bound return", `import * as fs from 'node:fs'; const get=fs.writeFile.bind(null); const w=get(); w(monorepoRoot,'x');`, "UNKNOWN"],
  ["R3 fallback asserted unknown", `import * as fs from 'node:fs'; (fs[method] as any)!(monorepoRoot,'x');`, "UNKNOWN"],
  ["R3 parenthesized readonly", `import * as fs from 'node:fs'; (fs.readFile as any)!(monorepoRoot);`, "CLEAN"],
  ["R3 asserted isolated", `import * as fs from 'node:fs'; (fs.writeFile as any)!(join(tmpdir(),'x'),'x');`, "CLEAN"],
  ["copyFile source anchored", `await copyFile(join(monorepoRoot,"a"),join(tmpdir(),"a"));`, "ANCHORED"],
] as const) {
  check(`write-isolation literal: ${name}`, analyze(source).writes.map((hit) => hit.classification), expected === "CLEAN" ? [] : [expected]);
}

for (const [name, source, expected] of [
  ["destructured binding", `const {writeFile:w}=fsp; await w(join(monorepoRoot,"x"),"y");`, ["UNKNOWN", "ANCHORED"]],
  ["member binding", `const w=fsp.writeFile; await w(join(monorepoRoot,"x"),"y");`, ["UNKNOWN", "ANCHORED"]],
  ["R3 assigned bare alias", `import * as fs from 'node:fs'; let w; w=fs.writeFile; w(monorepoRoot,'x');`, ["UNKNOWN", "ANCHORED"]],
  ["R3 array alias", `import * as fs from 'node:fs'; const [w]=[fs.writeFile]; w(monorepoRoot,'x');`, ["UNKNOWN", "ANCHORED"]],
  ["R3 destructured asserted alias", `import * as fs from 'node:fs'; const {writeFile:w}=(fs as any); w(monorepoRoot,'x');`, ["UNKNOWN", "ANCHORED"]],
  ["R3 assigned asserted alias", `import * as fs from 'node:fs'; let w; w=(fs.writeFile!); w(monorepoRoot,'x');`, ["UNKNOWN", "ANCHORED"]],
  ["R3 bound factory return", `import * as fs from 'node:fs'; const get=()=>fs.writeFile.bind(null); const w=get(); w(monorepoRoot,'x');`, ["UNKNOWN", "UNKNOWN"]],
  ["mkdtemp anchored result", `const p=await mkdtemp(join(monorepoRoot,'p-')); writeFile(p,'x');`, ["ANCHORED", "ANCHORED"]],
  ["mkdtempSync anchored result", `const p=mkdtempSync(join(monorepoRoot,'p-')); writeFile(p,'x');`, ["ANCHORED", "ANCHORED"]],
  ["mkdtemp unknown result", `const p=mkdtemp(missing); writeFile(p,'x');`, ["UNKNOWN", "UNKNOWN"]],
] as const) {
  check(`write-isolation literal: ${name}`, analyze(source).writes.map((hit) => hit.classification), expected);
}

check("unbound direct and base are enforced, not approximated",
  analyze(`writeFile(missing,'x'); writeFile(resolve(missing,'f'),'x');`).writes.map((h) => h.approximation), [false, false]);
check("bound helper unknown is disclosed, not CLEAN",
  analyze(`function put(root) { writeFile(root,'x'); }`).writes.map((h) => h.approximation), [true]);

for (const selfCase of SELF_CASES) {
  const result = analyze(selfCase.source);
  const actual = {
    createAppWithoutIsolation: result.createAppWithoutIsolation,
    writes: result.writes.map((hit: Hit) => `${hit.call}[${hit.classification}]`),
  };
  check(`write-isolation self: ${selfCase.name}`, actual, {
    createAppWithoutIsolation: selfCase.createApp,
    writes: selfCase.writes,
  });
}

for (const [name, body, expected] of [
  ["readonly", "console.log('read');", []],
  ["writer", "require('node:fs').writeFileSync('notes','x');", ["ANCHORED"]],
  ["destroyer", "require('node:fs').rmSync('notes');", ["ANCHORED"]],
  ["unknown", "externalWriter();", ["UNKNOWN"]],
] as const) {
  const path = resolve(repoRoot, "fixture-script.mjs");
  const snippet = `const script=resolve(monorepoRoot,'fixture-script.mjs'); spawnSync(process.execPath,['--experimental-strip-types',script],{cwd:monorepoRoot});`;
  check(`R3 script source: ${name}`, analyze(snippet, { root: repoRoot, file: resolve(repoRoot,"probe.ts"), readSource: p => p === path ? body : undefined }).writes.map(h => h.classification), expected);
}
for (const source of [
  "export type NativeTool = 'bash' | 'tar'; import { writeFile } from 'node:fs/promises';",
  "export type { writeFile } from 'node:fs';",
  "export interface Shape { path: string }; import { writeFile } from 'node:fs/promises';",
  "import { writeFile } from 'node:fs/promises'; import { spawnSync, type SpawnSyncReturns } from 'node:child_process'; export type NativeTool = 'bash' | 'tar';",
  "import type { writeFile } from 'node:fs'; export interface Shape { path: string };",
]) check("type-only export carries no runtime filesystem escape", analyze(source).writes, []);

for (const source of [
  "export { writeFile } from 'node:fs';",
  "export type NativeTool = 'bash'; export { writeFile } from 'node:fs';",
  "import { writeFile as type } from 'node:fs'; external(type);",
]) check("runtime re-export still escapes filesystem capability", analyze(source).writes.map(h => h.classification), ["UNKNOWN"]);

const fallbackProbe = `import * as fs from 'node:fs'; const get=fs.writeFile.bind(null); const w=get(); w(monorepoRoot,'x');`;
check("R3 fallback fail-before", analyze(closeCalleeSyntax(fallbackProbe, false)).writes, []);
check("R3 fallback pass-after", analyze(fallbackProbe).writes.map(h => [h.classification, h.approximation]), [["UNKNOWN", true]]);
check("R3 body reader", inspectBody("console.log('read');"), "readonly");
check("R3 source root evaluator", sourcePath("join(monorepoRoot,'tools','clawwright.ts')", { root: repoRoot, file: resolve(repoRoot,"probe.ts") }), resolve(repoRoot,"tools","clawwright.ts"));

// Follow-up witnesses: exact reference-site and tainted-callee classifications.
for (const [name, expression] of [
  ["object literal", "{w:fs.writeFile}"],
  ["array", "[fs.writeFile]"],
  ["conditional", "cond ? fs.writeFile : other"],
  ["logical &&", "cond && fs.writeFile"],
  ["logical ||", "other || fs.writeFile"],
  ["logical ??", "other ?? fs.writeFile"],
  ["comma", "(other,fs.writeFile)"],
  ["spread", "{...fs}"],
  ["call argument", "external(fs.writeFile)"],
  ["return", "()=>{return fs.writeFile;}"],
  ["class field", "class {w=fs.writeFile;}"],
] as const) {
  const source = `import * as fs from 'node:fs'; const box=${expression}; box.w(monorepoRoot,'x');`;
  check(`R3 escape: ${name}`, analyze(source).writes.map(h => h.classification), ["UNKNOWN", "UNKNOWN"]);
}
for (const [name, source] of [
  ["re-export", "export {writeFile} from 'node:fs';"],
  ["child reference", "import {spawn} from 'node:child_process'; external(spawn);"],
] as const) check(`R3 escape: ${name}`, analyze(source).writes.map(h => h.classification), ["UNKNOWN"]);
for (const [name, args, expected] of [
  ["eval separator help", `['-e',"require('node:fs').writeFileSync('notes','x')",'--','--help']`, "ANCHORED"],
  ["attached eval", `['--eval=require(\\'node:fs\\').writeFileSync(\\'notes\\',\\'x\\')','--help']`, "ANCHORED"],
  ["attached print", `['--print=require(\\'node:fs\\').unlinkSync(\\'notes\\')']`, "ANCHORED"],
  ["preload", `['--require','missing.cjs','-e',"console.log('read')"]`, "UNKNOWN"],
  ["attached preload", `['--require=missing.cjs','-e',"console.log('read')"]`, "UNKNOWN"],
  ["import preload", `['--import=missing.mjs','--help']`, "UNKNOWN"],
  ["input type", `['--input-type=module','-e',"console.log('read')"]`, "UNKNOWN"],
  ["script help", `['missing.mjs','--help']`, "UNKNOWN"],
  ["version", `['--version']`, "CLEAN"],
  ["v", `['-v']`, "CLEAN"],
  ["help", `['--help']`, "CLEAN"],
  ["h", `['-h']`, "CLEAN"],
] as const) check(`R3 Node argv: ${name}`, analyze(`spawnSync('node',${args},{cwd:monorepoRoot});`).writes.map(h => h.classification), expected === "CLEAN" ? [] : [expected]);

for (const [name, source] of [
  ["shadow fs escape", "const other={}; const fs=other; import {writeFile} from 'node:fs'; external(writeFile);"],
  ["foreign fs escape", "import fs from './foreign.ts'; import {writeFile} from 'node:fs'; external(writeFile);"],
  ["argument then invocation", "import {writeFile} from 'node:fs'; external(writeFile)();"],
] as const) check(`R3 boundary: ${name}`, analyze(source).writes.filter(h => h.classification === "UNKNOWN").length > 0, true);
const argumentEscape = "import {writeFile} from 'node:fs'; external(writeFile)();";
check("R3 boundary: argument retains reference site", analyze(argumentEscape).writes.some(h => h.target === "writeFile" && h.at === argumentEscape.lastIndexOf("writeFile") && h.approximation === true), true);
for (const body of ["console.log('read')", "process.exit(0)"]) {
  check(`R3 boundary: eval remains capable ${body}`, childBodyCapable("node", "'node'", ["-e", body], body), true);
  check(`R3 boundary: eval inspected readonly ${body}`, analyze(`spawnSync('node',['-e',${JSON.stringify(body)}],{cwd:monorepoRoot});`).writes, []);
}

// --- real-tree scan -----------------------------------------------------------------------

// tools/checks/kit/self/** is skipped: those checks write apps/ decoys on purpose to test
// the run-guard.
const SKIP_SEGMENTS = new Set(["node_modules", "dist"]);
function isSkipped(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]/);
  if (segments.includes("kit") && segments.includes("self")) return true;
  return segments.some((segment) => SKIP_SEGMENTS.has(segment));
}

// Must stay empty — any hit fails the check by name; tighten the rule instead.
const ALLOW: readonly string[] = [];

const files = (await walk(checksRoot)).sort();
// The guard's own file is excluded from the real scan: its self-check table contains the
// anchored patterns by construction (that is exactly what SELF_CASES asserts the analyzer
// flags), so scanning it only re-reports the self-check snippets.
const GUARD_SELF = "tools/checks/foundation/hygiene/static/write-isolation.check.ts";
const writeHits: Array<{ file: string; hit: Hit }> = [];
const createAppOffenders: string[] = [];
let scanned = 0;
for (const file of files) {
  const rel = relative(repoRoot, file).replaceAll("\\", "/");
  if (isSkipped(rel) || rel === GUARD_SELF) continue;
  scanned++;
  const result = analyze(await readFile(file, "utf8"), { root: repoRoot, file });
  for (const hit of result.writes) writeHits.push({ file: rel, hit });
  if (result.createAppWithoutIsolation) createAppOffenders.push(rel);
}

// Bound but unresolved helper/return provenance is disclosed, never labeled CLEAN.
const approximations = writeHits.filter((entry) => entry.hit.approximation);
const unexpectedWrites = writeHits.filter((entry) => !entry.hit.approximation && !ALLOW.includes(entry.file));

check(
  "write-isolation: no checkout-anchored or unresolved write in tools/checks",
  unexpectedWrites.map((entry) => `${entry.file} [${entry.hit.classification} ${entry.hit.call} ${entry.hit.target}]`),
  [],
);
// Shrink-only ratchet: the unresolved count may not exceed the recorded total, and a decrease
// must be recorded (equality) so a stale ceiling cannot hide later growth.
const recorded = JSON.parse(await readFile(resolve(repoRoot, "tools", "checks", "architecture", "baseline.json"), "utf8")) as { writeTargetsUnresolved: { readonly total: number } };
checkTrue("write-isolation: unresolved write targets only shrink (writeTargetsUnresolved in baseline.json)", approximations.length <= recorded.writeTargetsUnresolved.total);
checkTrue("write-isolation: unresolved write targets match the recorded total (lower writeTargetsUnresolved in baseline.json when it shrinks)", approximations.length === recorded.writeTargetsUnresolved.total);
if (approximations.length !== recorded.writeTargetsUnresolved.total) {
  console.error(`write-isolation: ${approximations.length} unresolved approximation targets: ${approximations.map(({ file, hit }) => `${file} [${hit.call} ${hit.target}]`).join(", ")}`);
}
check(
  "write-isolation: no createApp outside an isolated apps sandbox",
  createAppOffenders.filter((file) => !ALLOW.includes(file)),
  [],
);

console.log(
  `write-isolation: ${scanned} files scanned (${files.length} found, 1 guard self-check excluded), ${unexpectedWrites.filter((e) => e.hit.classification === "ANCHORED").length} confirmed anchored writes, ${unexpectedWrites.filter((e) => e.hit.classification === "UNKNOWN").length} unbound targets, ${approximations.length} unknown approximations (recorded ${recorded.writeTargetsUnresolved.total}), ${createAppOffenders.length} unisolated createApp, ${ALLOW.length} allow entries (must stay 0)`,
);
finish("write-isolation");

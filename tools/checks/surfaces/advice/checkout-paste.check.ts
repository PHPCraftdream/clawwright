// R3-A: real checkout-only paste and file-backed Git Bash/native argv witnesses.
// check:requires windows-host, bash
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { monorepoRoot } from "#framework/core/env.ts";
import { CWD_CONFLICT_NOTE } from "#framework/core/io/invocation/render.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { bashCommand, bashEnvironment } from "#checks/kit/capabilities/native-tools.ts";
import { runProcess } from "#checks/kit/spawn.ts";

const bash = await bashCommand();
if (bash === undefined) throw new Error("required Bash selection disappeared");
const root = await mkdtemp(join(tmpdir(), "clawwright-r3a-"));
const checkout = join(root, "checkout $ O'Brien");
const q = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;
const forward = (s: string): string => s.replaceAll("\\", "/");
const timeoutMs = 60_000;
try {
  await mkdir(checkout);
  await cp(join(monorepoRoot, "packages", "clawwright"), join(checkout, "packages", "clawwright"), { recursive: true, filter: (p) => !p.includes(`${String.fromCharCode(92)}dist`) && !p.includes("/dist") });
  for (const file of ["clawwright", "package.json", "tools/clawwright.ts"]) {
    await mkdir(dirname(join(checkout, file)), { recursive: true });
    await cp(join(monorepoRoot, file), join(checkout, file));
  }
  await cp(join(monorepoRoot, "node_modules", "json5"), join(checkout, "node_modules", "json5"), { recursive: true, dereference: true });
  const moduleUrl = (p: string): string => JSON.stringify(pathToFileURL(join(checkout, "packages", "clawwright", p)).href);
  const payload = ['literal $DO_NOT_EXPAND_CF $(printf unexpected-substitution) "$@" $1', 'r3"paired', "r3$TOKEN", "r3'DArcy", "r3Ω雪", ...[1, 2, 3, 4, 5, 6].map((n) => "r3 spaced " + "\\".repeat(n))];
  const declaration = `import { commandBody, materializeCommands } from ${moduleUrl("core/command/spec.ts")};
import * as kinds from ${moduleUrl("core/values/kinds.ts")};
import { deploymentDir } from ${moduleUrl("runtime/deployment.ts")};
import { currentFrame } from ${moduleUrl("core/io/invocation/index.ts")};
import { command } from ${moduleUrl("core/io/invocation/advice.ts")};
import { renderAdviceParts } from ${moduleUrl("core/io/invocation/render.ts")};
const body = commandBody({effect:'read', needs:'local', arguments:[{kind:'variadic',name:'args',description:'witness',value:kinds.text('witness')}], run:async (_on,plan)=> {
console.log('WITNESS '+JSON.stringify({root:deploymentDir(),argv:process.argv.slice(2),values:plan.args}));
if(plan.args[0]==='produce') console.log('ADVICE '+JSON.stringify(renderAdviceParts(command(['status',...${JSON.stringify(payload)}]),currentFrame())[0]));
}});
export default {name:'witness',description:'witness',commands:materializeCommands({status:{summary:'witness',...body}})};`;
  for (const app of ["demo", "aux"]) {
    await mkdir(join(checkout, "apps", app), { recursive: true });
    await writeFile(join(checkout, "apps", app, "app.ts"), declaration);
  }
  const nodeDir = forward(dirname(process.execPath));
  const bashDir = forward(dirname(bash));
  const shellPath = `node_dir=${q(nodeDir)}; bash_dir=${q(bashDir)}\nif command -v cygpath >/dev/null 2>&1; then node_dir=$(cygpath -u "$node_dir") || exit; bash_dir=$(cygpath -u "$bash_dir") || exit; fi\nexport PATH="$node_dir:$bash_dir:/usr/bin:/bin"`;
  let serial = 0;
  const paste = async (body: string, cwd: string) => {
    const script = join(root, `paste-${serial++}.sh`);
    await writeFile(script, `${shellPath}\n${body}\n`);
    return runProcess(bash, [forward(script)], { cwd, timeoutMs, env: bashEnvironment(bash) });
  };
  const cwd = join(checkout, "apps", "demo");
  const produce = await paste(`${q(forward(join(checkout, "clawwright")))} --app aux status produce`, cwd);
  process.stdout.write(`produce ${produce.code}: ${produce.stdout}${produce.stderr}\n`);
  checkTrue("R3-A-1: real shim produces advice", produce.code === 0);
  const row = JSON.parse(produce.stdout.split(/\r?\n/).find((s) => s.startsWith("ADVICE" + String.fromCharCode(32)))?.slice(7) ?? "null") as {line: string; note?: string};
  const selected = JSON.parse(produce.stdout.split(/\r?\n/).find((s) => s.startsWith("WITNESS" + String.fromCharCode(32)))?.slice(8) ?? "null") as {root: string; argv: string[]};
  check("R3-A-1: initial aux root", selected.root, join(checkout, "apps", "aux"));
  check("R3-A-1: initial argv", selected.argv, ["--app", "aux", "status", "produce"]);
  const run = await paste(`${row.note === CWD_CONFLICT_NOTE ? `cd ${q(forward(checkout))}\n` : ""}${row.line}`, cwd);
  process.stdout.write(`R3-A-1 paste exit ${run.code}; row ${JSON.stringify(row)}; ${run.stdout}${run.stderr}`);
  checkTrue("R3-A-1: checkout-only rendered paste exit 0", run.code === 0);
  if (run.code === 0) {
    const answer = JSON.parse(run.stdout.split(/\r?\n/).find((s) => s.startsWith("WITNESS" + String.fromCharCode(32)))?.slice(8) ?? "null") as {root: string; argv: string[]; values: string[]};
    check("R3-A-1: pasted aux root", answer.root, selected.root);
    check("R3-A-1: pasted exact argv", answer.argv, ["--app", "aux", "status", ...payload]);
    check("R3-A-2: real shim repeated tails", answer.values, payload);
  }
  const printer = join(root, "argv.cjs");
  await writeFile(printer, "console.log(JSON.stringify(process.argv.slice(2)))");
  for (const excluded of [false, true]) for (const exec of [false, true]) {
    const body = `${excluded ? "export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'\n" : ""}set -- ${payload.map(q).join(" ")}\nprintf 'PRE:%s\\0' "$@"\nprintf '\\n'\n${exec ? "exec " : ""}${q(forward(process.execPath))} ${q(forward(printer))} "$@"`;
    const script = join(root, `probe-${serial++}.sh`);
    await writeFile(script, body);
    const probe = await runProcess(bash, ["-s"], { input: body, timeoutMs, env: bashEnvironment(bash) });
    const [pre, native] = probe.stdout.split("\n");
    checkTrue("R3-A-2: probe exit 0", probe.code === 0);
    check("R3-A-2: pre-native exact argv", pre?.split("\0").slice(0, -1).map((s) => s.slice(4)), payload);
    check("R3-A-2: native exact argv", JSON.parse(native ?? "null"), payload);
    process.stdout.write(`R3-A-2 excluded=${excluded} exec=${exec} ${JSON.stringify(probe.stdout)}\n`);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
finish("R3-A checkout paste");

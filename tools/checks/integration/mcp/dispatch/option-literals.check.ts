/// <reference lib="es2024.promise" />
// Real CLI dispatch and control-mcp stdio; only the external Docker executable is replaced.
// The fixture reads bounded logs from disk and executes a child option consumer, not argv echoes.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { check, finish, requires } from "#checks/kit/harness.ts";
import { runProcess } from "#checks/kit/spawn.ts";
const dispatch = fileURLToPath(new URL("../progress/option-dispatch.ts", import.meta.url));
  // Every dispatch gets its own throwaway deployment root with identical fixture content: the
  // runs go concurrent (at most four children at once), so no two children may share a writable
  // root — each root carries the same .env/logs.txt/shim and a pre-created data directory.
  async function fillFixture(root: string): Promise<void> {
    const shim = join(root, "docker-fixture.mjs");
    await mkdir(join(root, "data"));
    await writeFile(join(root, ".env"), `OC_TARGET_LOCATION=local\nOC_DATA_DIR=${join(root, "data")}\nOC_COMPOSE_PROJECT=literal-options\nOPENCLAW_GATEWAY_TOKEN=controlled-fixture-only\n`);
    await writeFile(join(root, "logs.txt"), "diagnostic --tail=5\nunrelated line\n");
    await writeFile(shim, `
import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
const [root, command, ...args] = process.argv.slice(2);
function fixtureTarget(path) {
  const base = realpathSync(root);
  const target = resolve(base, relative(resolve(root), resolve(path)));
  const inside = p => { const r = relative(base, p); return r !== '' && r !== '..' && !r.startsWith('../') && !r.startsWith('..\\\\') && !isAbsolute(r); };
  if (!inside(target)) throw new Error('fixture mkdir outside root');
  let parent = target;
  while (parent !== base) {
    try { const info = lstatSync(parent); if (info.isSymbolicLink()) throw new Error('fixture mkdir through symlink'); const actual = realpathSync(parent); if (actual !== base && !inside(actual)) throw new Error('fixture mkdir outside root'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    parent = dirname(parent);
  }
  return target;
}
if (command === 'mkdir') mkdirSync(fixtureTarget(args.at(-1)), { mode: 0o700 });
else if (command !== 'docker') process.exit(90);
else if (args[0] === 'ps' || (args[0] === 'compose' && args.includes('ps'))) process.stdout.write('fixture-container\\n');
else if (args[0] === 'inspect') process.stdout.write('true healthy\\n');
else if (args[0] === 'compose' && args.includes('logs')) {
  const tail = Number(args[args.indexOf('--tail') + 1]);
  const lines = readFileSync(root + '/logs.txt', 'utf8').trimEnd().split('\\n');
  process.stdout.write(lines.slice(-tail).join('\\n') + '\\n');
} else if (args[0] === 'exec') {
  const executable = args[args.indexOf('fixture-container') + 1];
  const values = args.slice(args.indexOf('fixture-container') + 2);
  if (executable === 'node') values.splice(0, 1); // OpenClaw's dist/index.js
  else if (executable !== 'option-consumer') process.exit(91);
  const value = values.find(v => v.startsWith('--message='))?.slice('--message='.length);
  if (!values.includes('--help') || value !== 'two words=--tail') process.exit(92);
  process.stdout.write('child help: two words=--tail\\n');
} else process.exit(93);
`);
  }
  async function run(argv: string[], input = ""): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const root = await mkdtemp(join(tmpdir(), "clawwright-option-literals-"));
    try {
      await fillFixture(root);
      const shim = join(root, "docker-fixture.mjs");
      const result = await runProcess(process.execPath, ["--experimental-strip-types", dispatch, root, shim, ...argv], {
        cwd: root, env: { ...process.env, OC_DEBUG: "0" }, input, timeoutMs: 60000,
      });
      if (result.error !== undefined) throw result.error;
      return result;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  const guardRoot = await mkdtemp(join(tmpdir(), "clawwright-option-guard-"));
  let guardOutside: string | undefined;
  try {
    guardOutside = await mkdtemp(join(tmpdir(), "clawwright-option-outside-"));
    await fillFixture(guardRoot);
    const sentinel = join(guardOutside, "sentinel");
    await writeFile(sentinel, "unchanged");
    const shim = join(guardRoot, "docker-fixture.mjs");
    const invoke = (target: string) => runProcess(process.execPath, [shim, guardRoot, "mkdir", target], { cwd: guardRoot, timeoutMs: 60000 });
    const result = await invoke(join(guardOutside, "new"));
    if (result.error !== undefined) throw result.error;
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /fixture mkdir outside root/);
    await assert.rejects(() => stat(join(guardOutside!, "new")), { code: "ENOENT" });
    assert.equal(await readFile(sentinel, "utf8"), "unchanged");
    const positive = join(guardRoot, "shim-positive");
    const accepted = await invoke(positive);
    if (accepted.error !== undefined) throw accepted.error;
    assert.equal(accepted.code, 0, accepted.stderr);
    assert.equal((await stat(positive)).isDirectory(), true);
    await requires("symlink", "option shim refuses symlink ancestors", async () => {
      await mkdir(join(guardRoot, "real-dir"));
      await symlink(join(guardRoot, "real-dir"), join(guardRoot, "alias"), process.platform === "win32" ? "junction" : "dir");
      const refused = await invoke(join(guardRoot, "alias", "new"));
      if (refused.error !== undefined) throw refused.error;
      assert.notEqual(refused.code, 0);
      assert.match(refused.stderr, /fixture mkdir through symlink/);
      await assert.rejects(() => stat(join(guardRoot, "real-dir", "new")), { code: "ENOENT" });
    });
    const overrides = await runProcess(process.execPath, ["--experimental-strip-types", dispatch, guardRoot, shim, "--fixture-guard-probe", guardOutside], { cwd: guardRoot, timeoutMs: 60000 });
    if (overrides.error !== undefined) throw overrides.error;
    assert.equal(overrides.code, 0, overrides.stderr);
    assert.equal(overrides.stdout, "fixture guard probe passed\n");
  } finally {
    try { await rm(guardRoot, { recursive: true, force: true }); }
    finally { if (guardOutside !== undefined) await rm(guardOutside, { recursive: true, force: true }); }
  }
  // Each task below owns a disjoint set of checks and spawns its own child(ren) against its own
  // root, so the dispatches run concurrently with at most four children alive at a time. Only
  // the printed order of the checks can differ; names and expected values are unchanged.
  const dispatchTasks: Array<() => Promise<void>> = [
    async () => {
      for (const pattern of ["--tail", "--tail=5"]) {
        const result = await run(["logs", `--grep=${pattern}`]);
        check(`CLI literal ${pattern} succeeds`, result.code, 0);
        check(`CLI literal ${pattern} filters only the matching log line`, result.stdout, "diagnostic --tail=5\n");
      }
    },
    async () => {
      const missing = await run(["logs", "--grep", "--tail", "5"]);
      check("a genuinely missing grep value refuses", missing.code, 1);
      check("missing grep never returns bounded log data", missing.stdout.includes("diagnostic"), false);
    },
    async () => {
      const bounded = await run(["logs", "--tail=1", "--since=1h"]);
      check("ordinary inline tail and since still read the requested bound", bounded.stdout, "unrelated line\n");
    },
    async () => {
      const receipts = await run(["set", "receipts", `--set-id=${"a".repeat(64)}`, "--json"]);
      check("another command reads its inline option", receipts.code, 0);
      check("receipts returns the controlled deployment's empty catalog", JSON.parse(receipts.stdout), []);
    },
    async () => {
      for (const name of ["cli", "exec"]) {
        const result = await run([name, "--", ...(name === "exec" ? ["option-consumer"] : []), "--help", "--message=two words=--tail"]);
        check(`${name} executes the child after the bare boundary`, result.code, 0);
        check(`${name} preserves the child option's meaning`, result.stdout, "child help: two words=--tail\n");
      }
    },
    async () => {
      const calls: Array<{ jsonrpc: string; id: number; method: string; params: { name: string; arguments: Record<string, unknown> } }> =
        ["--tail", "--tail=5"].map((grep, index) => ({ jsonrpc: "2.0", id: index + 2, method: "tools/call", params: { name: "logs", arguments: { grep } } }));
      calls.push(...["cli", "exec"].map((name, index) => ({ jsonrpc: "2.0", id: index + 4, method: "tools/call", params: { name, arguments: { confirm: true, args: [...(name === "exec" ? ["option-consumer"] : []), "--help", "--message=two words=--tail"] } } })));
      const server = await run(["control-mcp"], [{ jsonrpc: "2.0", id: 1, method: "initialize" }, ...calls,
        { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "help", arguments: { command: "zz-no-such-command" } } }].map(value => JSON.stringify(value)).join("\n") + "\n");
      check("control-mcp completes the real JSON-RPC exchange", server.code, 0);
      const replies = server.stdout.trim().split("\n").map(line => JSON.parse(line));
      for (const call of calls) {
        const result = replies.find(reply => reply.id === call.id)?.result;
        check(`MCP ${call.id} is not a tool error`, result?.isError === true, false);
        check(`MCP ${call.id} returns consumer output`, result?.content?.[0]?.text, call.params.name === "logs" ? "diagnostic --tail=5" : "child help: two words=--tail");
      }
      // The console's `help <unknown>` exits 1; the tool answers the same refusal as an error result.
      const helpReply = replies.find(reply => reply.id === 8)?.result;
      check("an unknown help target answers as an error, like the console's exit 1", helpReply?.isError, true);
    },
  ];
  const queue = [...dispatchTasks];
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (let task = queue.shift(); task !== undefined; task = queue.shift()) await task();
  }));
  finish("literal options");

// Real piped client -> mcpServe -> DockerRuntime -> subprocess transport.
// Docker is replaced by an executable shim, never by a ready-made ExecResult.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile, rm, symlink, readFile, stat, rename, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ShimTransport } from "#checks/integration/mcp/progress/shim-transport.ts";
import { check, finish, requires, typeAssert } from "#checks/kit/harness.ts";
import { fixtureMutationTarget } from "#checks/integration/mcp/progress/fixture-mutation.ts";
import { runProcess } from "#checks/kit/spawn.ts";
import { ComposeOperations } from "#framework/runtime/docker/compose-operations.ts";
import { type Settings } from "#framework/core/env.ts";
import { machineName, platformProbes } from "#framework/runtime/lock/process-identity.ts";
import type { PathBridge } from "#framework/core/paths.ts";

const bridge = fileURLToPath(new URL("../../integration/mcp/progress/stdio-bridge.ts", import.meta.url));
  const root = await mkdtemp(join(tmpdir(), "clawwright-mcp-stdio-"));
  const shim = join(root, "docker-shim.mjs");
  let outside: string | undefined;
  try {
    outside = await mkdtemp(join(tmpdir(), "clawwright-mcp-outside-"));
    const sentinel = join(outside, "sentinel");
    await writeFile(join(outside, "sentinel"), "unchanged");
    await assert.rejects(() => fixtureMutationTarget(root, sentinel), /FIXTURE_OUTSIDE_ROOT/);
    // Exercise the same overrides used by the bridge, including the cleanup operation.
    const guarded = new ShimTransport(root, shim, "guard");
    await assert.rejects(() => guarded.remove(sentinel), /FIXTURE_OUTSIDE_ROOT/);
    await assert.rejects(() => guarded.writeFile(sentinel, "changed"), /FIXTURE_OUTSIDE_ROOT/);
    assert.equal(await readFile(sentinel, "utf8"), "unchanged");
    await assert.rejects(() => guarded.mkdirp(join(outside, "new")), /FIXTURE_OUTSIDE_ROOT/);
    await assert.rejects(() => stat(join(outside!, "new")), { code: "ENOENT" });
    await requires("symlink", "fixture transport refuses symlink mutations", async () => {
      await mkdir(join(root, "real-dir"));
      await writeFile(join(root, "real-dir", "sentinel"), "unchanged");
      await symlink(join(root, "real-dir"), join(root, "alias"), "junction");
      await symlink(outside!, join(root, "escape"), "junction");
      await symlink(join(outside!, "missing"), join(root, "dangling"), "file");
      for (const path of [join(root, "escape", "sentinel"), join(root, "escape", "new"), join(root, "alias", "sentinel"), join(root, "alias", "new"), join(root, "dangling")]) {
        await assert.rejects(() => guarded.remove(path), /\bFIXTURE_(?:OUTSIDE_)?SYMLINK\b/);
        await assert.rejects(() => guarded.mkdirp(path), /\bFIXTURE_(?:OUTSIDE_)?SYMLINK\b/);
        await assert.rejects(() => guarded.writeFile(path, "changed"), /\bFIXTURE_(?:OUTSIDE_)?SYMLINK\b/);
      }
      assert.equal(await readFile(join(root, "real-dir", "sentinel"), "utf8"), "unchanged");
      assert.equal(await readFile(sentinel, "utf8"), "unchanged");
    });
    await writeFile(shim, `
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
const [root, branch, command, ...args] = process.argv.slice(2);
function fixtureTarget(path) {
  const base = realpathSync(root);
  const target = resolve(base, relative(resolve(root), resolve(path)));
  const inside = p => { const r = relative(base, p); return r !== '' && r !== '..' && !r.startsWith('../') && !r.startsWith('..\\\\') && !isAbsolute(r); };
  if (!inside(target)) throw new Error('FIXTURE_OUTSIDE_ROOT');
  let parent = target;
  while (parent !== base) {
    try { const info = lstatSync(parent); if (info.isSymbolicLink()) throw new Error('FIXTURE_SYMLINK'); const actual = realpathSync(parent); if (actual !== base && !inside(actual)) throw new Error('FIXTURE_OUTSIDE_SYMLINK'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    parent = dirname(parent);
  }
  return target;
}
if (command === 'mkdir') mkdirSync(fixtureTarget(args.at(-1)), { recursive: true, mode: 0o700 });
else if (command === 'finite') {
  process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('finite-eof'));
} else if (command === 'curl') process.stdout.write('200');
else if (args[0] === 'ps' || (args[0] === 'compose' && args.includes('ps'))) {
  if (branch === 'helper' || !args.some(a => a.endsWith('=cli-helper'))) process.stdout.write('container-id\\n');
} else if (args[0] === 'inspect') process.stdout.write('true healthy\\n');
else if (args[0] === 'exec' || args.includes('run')) {
  if (args[0] === 'exec' && (!args.includes('-i') || args.includes('-t'))) process.exit(21);
  if (args.includes('run') && !args.includes('-T')) process.exit(22);
  process.stderr.write('Container shim Starting\\nseparate diagnostic\\n');
  const lines = createInterface({ input: process.stdin });
  lines.on('line', line => {
    const request = JSON.parse(line);
    const response = JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { method: request.method, text: 'Привет 🦞' } }) + '\\r\\n';
    process.stdout.write(response, () => { if (request.method === 'close-child') process.exit(0); });
  });
} else process.exit(23);
`);
    const invokeShim = (target: string) => runProcess(process.execPath, [shim, root, "guard", "mkdir", target], { cwd: root, timeoutMs: 60000 });
    const refused = await invokeShim(join(outside, "shim-new"));
    if (refused.error !== undefined) throw refused.error;
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /FIXTURE_OUTSIDE_ROOT/);
    await assert.rejects(() => stat(join(outside!, "shim-new")), { code: "ENOENT" });
    assert.equal(await readFile(sentinel, "utf8"), "unchanged");
    const inside = join(root, "shim-positive", "nested");
    const accepted = await invokeShim(inside);
    if (accepted.error !== undefined) throw accepted.error;
    assert.equal(accepted.code, 0, accepted.stderr);
    assert.equal((await stat(inside)).isDirectory(), true);
    await requires("symlink", "stdio shim refuses symlink ancestor", async () => {
      const alias = await invokeShim(join(root, "alias", "shim-new"));
      if (alias.error !== undefined) throw alias.error;
      assert.notEqual(alias.code, 0);
      assert.match(alias.stderr, /\bFIXTURE_(?:OUTSIDE_)?SYMLINK\b/);
      await assert.rejects(() => stat(join(root, "real-dir", "shim-new")), { code: "ENOENT" });
      const escaped = await invokeShim(join(root, "escape", "shim-new"));
      if (escaped.error !== undefined) throw escaped.error;
      assert.notEqual(escaped.code, 0);
      assert.match(escaped.stderr, /\bFIXTURE_(?:OUTSIDE_)?SYMLINK\b/);
      await assert.rejects(() => stat(join(outside!, "shim-new")), { code: "ENOENT" });
    });
    // Exercise the real sweep through the same isolated transport and generated mkdir shim.
    const settings = { dataDir: join(root, "sweep-data"), env: { TOKEN: "fixture-token" } } as Settings;
    const locks = join(root, "sweep-data-locks");
    const stale = join(locks, "compose-deaddead");
    const foreign = join(locks, "compose-f0e1cafe");
    await mkdir(stale, { recursive: true });
    await mkdir(foreign);
    await writeFile(join(stale, "owner.json"), JSON.stringify({ pid: process.pid, machine: machineName(), startedAt: "1970-01-01T00:00:00.000Z" }));
    await writeFile(join(stale, "compose.env"), "stale");
    await writeFile(join(foreign, "owner.json"), JSON.stringify({ pid: process.pid, machine: `${machineName()}-elsewhere` }));
    await writeFile(join(foreign, "compose.env"), "foreign");
    const paths = { toTarget: async (path: string) => path } as PathBridge;
    const compose = new ComposeOperations(guarded, () => settings, () => {}, paths, "gateway", "100", undefined);
    let activeDirectory = "";
    const originalStartedAt = platformProbes.processStartedAt;
    try {
      // A live PID with a different recorded start time is provably a reused PID.
      platformProbes.processStartedAt = async () => "2020-01-01T00:00:00.000Z";
      await compose.withEnvFile(async (path) => {
        activeDirectory = join(path, "..");
        await assert.rejects(() => stat(stale), { code: "ENOENT" });
        assert.equal(await readFile(join(foreign, "compose.env"), "utf8"), "foreign");
        assert.match(await readFile(path, "utf8"), /fixture-token/);
      });
    } finally {
      platformProbes.processStartedAt = originalStartedAt;
    }
    assert.notEqual(activeDirectory, "");
    await assert.rejects(() => stat(activeDirectory), { code: "ENOENT" });
    assert.equal(await readFile(join(foreign, "compose.env"), "utf8"), "foreign");
    await requires("symlink", "stale sweep refuses a discovered directory replaced by an escaping symlink", async () => {
      const sweepSettings = { dataDir: join(root, "link-sweep-data"), env: { TOKEN: "fixture-token" } } as Settings;
      const linkLocks = join(root, "link-sweep-data-locks");
      const candidate = join(linkLocks, "compose-abcd1234");
      const displaced = join(root, "displaced-stale");
      const owner = JSON.stringify({ pid: process.pid, machine: machineName(), startedAt: "1970-01-01T00:00:00.000Z" });
      await mkdir(candidate, { recursive: true });
      await writeFile(join(candidate, "owner.json"), owner);
      await writeFile(join(outside!, "owner.json"), owner);
      let swapped = false;
      let refusedRemoval = false;
      class SwapTransport extends ShimTransport {
        override async readFile(path: string): Promise<string> {
          if (resolve(path) === join(candidate, "owner.json")) {
            // listFiles only returns files, not symlink directories. Swap after discovery,
            // before the real sweep reads the owner and attempts its best-effort removal.
            await rename(candidate, displaced);
            await symlink(outside!, candidate, "junction");
            swapped = true;
          }
          return super.readFile(path);
        }
        override async remove(path: string): Promise<void> {
          if (resolve(path) === candidate) {
            try {
              await super.remove(path);
            } catch (error) {
              assert.match((error as Error).message, /\bFIXTURE_(?:OUTSIDE_)?SYMLINK\b/);
              refusedRemoval = true;
              throw error;
            }
            assert.fail("FIXTURE_SWEEP_REMOVED_LINK");
          }
          return super.remove(path);
        }
      }
      const linkCompose = new ComposeOperations(new SwapTransport(root, shim, "guard"), () => sweepSettings, () => {}, paths, "gateway", "100", undefined);
      const previousProbe = platformProbes.processStartedAt;
      try {
        platformProbes.processStartedAt = async () => "2020-01-01T00:00:00.000Z";
        await linkCompose.withEnvFile(async (path) => {
          assert.equal(swapped, true);
          assert.equal(refusedRemoval, true);
          assert.match(await readFile(path, "utf8"), /fixture-token/);
        });
      } finally {
        platformProbes.processStartedAt = previousProbe;
      }
      assert.equal((await lstat(candidate)).isSymbolicLink(), true);
      assert.equal(await readFile(join(outside!, "owner.json"), "utf8"), owner);
      assert.equal(await readFile(sentinel, "utf8"), "unchanged");
      assert.equal(await readFile(join(displaced, "owner.json"), "utf8"), owner);
    });
    for (const branch of ["helper", "fallback"]) {
      for (const ending of ["client-eof", "child-close"]) {
        const child = spawn(process.execPath, ["--experimental-strip-types", bridge, shim, root, branch], {
          cwd: root, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OC_DEBUG: "0" },
        });
        const chunks: Buffer[] = [];
        let stderr = "";
        let pending = Buffer.alloc(0);
        const responses: string[] = [];
        const waiters: Array<(value: string) => void> = [];
        child.stdout.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          pending = Buffer.concat([pending, chunk]);
          for (;;) {
            const newline = pending.indexOf(10);
            if (newline < 0) break;
            const line = pending.subarray(0, newline + 1).toString("utf8");
            pending = pending.subarray(newline + 1);
            const waiter = waiters.shift();
            if (waiter) waiter(line); else responses.push(line);
          }
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => { stderr += chunk; });
        const closed = new Promise<number | null>((resolveClose, rejectClose) => {
          child.once("error", rejectClose);
          child.once("close", resolveClose);
        });
        const deadline = setTimeout(() => { child.kill(); }, 60000);
        const response = () => responses.length > 0
          ? Promise.resolve(responses.shift()!)
          : Promise.race([new Promise<string>((resolveResponse) => waiters.push(resolveResponse)), closed.then(() => { throw new Error(`bridge closed before response: ${stderr}`); })]);
        try {
          let expected = "";
          for (const [id, method] of [[1, "initialize"], [2, "tools/list"], ...(ending === "child-close" ? [[3, "close-child"]] : [])] as Array<[number, string]>) {
            child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method }) + "\n");
            const line = await response();
            const exact = JSON.stringify({ jsonrpc: "2.0", id, result: { method, text: "Привет 🦞" } }) + "\r\n";
            assert.equal(line, exact);
            assert.equal(child.stdin.writableEnded, false);
            expected += exact;
          }
          if (ending === "client-eof") child.stdin.end();
          assert.equal(await closed, 0, stderr);
          assert.equal(Buffer.concat(chunks).toString("utf8"), expected);
          assert.match(stderr, /Container shim Starting\nseparate diagnostic\n/);
          check(`${branch} ${ending}: live requests and exact protocol-only bytes`, true, true);
        } finally {
          clearTimeout(deadline);
          child.kill();
          child.stdin.destroy();
        }
      }
    }
    // An open client pipe must not prevent finite explicit input from closing promptly.
    const finite = spawn(process.execPath, ["--experimental-strip-types", bridge, shim, root, "finite"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    let finiteStderr = "";
    finite.stderr.on("data", chunk => { finiteStderr += chunk; });
    const deadline = setTimeout(() => finite.kill(), 60000);
    try {
      const code = await new Promise<number | null>((resolveClose, rejectClose) => {
        finite.once("error", rejectClose); finite.once("close", resolveClose);
      });
      assert.equal(code, 0, finiteStderr);
      assert.equal(finite.stdin.writableEnded, false);
      typeAssert("finite empty input closes independently of client stdin");
    } finally {
      clearTimeout(deadline); finite.kill(); finite.stdin.destroy();
    }
  } finally {
    try {
      await rm(root, { recursive: true, force: true });
    } finally {
      if (outside !== undefined) await rm(outside, { recursive: true, force: true });
    }
  }
  finish("MCP stdio");

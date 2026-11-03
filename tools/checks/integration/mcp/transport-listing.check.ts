// The two Transport primitives whose failure modes are subtle enough to be worth pinning:
// listFiles (what a mirror needs to see what it should delete) and exists (which must tell
// an absent path apart from a check that could not run at all).
//
// Two implementations, two very different failure modes. The local one walks a real
// directory here, because the mapping from Dirent to a relative POSIX path is exactly where
// a Windows separator would leak into a target-side path. The remote one parses `find`
// output, so it is checked against recorded output rather than a live WSL distribution or
// server: what matters is what is made of the lines, not that find can produce them.

import { mkdtemp, mkdir, writeFile, rm, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { LocalTransport, SshTransport, WslTransport, listFilesVia, existsVia, spawnLocal, withEnvPrefix, describeInvocation } from "#framework/runtime/transport/transport.ts";
import { cannotCheckMessage, cannotSearchMessage, SYMLINK_LOOP, PRESENCE_PROBE } from "#framework/runtime/transport/quoting.ts";
import { STDIN_DELIVERY_FAILED } from "#framework/runtime/transport/exec.ts";
import type { ExecResult, ExecOptions, CommandFailure } from "#framework/runtime/transport/transport.ts";
import { check, finish, requires } from "#checks/kit/harness.ts";

// --- local: a real directory tree -----------------------------------------------------

{
  const dir = await mkdtemp(join(tmpdir(), "clawwright-listing-check-"));
  try {
    const local = new LocalTransport();

    check("a directory that does not exist lists nothing", await local.listFiles(resolve(dir, "absent")), []);
    check("an empty directory lists nothing", await local.listFiles(dir), []);

    const empty = resolve(dir, "empty");
    await mkdir(empty);
    await local.removeEmptyDir(empty);
    check("single-directory removal removes an empty directory", await local.exists(empty), false);

    await writeFile(resolve(dir, "server.ts"), "// server");
    await mkdir(resolve(dir, "data", "sub"), { recursive: true });
    await writeFile(resolve(dir, "data", "page.md"), "# page");
    await writeFile(resolve(dir, "data", "sub", "nested.md"), "# nested");

    const found = (await local.listFiles(dir)).sort();
    check("files at every depth are listed, relative to the directory", found, [
      "data/page.md",
      "data/sub/nested.md",
      "server.ts",
    ]);
    // The paths cross to a target that is POSIX even when this tooling runs on Windows.
    check("no backslash reaches the result", found.some((path) => path.includes("\\")), false);
    // Directories are not files: a mirror that tried to `rm` one of these as a stale file
    // would either fail or take its contents with it.
    check("directories themselves are not listed", found.includes("data"), false);
    let nonemptyRefused = false;
    try { await local.removeEmptyDir(resolve(dir, "data")); } catch { nonemptyRefused = true; }
    check("single-directory removal refuses nonempty directories", nonemptyRefused, true);
    check("refused removal preserves nested files", await local.exists(resolve(dir, "data", "sub", "nested.md")), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- remote: what is made of find's output --------------------------------------------

{
  const bytes = Uint8Array.from([0xff, 0x00, 0x80, 0xc3, 0x28]);
  const result = await spawnLocal(
    process.execPath,
    ["-e", "process.stdin.on('data', chunk => process.stdout.write(chunk.toString('hex')))"],
    { input: bytes },
  );
  check("local exec delivers binary stdin without UTF-8 conversion", result.stdout, Buffer.from(bytes).toString("hex"));
}

{
  const bytes = Uint8Array.from([0xff, 0x00, 0x80]);
  let delivered: string | Uint8Array | undefined;
  const ssh = new SshTransport("example.invalid");
  (ssh as unknown as { exec: (command: string, args: string[], options: ExecOptions) => Promise<ExecResult> }).exec =
    async (_command, _args, options) => {
      delivered = options.input;
      return { code: 0, stdout: "", stderr: "" };
    };
  await ssh.writeFile("/tmp/binary", bytes);
  check("ssh file writes forward binary stdin unchanged", delivered instanceof Uint8Array ? [...delivered] : delivered, [...bytes]);
}

// WSL's `--` mode feeds the command line through the distro's default shell. That silently
// evaluates `$()`, backticks and `$NAME` inside a path or other argv value. `--exec` preserves
// the argument vector while retaining the normal env wrapper used by the transport.
await requires("wsl", "wsl --exec preserves the argument vector", async () => {
  await requires("windows-host", "wsl --exec preserves the argument vector (a windows host)", async () => {
  const integrationDistro = process.env.CLAWWRIGHT_TEST_WSL_DISTRO;
  if (integrationDistro === undefined) return;
  {
    const wsl = new WslTransport(integrationDistro);
    const literal = "backup ' quoted $literal ; `printf expanded` $(printf expanded)";
    const result = await wsl.exec("printf", ["%s", literal], { allowFailure: true });
    check("wsl preserves shell metacharacters in literal argv", result.code, 0);
    check("wsl does not evaluate shell metacharacters", result.stdout, literal);
    const envResult = await wsl.exec("sh", ["-c", "printf '%s' \"$CLAWWRIGHT_ARG\""], {
      allowFailure: true,
      env: { CLAWWRIGHT_ARG: literal },
    });
    check("wsl still passes target environment through argv", envResult.code, 0);
    check("wsl environment values remain literal", envResult.stdout, literal);
  }
  });
});

function execReturning(result: ExecResult) {
  const calls: { command: string; args: string[] }[] = [];
  return {
    calls,
    async exec(command: string, args: string[]): Promise<ExecResult> {
      calls.push({ command, args });
      return result;
    },
  };
}

{
  const stub = execReturning({
    code: 0,
    stdout: "/srv/clawwright/mirror/server.ts\n/srv/clawwright/mirror/data/page.md\n/srv/clawwright/mirror/data/sub/nested.md\n",
    stderr: "",
  });
  const found = await listFilesVia(stub.exec, "/srv/clawwright/mirror");
  check("absolute find output comes back relative", found, ["server.ts", "data/page.md", "data/sub/nested.md"]);
  check("only regular files are asked for", stub.calls[0], { command: "find", args: ["/srv/clawwright/mirror", "-type", "f"] });
}

{
  // A missing directory: find exits non-zero and says so. This is the first-run case — the
  // mirror has never been written — and it must read as "nothing there yet", not as an error
  // that aborts provisioning before it starts.
  const stub = execReturning({ code: 1, stdout: "", stderr: "find: '/srv/clawwright/mirror': No such file or directory" });
  check("a missing listing root lists nothing", await listFilesVia(stub.exec, "/srv/clawwright/mirror"), []);
}

{
  const stub = execReturning({
    code: 1,
    stdout: "/srv/clawwright/mirror/server.ts\n",
    stderr: "find: '/srv/clawwright/mirror/private': Permission denied",
  });
  let message = "";
  try {
    await listFilesVia(stub.exec, "/srv/clawwright/mirror");
  } catch (error) {
    message = (error as Error).message;
  }
  check("permission failure after partial traversal is propagated", message.includes("Permission denied"), true);
}

{
  const stub = execReturning({ code: 1, stdout: "", stderr: "find: '/srv/clawwright/mirror': Permission denied" });
  let rejected = false;
  try {
    await listFilesVia(stub.exec, "/srv/clawwright/mirror");
  } catch {
    rejected = true;
  }
  check("an inaccessible listing root is not treated as missing", rejected, true);
}

{
  // A trailing slash on the directory would otherwise leave every result prefixed with one,
  // and those paths get compared against the recipe's own relative paths.
  const stub = execReturning({ code: 0, stdout: "/srv/clawwright/mirror/server.ts\n", stderr: "" });
  check("a trailing slash on the directory does not survive into the results", await listFilesVia(stub.exec, "/srv/clawwright/mirror/"), ["server.ts"]);
}

{
  // find prints a trailing newline, and an empty line is not a file named "".
  const stub = execReturning({ code: 0, stdout: "\n\n", stderr: "" });
  check("blank lines are not mistaken for files", await listFilesVia(stub.exec, "/srv/clawwright/mirror"), []);
}

// --- exists: "not there" is an answer, "could not ask" is not ---------------------------
//
// `result.code === 0` used to be the whole test, so ssh exiting 255 because it never reached
// the host read as "that path is not there" — and callers act on that. secrets --apply
// rebuilt config/.env from the empty requirement list that follows and deleted the keys it
// no longer believed were needed; restore skips moving live data aside when it believes the
// data directory is absent. Trusting `test -e`'s exit 1 was the same mistake one level down:
// that is what it reports for an existing file it was not allowed to look at.

{
  const dir = await mkdtemp(join(tmpdir(), "clawwright-exists-check-"));
  try {
    const local = new LocalTransport();
    await writeFile(resolve(dir, "here.txt"), "x");
    check("local: a file that is there exists", await local.exists(resolve(dir, "here.txt")), true);
    check("local: a file that is not there does not", await local.exists(resolve(dir, "absent.txt")), false);
    check("local: a path under a missing directory does not either", await local.exists(resolve(dir, "no-dir", "x.txt")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

{
  // The exec-based transports (WSL and SSH share one rule): a shell script decides, and its
  // printed verdict is the answer. The exit code says only whether the probe ran at all,
  // which is why an exit of 0 with nothing on stdout is a failed check rather than a present
  // path — the script always prints one of its three verdicts when it gets to run.
  const probeCalls: { command: string; args: string[]; options: ExecOptions }[] = [];

  function sshWith(result: ExecResult): SshTransport {
    const ssh = new SshTransport("example.invalid");
    (ssh as unknown as { exec: (command: string, args: string[], options: ExecOptions) => Promise<ExecResult> }).exec =
      async (command, args, options) => {
        probeCalls.push({ command, args, options });
        return result;
      };
    return ssh;
  }

  async function refusal(result: ExecResult): Promise<string> {
    try {
      await sshWith(result).exists("/srv/clawwright/data/config/openclaw.json");
      return "";
    } catch (error) {
      return (error as Error).message;
    }
  }

  check("remote: the exists verdict is present", await sshWith({ code: 0, stdout: "exists\n", stderr: "" }).exists("/srv/x"), true);

  // How the probe is delivered is not a detail: wsl.exe re-parses the command line it is
  // handed, and a multi-line script passed as an argument reached the target shell broken
  // ("Syntax error: word unexpected"). On stdin it is data on a pipe, and the path stays an
  // argument, so a space or a quote in it is never syntax.
  check(
    "remote: the path is an argument, never part of the script",
    { command: probeCalls[0]?.command, args: probeCalls[0]?.args },
    { command: "sh", args: ["-s", "--", "/srv/x"] },
  );
  check("remote: and the script itself arrives on stdin", probeCalls[0]?.options.input === PRESENCE_PROBE, true);
  check("remote: the absent verdict is absent", await sshWith({ code: 0, stdout: "absent\n", stderr: "" }).exists("/srv/x"), false);

  // The verdict this whole probe exists for: the path may well be there, and the check was
  // simply not allowed to look. Answering "absent" here is what makes restore skip moving
  // the live data aside and then unpack the archive over it.
  const blocked = await refusal({ code: 0, stdout: "blocked /srv/clawwright/data\n", stderr: "" });
  const probe = "/srv/clawwright/data/config/openclaw.json";
  check("remote: a directory that cannot be entered is not an absent path", blocked.includes(cannotCheckMessage(probe)), true);
  check("remote: the refusal names the directory that blocked the walk", blocked.includes(cannotSearchMessage(probe, "/srv/clawwright/data")), true);

  const unreachable = await refusal({ code: 255, stdout: "", stderr: "ssh: connect to host example.invalid port 22: Network is unreachable" });
  check("remote: a connection failure is not an answer", unreachable.includes(cannotCheckMessage("/srv/clawwright/data/config/openclaw.json")), true);
  check("remote: the refusal names the path it could not check", unreachable.includes("/srv/clawwright/data/config/openclaw.json"), true);
  check("remote: and carries what the transport actually said", unreachable.includes("Network is unreachable"), true);

  const brokenDistro = await refusal({ code: 1, stdout: "", stderr: "There is no distribution with the supplied name." });
  check("remote: a transport failure is the check failing, not an absent path", brokenDistro.includes(cannotCheckMessage("/srv/clawwright/data/config/openclaw.json")), true);

  const silent = await refusal({ code: 0, stdout: "", stderr: "" });
  check("remote: a probe that ran but said nothing is not a present path", silent.includes(cannotCheckMessage("/srv/clawwright/data/config/openclaw.json")), true);
}

// --- exists: the same question asked of a real shell and a real directory ----------------
//
// `test -e` reports an existing file under a directory the user cannot enter exactly as it
// reports a missing one: exit 1, nothing on stderr. Only a real filesystem shows that, so
// this is staged rather than stubbed — a directory with mode 000, files and symlinks around
// it. The symlinks are the half the first fix missed: the reason a stat fails need not be
// anywhere in the path as written.

await requires("linux-host", "local-shell exists checks", async () => {
  if (process.getuid?.() === 0) {
    // root enters a directory whatever its mode, so the case cannot be staged as root.
    process.stderr.write("  skip local-shell exists checks (running as root)\n");
    return;
  }
  {
  const dir = await mkdtemp(join(tmpdir(), "clawwright-exists-shell-"));
  const blockedDir = resolve(dir, "blocked");
  try {
    await mkdir(resolve(blockedDir, "inner"), { recursive: true });
    await writeFile(resolve(blockedDir, "inner", "openclaw.json"), "{}");
    await writeFile(resolve(dir, "reachable.json"), "{}");
    await chmod(blockedDir, 0o000);

    // spawnLocal is what the remote transports wrap; handing it straight to existsVia runs
    // the probe against this machine's own shell, which is all the case needs.
    const shell = (command: string, args: string[], options: ExecOptions) => spawnLocal(command, args, options);

    check("shell: a file that is there exists", await existsVia(shell, resolve(dir, "reachable.json")), true);
    check("shell: a file that is not there does not", await existsVia(shell, resolve(dir, "absent.json")), false);
    check("shell: a path under a missing directory does not either", await existsVia(shell, resolve(dir, "no-dir", "x.json")), false);

    async function refusedBy(path: string): Promise<string> {
      try {
        const answer = await existsVia(shell, path);
        return `answered ${answer}`;
      } catch (error) {
        return (error as Error).message;
      }
    }

    const probePath = resolve(blockedDir, "inner", "openclaw.json");
    const underBlocked = await refusedBy(probePath);
    check("shell: a file under a directory this user cannot enter is not reported absent", underBlocked.includes(cannotCheckMessage(probePath)), true);
    check("shell: and the refusal names the directory that blocked it", underBlocked.includes(cannotSearchMessage(probePath, blockedDir)), true);

    // A symlink moves the question somewhere else entirely: walking the components of the
    // path as written says nothing about what the link points at. This is the shape the
    // deployments actually take — config/openclaw.json is often a link into a directory kept
    // apart — and reading it as "absent" is what makes secrets --apply rewrite config/.env
    // from an empty requirement list and drop a live key.
    await symlink(resolve(blockedDir, "inner", "openclaw.json"), resolve(dir, "into-blocked.json"));
    await symlink(resolve(dir, "reachable.json"), resolve(dir, "into-reachable.json"));
    await symlink(resolve(dir, "never-existed.json"), resolve(dir, "dangling.json"));
    await symlink(resolve(blockedDir, "inner"), resolve(dir, "blocked-dir-link"));
    await symlink(resolve(dir, "loop-b"), resolve(dir, "loop-a"));
    await symlink(resolve(dir, "loop-a"), resolve(dir, "loop-b"));

    check("shell: a symlink to a reachable file exists", await existsVia(shell, resolve(dir, "into-reachable.json")), true);
    check("shell: a symlink to nothing at all is absent", await existsVia(shell, resolve(dir, "dangling.json")), false);

    const linkPath = resolve(dir, "into-blocked.json");
    const throughLink = await refusedBy(linkPath);
    check("shell: a symlink into a directory this user cannot enter is not absent either", throughLink.includes(cannotCheckMessage(linkPath)), true);
    check("shell: and the refusal names the directory, not the link", throughLink.includes(cannotSearchMessage(linkPath, blockedDir)), true);

    const linkedDirPath = resolve(dir, "blocked-dir-link", "openclaw.json");
    const throughLinkedDir = await refusedBy(linkedDirPath);
    check("shell: a symlinked directory is walked like any other", throughLinkedDir.includes(cannotSearchMessage(linkedDirPath, blockedDir)), true);

    const loop = await refusedBy(resolve(dir, "loop-a"));
    check("shell: a symlink loop is an error, not an absent path", loop.includes(SYMLINK_LOOP), true);
  } finally {
    await chmod(blockedDir, 0o755).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}
});

// An env file supplies deployment values to compose; inherited host values for the same
// names must be removed at every transport boundary.
{
  const name = "CLAWWRIGHT_UNSET_ENV_PROBE";
  const result = await spawnLocal(
    process.execPath,
    ["-e", `process.stdout.write(process.env.${name} ?? "missing")`],
    { env: { [name]: "configured" }, unsetEnv: [name] },
  );
  check("local: unsetEnv wins over env", result.stdout, "missing");
  const mixedName = "Clawwright_Unset_Env_Probe";
  const previousMixed = process.env[mixedName];
  process.env[mixedName] = "host-value";
  try {
    const mixed = await spawnLocal(
      process.execPath,
      ["-p", `JSON.stringify(process.env.${mixedName})`],
      { unsetEnv: [name] },
    );
    // A host can force colour on children (FORCE_COLOR), and node -p's inspect output picks
    // it up even into a pipe; compare the value, not the wrapping.
    const answer = stripVTControlCharacters(mixed.stdout).trim();
    check("local: unsetEnv follows platform case rules", answer, process.platform === "win32" ? "undefined" : '"host-value"');
  } finally {
    if (previousMixed === undefined) delete process.env[mixedName];
    else process.env[mixedName] = previousMixed;
  }
  check(
    "remote: unsetEnv carries names only",
    withEnvPrefix("docker", ["compose"], { [name]: "secret-value" }, [name]),
    ["env", ["-u", name, "docker", "compose"]],
  );
}

// A short-lived child can close its stdin while a caller is still writing. The stream error
// must be observed without hiding the child's result or taking down the MCP process.
{
  const input = "x".repeat(256 * 1024);
  const earlyExit = ["-e", "process.stderr.write('early-stderr'); process.exit(1)"];
  const allowed = await spawnLocal(process.execPath, earlyExit, { input, allowFailure: true });
  check("local: early stdin close keeps the exit result", allowed.code, 1);
  check("local: early stdin close keeps stderr", allowed.stderr, "early-stderr");

  let rejected = false;
  try {
    await spawnLocal(process.execPath, earlyExit, { input });
  } catch (error) {
    rejected = (error as Error).message.includes("early-stderr");
  }
  check("local: allowFailure false still rejects the child exit", rejected, true);

  let delivered = true;
  try {
    await spawnLocal(process.execPath, ["-e", "process.exit(0)"], { input });
  } catch (error) {
    delivered = !(error as Error).message.includes(STDIN_DELIVERY_FAILED);
  }
  check("local: code zero with undelivered stdin is not success", delivered, false);

  const echo = await spawnLocal(
    process.execPath,
    ["-e", "let n=0; process.stdin.on('data', chunk => n += chunk.length); process.stdin.on('end', () => process.stdout.write(String(n)))"],
    { input },
  );
  check("local: a fully consumed stdin still succeeds", echo.stdout, String(Buffer.byteLength(input)));

  let forwardedStdout = "";
  let forwardedStderr = "";
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    forwardedStdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    forwardedStderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  let streamed: ExecResult | undefined;
  try {
    streamed = await spawnLocal(
      process.execPath,
      ["-e", "process.stdin.on('data', () => {}); process.stdin.on('end', () => { process.stdout.write('forwarded-out'); process.stderr.write('forwarded-err'); })"],
      { input: "forwarded-input", stream: true },
    );
  } finally {
    process.stdout.write = originalStdoutWrite as typeof process.stdout.write;
    process.stderr.write = originalStderrWrite as typeof process.stderr.write;
  }
  check("local: stream with input forwards stdout", forwardedStdout, "forwarded-out");
  check("local: stream with input forwards stderr", forwardedStderr, "forwarded-err");
  check("local: stream with input still captures stdout", streamed?.stdout, "forwarded-out");
  check("local: stream with input still captures stderr", streamed?.stderr, "forwarded-err");

  let finallyRan = false;
  try {
    await spawnLocal("clawwright-command-that-does-not-exist", [], { input });
  } catch {
    // The caller gets the genuine launch failure.
  } finally {
    finallyRan = true;
  }
  check("local: a missing executable rejects normally", finallyRan, true);
}

// Streaming with no sink and no input used to inherit stdio whenever the caller merely
// asked for `stream: true` — the exact shape `./clawwright status | cat` produces (no MCP
// sink, no input). On Windows that inherits onto an MSYS pipe, and the wsl.exe child this
// wraps (itself relaying Docker Compose) kills the parent Node with exit 139 the moment it
// writes. `streamToTerminal` must also require both descriptors to be a real terminal, so a
// plain pipe always takes the piped-and-forwarded path instead of inheriting a possibly
// unsafe descriptor. Forced false here (rather than relying on this process's own stdio,
// which may or may not be a terminal) so the check is deterministic on every machine; the
// genuinely-inherited branch is not exercised for real, on purpose — that would spawn a
// child with this process's real fd 1/2 inherited, which is exactly the unsafe case above
// when this check itself runs on Windows under a non-terminal stdout.
{
  const originalStdoutIsTTY = process.stdout.isTTY;
  const originalStderrIsTTY = process.stderr.isTTY;

  async function streamedWithoutInput(stdoutIsTTY: boolean | undefined, stderrIsTTY: boolean | undefined) {
    Object.defineProperty(process.stdout, "isTTY", { value: stdoutIsTTY, configurable: true });
    Object.defineProperty(process.stderr, "isTTY", { value: stderrIsTTY, configurable: true });

    let forwardedStdout = "";
    let forwardedStderr = "";
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      forwardedStdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      forwardedStderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      const result = await spawnLocal(
        process.execPath,
        ["-e", "process.stdout.write('piped-out'); process.stderr.write('piped-err')"],
        { stream: true },
      );
      return { result, forwardedStdout, forwardedStderr };
    } finally {
      process.stdout.write = originalStdoutWrite as typeof process.stdout.write;
      process.stderr.write = originalStderrWrite as typeof process.stderr.write;
      Object.defineProperty(process.stdout, "isTTY", { value: originalStdoutIsTTY, configurable: true });
      Object.defineProperty(process.stderr, "isTTY", { value: originalStderrIsTTY, configurable: true });
    }
  }

  // If stdio were inherited here, child.stdout/child.stderr would be null: no "data" event
  // ever fires, so neither the forwarding write nor the captured result would see the
  // child's bytes. Seeing them in both places is proof the descriptors stayed piped.
  {
    const { result, forwardedStdout, forwardedStderr } = await streamedWithoutInput(false, false);
    check("non-tty stdout+stderr: descriptors are not inherited (output still reaches the caller)", result.stdout, "piped-out");
    check("non-tty: stderr is captured too", result.stderr, "piped-err");
    check("non-tty: stdout is forwarded rather than inherited", forwardedStdout, "piped-out");
    check("non-tty: stderr is forwarded rather than inherited", forwardedStderr, "piped-err");
  }

  // isTTY is undefined off a real terminal, not false — the same non-inheriting path must
  // be taken for that value too.
  {
    const { result } = await streamedWithoutInput(undefined, undefined);
    check("undefined tty (the real off-terminal value) does not inherit either", result.stdout, "piped-out");
  }

  // Both descriptors must be a terminal, not just one: a half-piped pair (compose's stdout
  // redirected, stderr still a console, or the reverse) is exactly the shape a pipeline like
  // `2>&1 | cat` can produce, and inheriting only one of the pair is not meaningfully safer.
  {
    const { result } = await streamedWithoutInput(true, false);
    check("tty stdout but non-tty stderr still takes the piped path", result.stdout, "piped-out");
  }
  {
    const { result } = await streamedWithoutInput(false, true);
    check("non-tty stdout but tty stderr still takes the piped path", result.stdout, "piped-out");
  }

  process.stderr.write(
    "  skip the genuinely-inherited branch (both descriptors really a terminal): proving it " +
      "would mean spawning a child with this process's real stdio inherited, which is the same " +
      "unsafe shape the fix above exists to avoid whenever this check itself runs off a terminal\n",
  );
}

// --- a failed command's headline names the action, not ~600 characters of wsl.exe/env/Compose
// plumbing, and Compose's own harmless noise never crowds out (or hides behind) the real
// reason -----------------------------------------------------------------------------------
//
// describeInvocation is pure and checked directly against the exact wrapping shape a real
// call takes (WslTransport.exec's `wsl.exe -d <distro> --exec`, withEnvPrefix's `env -u
// NAME...`, #composeArgs' fixed --env-file/--project-name/--file/--project-directory pairs —
// runtime-docker.ts): unit-testing it needs no wsl.exe, no docker, and no distro, which spawning
// the real thing would (and the hard rule against touching a live deployment forbids).

check(
  "concise action: a wsl.exe/env/compose wrapper shortens to the compose subcommand",
  describeInvocation("wsl.exe", [
    "-d", "Ubuntu-24.04", "--exec",
    "env", "-u", "OPENCLAW_IMAGE", "-u", "OPENCLAW_TAG",
    "docker", "compose",
    "--env-file", "/srv/clawwright/data/compose-9f2a/compose.env",
    "--project-name", "clawwright-demo",
    "--file", "/srv/clawwright/packages/clawwright/docker-compose.yml",
    "--project-directory", "/srv/clawwright/apps/demo",
    "stop", "gateway",
  ]),
  "docker compose stop gateway",
);
check(
  "concise action: the same shortening applies without the wsl.exe layer (a local target)",
  describeInvocation("env", ["-u", "OC_TOKEN", "docker", "compose", "--env-file", "/x/compose.env", "--project-name", "p", "ps"]),
  "docker compose ps",
);
check(
  "concise action: a command with neither wrapper is left exactly as it was",
  describeInvocation("rsync", ["-az", "--delete", "/a/", "user@host:/b/"]),
  "rsync -az --delete /a/ user@host:/b/",
);
check(
  "concise action: -d/--exec without a following env still reaches the real command",
  describeInvocation("wsl.exe", ["-d", "Ubuntu-24.04", "--exec", "docker", "compose", "ps"]),
  "docker compose ps",
);

// A failed `sh -c <script>` (quoting.ts's publishCommand/privateWriteCommand — apply-config's
// own staging write, among others) must never paste its multi-statement body into the
// headline: the real cause is the detail beneath it (stderr), and OC_DEBUG=1 still gets the
// untouched command via CommandFailure.fullCommand.
const PUBLISH_SCRIPT = "temporary=$1; target=$2; trap 'rm -f -- \"$temporary\"' EXIT; cat > \"$temporary\" && mv -f -- \"$temporary\" \"$target\"; status=$?; exit $status";
check(
  "concise action: a local/WSL sh -c script collapses instead of pasting its body",
  describeInvocation("sh", ["-c", PUBLISH_SCRIPT, "sh", "/srv/clawwright/data/config/x.json.clawwright-publish-abcd", "/srv/clawwright/data/config/x.json"]),
  "sh -c …",
);
check(
  "concise action: the same script wrapped in wsl.exe --exec collapses the same way",
  describeInvocation("wsl.exe", ["-d", "Ubuntu-24.04", "--exec", "sh", "-c", PUBLISH_SCRIPT, "sh", "/x.clawwright-publish-abcd", "/x"]),
  "sh -c …",
);
check(
  "concise action: SSH's pre-quoted single-string form collapses too",
  describeInvocation("ssh", ["user@host", `'sh' '-c' '${PUBLISH_SCRIPT}' 'sh' '/x.clawwright-publish-abcd' '/x'`]),
  "ssh user@host sh -c …",
);

// The noise phrase is built at runtime from split halves in the child's own source (below),
// never spelled out contiguously in the script text itself: this spawns via process.execPath,
// which describeInvocation does not shorten, so the source text ends up echoed verbatim into
// the message's own action part — a contiguous literal there would make these checks pass
// for the wrong reason (the phrase surviving in the echoed argv) rather than the right one
// (the phrase surviving, un-filtered, in the detail actually read from stderr/stdout).
const NOISE_LINE_SOURCE = "'time=\"2026-09-27T00:00:00Z\" level=warning msg=\"' + 'No services' + ' to build' + '\"'";

{
  // Compose's own progress warning, verbatim from the bug report, landing alone on stderr
  // while the real reason came back on stdout: the old `stderr.trim() || stdout.trim()`
  // never looked past the first non-empty half, so this exact shape hid the real reason
  // completely.
  const script =
    `process.stderr.write(${NOISE_LINE_SOURCE} + '\\n');` +
    "process.stdout.write('Error response from daemon: dependency failed to start: container exited (1)\\n');" +
    "process.exit(1);";
  let message = "";
  try {
    await spawnLocal(process.execPath, ["-e", script]);
  } catch (error) {
    message = (error as Error).message;
  }
  check("noise filtered: a noise-only stderr defers to the real reason on stdout", message.includes("dependency failed to start"), true);
  check("noise filtered: the harmless warning itself does not appear", message.includes("No services to build"), false);
}

{
  // The real reason and the noise on the same stream: filtering must drop only the noise
  // line, not the whole stream just because part of it is Compose's own chatter.
  const script =
    `process.stderr.write(${NOISE_LINE_SOURCE} + '\\n');` +
    "process.stderr.write('Error: cannot stop container: still in use by another operation\\n');" +
    "process.exit(1);";
  let message = "";
  try {
    await spawnLocal(process.execPath, ["-e", script]);
  } catch (error) {
    message = (error as Error).message;
  }
  check("real stderr kept: the genuine line survives alongside the noise", message.includes("cannot stop container: still in use"), true);
  check("real stderr kept: the noise line next to it is still dropped", message.includes("No services to build"), false);
}

{
  // The full argv is not gone, only out of the default headline: it rides on the rejected
  // error for entry/cli.ts's OC_DEBUG=1 branch to print.
  const args = ["-e", "process.stderr.write('boom'); process.exit(1)"];
  let failure: CommandFailure | undefined;
  try {
    await spawnLocal(process.execPath, args);
  } catch (error) {
    failure = error as CommandFailure;
  }
  check("the concise headline names the action and keeps the real detail", failure?.message.includes("boom"), true);
  check("the full argv survives on the error for OC_DEBUG", failure?.fullCommand, `${process.execPath} ${args.join(" ")}`);
}

// A deadline the child can outwait is not a deadline: spawnLocal must END the child at
// timeoutMs, not merely remember the number.
{
  const started = Date.now();
  const killed = await spawnLocal(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 800, allowFailure: true });
  check("local: a child past its deadline is killed, not waited on", killed.code !== 0, true);
  check("local: the kill lands near the deadline", Date.now() - started < 7000, true);
}

// The escalation half the block above cannot see: that child dies on the SIGTERM itself,
// so it proves nothing about what happens when SIGTERM is not enough. This child provably
// ignores SIGTERM — on POSIX a handled signal replaces the default termination, so an
// empty handler survives the first kill, and only the delayed SIGKILL (the 5s grace
// spawnLocal pins) can end it. The 9s self-exit is a failsafe, not the success path: if
// the escalation ever breaks, the child outlives it and exits 0 on its own, so these
// checks fail within seconds instead of hanging the suite. Windows cannot run this
// premise at all: kill() there is TerminateProcess whatever the signal name, so nothing
// can ignore SIGTERM — on Windows only the bounded-ending half of the promise is
// observable, which is why the grace-window check is POSIX-only.
{
  const ignoresTerm = ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 9000);"];
  const started = Date.now();
  const escalated = await spawnLocal(process.execPath, ignoresTerm, { timeoutMs: 600, allowFailure: true });
  const elapsed = Date.now() - started;
  check("local: a child that ignores SIGTERM is still ended by the deadline path", escalated.code !== 0, true);
  check("local: the end came from the SIGKILL grace, not the deadline's own SIGTERM", process.platform === "win32" || elapsed > 5000, true);
  check("local: the escalation lands well inside the child's failsafe window", elapsed < 8500, true);
}

finish("transport listing");

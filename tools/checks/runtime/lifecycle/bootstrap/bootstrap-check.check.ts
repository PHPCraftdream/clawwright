// `./clawwright bootstrap --check` — read-only prerequisite report.
//
// Covers the pure parsers (prereqs.ts), the report format and exit-code contract (check.ts),
// and proves the flag itself is exempt from both the NOT_BOOTSTRAPPED guard and instance
// locking (requires-bootstrapped.check.ts's own header explains why bootstrap, which creates
// the instance, must never gain that guard — this proves --check keeps that exemption too,
// and additionally never takes the lock guardedWith() would).

import { bootstrapCheck } from "#framework/commands/lifecycle/bootstrap/check.ts";
import {
  parseDockerInfo,
  parseComposeVersion,
  parseDiskSpace,
  parseGnuUserlandCheck,
  runPrereqProbes,
  GNU_USERLAND_PROBE_SCRIPT,
} from "#framework/commands/lifecycle/bootstrap/prereqs.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { spawnLocal, TransportUnreachableError } from "#framework/runtime/transport/transport.ts";
import type { Context } from "#framework/core/context.ts";
import { check, finish, requires } from "#checks/kit/harness.ts";
import { asDirectTest } from "#checks/runtime/service/restore/file-test-stub.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";

// --- pure parsers: fed a canned ExecResult, nothing else -------------------------------------

check("parseDockerInfo: exit 0 is ok, and names the server version", parseDockerInfo({ code: 0, stdout: "27.3.1\n", stderr: "" }), { status: "ok", what: "docker daemon is reachable (server 27.3.1)" });
check("parseDockerInfo: exit 0 with no version still reads ok", parseDockerInfo({ code: 0, stdout: "", stderr: "" }).status, "ok");
check("parseDockerInfo: nonzero exit is fail, with a next step", parseDockerInfo({ code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" }).status, "fail");

check("parseComposeVersion: exit 0 is ok", parseComposeVersion({ code: 0, stdout: "Docker Compose version v2.29.0\n", stderr: "" }).status, "ok");
check("parseComposeVersion: nonzero exit is fail", parseComposeVersion({ code: 1, stdout: "", stderr: "" }).status, "fail");

{
  const belowThreshold = parseDiskSpace("/srv", { code: 0, stdout: "Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 100 1 1024 1% /\n", stderr: "" }, 5120);
  check("parseDiskSpace: below the threshold warns, never fails", belowThreshold.status, "warn");
  check("...and names both the path and the threshold's own remedy", belowThreshold.next?.includes("OC_DATA_DIR") ?? false, true);

  const aboveThreshold = parseDiskSpace("/srv", { code: 0, stdout: "Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 100 1 20971520 1% /\n", stderr: "" }, 5120);
  check("parseDiskSpace: at/above the threshold is ok", aboveThreshold.status, "ok");

  const unparseable = parseDiskSpace("/srv", { code: 0, stdout: "not df output", stderr: "" }, 5120);
  check("parseDiskSpace: output it cannot parse warns, not fails", unparseable.status, "warn");

  const dfFailed = parseDiskSpace("/srv", { code: 1, stdout: "", stderr: "no such file" }, 5120);
  check("parseDiskSpace: df itself failing warns, not fails", dfFailed.status, "warn");
}

// --- parseGnuUserlandCheck: pure parser over the GNU-capability probe's own output -----------

const FULL_GNU_OUTPUT = "find-printf=ok\nstat-c=ok\nreadlink-f=ok\nsha256sum=ok\ntar-numeric-owner=ok\nproc=ok\n";
// find lacks -printf, stat lacks -c, no GNU tar — readlink -f, sha256sum and /proc are all
// still applets/kernel features BusyBox (Alpine without coreutils) carries just fine.
const BUSYBOX_OUTPUT = "find-printf=missing\nstat-c=missing\nreadlink-f=ok\nsha256sum=ok\ntar-numeric-owner=missing\nproc=ok\n";
// A BSD/macOS ssh target: none of find/stat/readlink/tar are the GNU variant, no sha256sum
// binary at all (shasum -a 256 is what macOS ships), and no /proc.
const BSD_MAC_OUTPUT = "find-printf=missing\nstat-c=missing\nreadlink-f=missing\nsha256sum=missing\ntar-numeric-owner=missing\nproc=missing\n";

{
  const full = parseGnuUserlandCheck({ code: 0, stdout: FULL_GNU_OUTPUT, stderr: "" });
  check("parseGnuUserlandCheck: a full GNU userland is ok", full.status, "ok");

  const busybox = parseGnuUserlandCheck({ code: 0, stdout: BUSYBOX_OUTPUT, stderr: "" });
  check("parseGnuUserlandCheck: BusyBox (partial) fails", busybox.status, "fail");
  check("...naming the missing tools", busybox.what, "target lacks GNU find -printf (findutils), stat -c (coreutils), tar --numeric-owner");
  check("...with an install step naming the exact packages, not a guessed distro", busybox.next, "install findutils coreutils tar — `apk add findutils coreutils tar` on Alpine, `apt-get install -y findutils coreutils tar` on Debian/Ubuntu");

  const bsdMac = parseGnuUserlandCheck({ code: 0, stdout: BSD_MAC_OUTPUT, stderr: "" });
  check("parseGnuUserlandCheck: a BSD/macOS target (everything missing) fails", bsdMac.status, "fail");
  check("...as 'not a GNU/Linux userland' rather than 'missing a package'", bsdMac.next, "use a Linux target; macOS is only supported as an ssh host");

  const partial = parseGnuUserlandCheck({ code: 0, stdout: "find-printf=ok\nstat-c=ok\n", stderr: "" });
  check("parseGnuUserlandCheck: partial output treats unreported capabilities as missing", partial.status, "fail");
  check("...naming only what never reported ok", partial.what, "target lacks GNU readlink -f (coreutils), sha256sum (coreutils), tar --numeric-owner, /proc");

  const proc = parseGnuUserlandCheck({ code: 0, stdout: "find-printf=ok\nstat-c=ok\nreadlink-f=ok\nsha256sum=ok\ntar-numeric-owner=ok\nproc=missing\n", stderr: "" });
  check("parseGnuUserlandCheck: /proc alone missing fails and offers to mount it", proc.status, "fail");
  check("...alongside the Linux-target fallback, not instead of it", proc.next?.includes("mount /proc") ?? false, true);

  const empty = parseGnuUserlandCheck({ code: 1, stdout: "", stderr: "" });
  check("parseGnuUserlandCheck: empty output warns rather than assuming every tool is missing", empty.status, "warn");

  const noisy = parseGnuUserlandCheck({ code: 0, stdout: "Welcome to BusyBox\nfind-printf=ok\nstat-c=ok\nreadlink-f=ok\nsha256sum=ok\ntar-numeric-owner=ok\nproc=ok\n", stderr: "" });
  check("parseGnuUserlandCheck: an unrecognized line (shell banner) is ignored, not misread", noisy.status, "ok");
}

// --- the directory/port/disk probes against a stub transport ---------------------------------

interface StubOptions {
  readonly exists?: (path: string) => boolean;
  readonly exec?: (command: string, args: string[]) => { code: number; stdout: string; stderr: string } | undefined;
}

function stubCtx(options: StubOptions = {}): { ctx: Context; execCalls: string[][] } {
  const execCalls: string[][] = [];
  const ctx = {
    settings: {
      dataDir: "/srv/app/data",
      backupDir: "/srv/app/backups",
      snapshotDir: "/srv/app/snapshots",
      bindAddress: "127.0.0.1",
      gatewayPort: "18789",
    },
    transport: {
      description: "stub",
      async exists(path: string): Promise<boolean> {
        return options.exists?.(path) ?? false;
      },
      async exec(rawCommand: string, rawArgs: string[], execOptions: { allowFailure?: boolean } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
        const { command, args } = asDirectTest(rawCommand, rawArgs);
        execCalls.push([command, ...args]);
        const handled = options.exec?.(command, args);
        if (handled !== undefined) return handled;
        if (execOptions.allowFailure === true) return { code: 1, stdout: "", stderr: "" };
        throw new Error(`unexpected exec: ${command} ${args.join(" ")}`);
      },
      async readFile(): Promise<string> { throw new Error("prereqs must never read a file"); },
      async writeFile(): Promise<void> { throw new Error("prereqs must never write a file"); },
      async mkdirp(): Promise<void> { throw new Error("prereqs must never create a directory"); },
      async remove(): Promise<void> { throw new Error("prereqs must never remove anything"); },
    },
    runtime: {
      async isRunning(): Promise<boolean> { throw new Error("bootstrap --check must never ask the runtime whether it is running"); },
    },
  } as unknown as Context;
  return { ctx, execCalls };
}

/** Every probe healthy: docker, compose, all three directories writable, the port free, and
 *  ample disk — the baseline every negative case below starts from and deviates one probe at
 *  a time. */
function healthyExecHandler(command: string, args: string[]): { code: number; stdout: string; stderr: string } | undefined {
  if (command === "docker" && args[0] === "info") return { code: 0, stdout: "27.3.1\n", stderr: "" };
  if (command === "docker" && args[0] === "compose") return { code: 0, stdout: "Docker Compose version v2.29.0\n", stderr: "" };
  if (command === "test" && args[0] === "-w") return { code: 0, stdout: "", stderr: "" };
  if (command === "ss") return { code: 0, stdout: "LISTEN 0 128 127.0.0.1:9999 *:*\n", stderr: "" };
  if (command === "df") return { code: 0, stdout: "Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 100 1 20971520 1% /\n", stderr: "" };
  if (command === "sh" && args[0] === "-s") return { code: 0, stdout: FULL_GNU_OUTPUT, stderr: "" };
  return undefined;
}

{
  const { ctx } = stubCtx({ exec: healthyExecHandler });
  const results = await runPrereqProbes(ctx);
  check("eight prerequisites are probed (one line each)", results.length, 8);
  check("a fully healthy target reports every prerequisite ok", results.every((result) => result.status === "ok"), true);
}

{
  const { ctx } = stubCtx({
    exec: (command, args) => {
      if (command === "sh" && args[0] === "-s") return { code: 0, stdout: BUSYBOX_OUTPUT, stderr: "" };
      return healthyExecHandler(command, args);
    },
  });
  const results = await runPrereqProbes(ctx);
  check("a BusyBox target fails the GNU-userland prerequisite", results[7]?.status, "fail");
  check("...without failing the others", results.slice(0, 7).every((result) => result.status === "ok"), true);
}

{
  const { ctx } = stubCtx({
    exec: (command, args) => {
      if (command === "sh" && args[0] === "-s") throw new Error("spawn sh ENOENT");
      return healthyExecHandler(command, args);
    },
  });
  const results = await runPrereqProbes(ctx);
  check("no sh on the target fails the GNU-userland prerequisite instead of throwing", results[7]?.status, "fail");
}

{
  const { ctx } = stubCtx({
    exec: (command, args) => {
      if (command === "docker" && args[0] === "info") return { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" };
      return healthyExecHandler(command, args);
    },
  });
  const results = await runPrereqProbes(ctx);
  check("docker daemon unreachable fails that one prerequisite", results[0]?.status, "fail");
  check("...without failing the others", results.slice(1).every((result) => result.status === "ok"), true);
}

{
  // A directory that is not writable, but whose target user CAN be named: the ready line uses
  // that name, never the fixed numeric owner real bootstrap's own mid-mutation refusal does
  // (datadir.ts's OWNER) — this line is for a person about to type it.
  const { ctx } = stubCtx({
    exec: (command, args) => {
      if (command === "test" && args[0] === "-w") return { code: 1, stdout: "", stderr: "" };
      if (command === "id" && args[0] === "-un") return { code: 0, stdout: "alice\n", stderr: "" };
      if (command === "id" && args[0] === "-gn") return { code: 0, stdout: "alice\n", stderr: "" };
      return healthyExecHandler(command, args);
    },
  });
  const results = await runPrereqProbes(ctx);
  const dataDirResult = results[2];
  check("an unwritable data directory fails", dataDirResult?.status, "fail");
  check("the ready line names the target user's own login", dataDirResult?.next, "sudo install -d -o alice -g alice /srv/app/data");
}

{
  // The identity cannot be read at all: the ready line still names a runnable command, never
  // a guessed uid.
  const { ctx } = stubCtx({
    exec: (command, args) => {
      if (command === "test" && args[0] === "-w") return { code: 1, stdout: "", stderr: "" };
      if (command === "id") return { code: 1, stdout: "", stderr: "" };
      return healthyExecHandler(command, args);
    },
  });
  const results = await runPrereqProbes(ctx);
  check("an unreadable identity still produces a ready line", results[2]?.next, "sudo install -d /srv/app/data  (then hand it to whoever runs ./clawwright bootstrap)");
}

{
  const { ctx } = stubCtx({
    exec: (command, args) => {
      if (command === "ss") return { code: 0, stdout: "LISTEN 0 128 127.0.0.1:18789 *:*\n", stderr: "" };
      return healthyExecHandler(command, args);
    },
  });
  const results = await runPrereqProbes(ctx);
  check("the configured gateway port already listening fails that prerequisite", results[5]?.status, "fail");
  check("naming the address:port actually found", results[5]?.what.includes("127.0.0.1:18789"), true);
}

{
  const { ctx } = stubCtx({
    exec: (command, args) => {
      if (command === "ss" || command === "netstat") return { code: 1, stdout: "", stderr: "" };
      return healthyExecHandler(command, args);
    },
  });
  const results = await runPrereqProbes(ctx);
  check("neither ss nor netstat answering warns, never fails — bootstrap's own preflight still runs later", results[5]?.status, "warn");
}

// --- TransportUnreachableError short-circuits the whole report, never a partial one ----------

{
  const { ctx } = stubCtx({
    exec: () => {
      throw new TransportUnreachableError("wsl.exe never reached the target", "check OC_WSL_DISTRO");
    },
  });
  let threw: Error | undefined;
  let said = "";
  await withOutputSink(
    (chunk) => { said += chunk; },
    async () => {
      try {
        await bootstrapCheck(ctx);
      } catch (error) {
        threw = error as Error;
      }
    },
  );
  check("an unreachable transport reports TARGET_UNREACHABLE rather than a stack trace", threw?.message?.includes("TARGET_UNREACHABLE") ?? false, true);
  check("the transport's own message reaches the printed report", said.includes("wsl.exe never reached the target"), true);
}

// --- the report format and exit-code contract -------------------------------------------------

{
  const { ctx } = stubCtx({ exec: healthyExecHandler });
  let threw = false;
  let said = "";
  await withOutputSink(
    (chunk) => { said += chunk; },
    async () => {
      try {
        await bootstrapCheck(ctx);
      } catch {
        threw = true;
      }
    },
  );
  check("a fully healthy target exits 0 (no throw)", threw, false);
  check("every line reads ok — the exact prerequisite report format", /ok\s+docker daemon is reachable/.test(said), true);
}

{
  const { ctx } = stubCtx({
    exec: (command, args) => {
      if (command === "docker" && args[0] === "info") return { code: 1, stdout: "", stderr: "" };
      return healthyExecHandler(command, args);
    },
  });
  let threw = false;
  let said = "";
  await withOutputSink(
    (chunk) => { said += chunk; },
    async () => {
      try {
        await bootstrapCheck(ctx);
      } catch {
        threw = true;
      }
    },
  );
  check("at least one FAIL exits non-zero (throws)", threw, true);
  check("the FAIL line is printed with that exact label", /FAIL /.test(said), true);
}

// --- bootstrap --check itself: exempt from the NOT_BOOTSTRAPPED guard and from locking -------

{
  const { ctx, execCalls } = stubCtx({ exec: healthyExecHandler });
  let threw: Error | undefined;
  await withOutputSink(
    () => {},
    async () => {
      try {
        await openclawCommands.bootstrap.run(ctx, ["--check"]);
      } catch (error) {
        threw = error as Error;
      }
    },
  );
  check("bootstrap --check never asks the runtime whether it is running (no NOT_BOOTSTRAPPED guard)", threw?.message?.includes("must never ask the runtime") ?? false, false);
  check("and never attempts the instance lock", execCalls.some((call) => call.some((token) => token.includes("operation.lock"))), false);
  check("nor the mutation guard", execCalls.some((call) => call.some((token) => token.includes("operation.mutation"))), false);
}

// --- the probe script itself is dash-compatible POSIX sh, run for real when sh exists --------
//
// Never wsl.exe: this only proves the script text parses and runs under A POSIX sh, which any
// dash-compatible target's own sh already is — a real target's own set of ok/missing answers
// is not this machine's to assert on, so only the LINE FORMAT is checked, never which
// capabilities this machine happens to have.

await requires("posix-sh", "GNU-userland probe script under a real sh", async () => {
  const result = await spawnLocal("sh", ["-s"], { input: GNU_USERLAND_PROBE_SCRIPT, allowFailure: true });
  const lines = result.stdout.split(/\r?\n/).filter((line) => line !== "");
  const expectedKeys = ["find-printf", "stat-c", "readlink-f", "sha256sum", "tar-numeric-owner", "proc"];
  check("the script exits 0 under a real sh (no syntax error)", result.code, 0);
  check("it prints exactly one line per capability, well-formed and in order", lines.map((line) => line.split("=")[0]), expectedKeys);
  check(
    "every line is `<capability>=ok` or `<capability>=missing` — never which this machine has",
    lines.every((line) => /^[a-z0-9-]+=(ok|missing)$/.test(line)),
    true,
  );
});

finish("bootstrap --check");

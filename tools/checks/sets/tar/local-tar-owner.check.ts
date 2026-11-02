// The owner module itself (packages/clawwright/set/artifacts/tar.ts) against the REAL local tar:
// spaces in every path, backslashed -C dirs (rf6-fix33), drive-letter absolute -C (the
// --force-local case), and failure noise that stays tar's own — never remote-host noise.
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { tarCreateArchive, tarExtractArchive, tarListArchive, runLocalTar, withLocalTarRunner, type LocalTarRunner } from "#framework/set/artifacts/tar.ts";
import { spawnLocal, tarLocalFlags } from "#framework/runtime/transport/transport.ts";
import { check, checkTrue, finish, requires } from "#checks/kit/harness.ts";

const noise = (text: string | undefined) => text !== undefined && /Cannot connect to/u.test(text);

const FORCE_LOCAL_REFUSAL = "tar: Option --force-local is not supported\n";

// Fixtures live under the OS temp dir only; every group reuses one root, removed in finally.
const root = await mkdtemp(join(tmpdir(), "clawwright-local-tar-owner-"));
try {
  await requires("gnu-userland", "create+list+extract round-trip with spaces in every path", async () => {
    const src = join(root, "claw forge src");
    const entries = new Map([
      ["plain.txt", "plain content\n"],
      ["nested dir/inner file with space.txt", "spaced content\n"],
      ["nested dir/deep/leaf.txt", "leaf content\n"],
    ]);
    for (const [name, content] of entries) {
      await mkdir(join(src, name, ".."), { recursive: true });
      await writeFile(join(src, name), content, "utf8");
    }
    const archive = join(root, "archive with spaces.tar.gz");
    const dest = join(root, "dest with spaces");
    await mkdir(dest, { recursive: true });
    check("create code", (await tarCreateArchive(archive, src)).code, 0);
    const listed = await tarListArchive(archive);
    check("list code", listed.code, 0);
    for (const name of entries.keys()) checkTrue(`list names ${name}`, (listed.stdout + listed.stderr).includes(name));
    check("extract code", (await tarExtractArchive(archive, dest)).code, 0);
    for (const [name, content] of entries) {
      check(`round-trip ${name}`, (await readFile(join(dest, name))).toString("utf8"), content);
    }
  });

  await requires("gnu-userland", "a backslash -C directory unpacks instead of decoding escapes (rf6-fix33/fix33-Y class)", async () => {
    // join() yields backslashes throughout on win32; the `tom` component makes the classic
    // \t escape case literal there (win32/TEMP backslashes). On POSIX backslash spellings
    // are meaningless — the plain path just proves the round-trip.
    const src = join(root, "tom", "backslash src");
    checkTrue("the staging path uses the platform separator", src.includes(sep));
    const entries = new Map([["file.txt", "backslash content\n"]]);
    await mkdir(src, { recursive: true });
    for (const [name, content] of entries) await writeFile(join(src, name), content, "utf8");
    const archive = join(root, "backslash-archive.tar.gz");
    const dest = join(root, "backslash-dest");
    await mkdir(dest, { recursive: true });
    check("backslash: create code", (await tarCreateArchive(archive, src)).code, 0);
    check("backslash: list code", (await tarListArchive(archive)).code, 0);
    check("backslash: extract code", (await tarExtractArchive(archive, dest)).code, 0);
    for (const [name, content] of entries) {
      check("backslash: round-trip", (await readFile(join(dest, name))).toString("utf8"), content);
    }
  });

  await requires("gnu-userland", "a drive-letter absolute -C path works on win32", async () => {
    const src = resolve(root, "absolute src");
    await mkdir(src, { recursive: true });
    const file = join(src, "file.txt");
    await writeFile(file, "absolute content\n", "utf8");
    const archive = join(root, "absolute-archive.tar.gz");
    const created = await tarCreateArchive(archive, src);
    check("create code", created.code, 0);
    // A drive-letter archive is exactly the case --force-local exists for: a `C:` in `-f`
    // is what GNU tar would otherwise read as a remote host spec.
    if (/^[A-Za-z]:/.test(archive)) {
      const text = `${created.stdout}\n${created.stderr}`;
      checkTrue("no remote-host noise in create result", !noise(text));
    }
    const dest = join(root, "absolute-dest");
    await mkdir(dest, { recursive: true });
    check("extract code", (await tarExtractArchive(archive, dest)).code, 0);
    check("round-trip", await readFile(join(dest, "file.txt")), await readFile(file));
  });

  await requires("gnu-userland", "a corrupt archive fails with tar's own stderr, not remote-host noise", async () => {
    const archive = join(root, "corrupt.tar.gz");
    await writeFile(archive, Buffer.from([0x1f, 0x8b, 0x00, 0x00]), undefined);
    const listed = await tarListArchive(archive);
    checkTrue("list code non-zero", listed.code !== 0);
    const text = `${listed.stderr}\n${listed.stdout}`;
    checkTrue("stderr names tar/gzip's complaint", text.includes("gzip") || text.includes("tar"));
    checkTrue("no remote-host noise", !noise(text));
  });

  await requires("gnu-userland", "a missing archive fails with tar's own stderr", async () => {
    const archive = join(root, "does-not-exist.tar.gz");
    const listed = await tarListArchive(archive);
    checkTrue("list code non-zero", listed.code !== 0);
    const text = `${listed.stderr}\n${listed.stdout}`;
    checkTrue("stderr non-empty and names the cause", listed.stderr.trim() !== "" && (text.includes(archive) || /Cannot open|No such/u.test(text)));
    checkTrue("no remote-host noise", !noise(text));
  });

  // --force-local (and so its refusal retry) exists only on win32: gate on the host that has it.
  await requires("windows-host", "the flag-refusal retry exists on this host", () => requires("gnu-userland", "the flag-refusal retry normalizes paths and round-trips", async () => {
    // The substitute answers only the flag rejection itself; every other attempt is delegated
    // to the REAL tar with the same argument spelling the owner handed over, so the retry's
    // own behavior is exercised, not stubbed.
    const attempts: string[][] = [];
    const substitute: LocalTarRunner = (command, args, options) => {
      attempts.push(args);
      if (args.includes("--force-local")) {
        return Promise.resolve({ code: 2, stdout: "", stderr: FORCE_LOCAL_REFUSAL });
      }
      // Delegated attempts keep the platform flags: on a GNU tar host the flag is required
      // for drive-letter paths, so the refusal the substitute answers is the only stubbed part.
      return spawnLocal(command, [...tarLocalFlags(), ...args.map((a) => a.replaceAll("\\", "/"))], options);
    };
    // A real fixture with a backslash-prone `tom` component (win32), as in the group above.
    const src = join(root, "tom", "flag retry src");
    const content = "flag retry content\n";
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "file.txt"), content, "utf8");
    const archive = join(root, "flag-retry-archive.tar.gz");
    const dest = join(root, "flag-retry-dest");
    await mkdir(dest, { recursive: true });
    const created = await withLocalTarRunner(substitute, () => runLocalTar(["-czf", archive, "-C", src, "."], { archivePath: archive }));
    checkTrue("flag retry: exactly two attempts", attempts.length === 2);
    checkTrue("flag retry: first attempt carried --force-local", attempts[0]!.includes("--force-local"));
    checkTrue("flag retry: retry args contain no backslash", attempts[1]!.every((a) => !a.includes("\\")));
    check("flag retry: create succeeded after retry", created.code, 0);
    const listed = await tarListArchive(archive);
    check("flag retry: archive lists", listed.code, 0);
    check("flag retry: extract succeeded", (await tarExtractArchive(archive, dest)).code, 0);
    check("flag retry: round-trip content", (await readFile(join(dest, "file.txt"))).toString("utf8"), content);
  }));

  await requires("windows-host", "the double-failure retry exists on this host", () => requires("gnu-userland", "a retry that also fails keeps the first attempt's result", async () => {
    // FIX A contract: the first attempt's stderr is the build's own reported cause — a retry
    // that fails too must not overwrite it.
    const attempts: string[][] = [];
    const substitute: LocalTarRunner = (_command, args) => {
      attempts.push(args);
      if (args.includes("--force-local")) {
        return Promise.resolve({ code: 2, stdout: "", stderr: FORCE_LOCAL_REFUSAL, timedOut: false });
      }
      return Promise.resolve({ code: 3, stdout: "", stderr: "tar: simulated second failure\n" });
    };
    const src = join(root, "flag fail src");
    await mkdir(src, { recursive: true });
    const result = await withLocalTarRunner(substitute, () => runLocalTar(["-czf", join(root, "flag-fail.tar.gz"), "-C", src, "."]));
    checkTrue("flag fail: exactly two attempts", attempts.length === 2);
    checkTrue("flag fail: non-zero exit", result.code !== 0);
    check("flag fail: returned stderr is the first attempt's", result.stderr, FORCE_LOCAL_REFUSAL);
  }));
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

finish("local tar owner");

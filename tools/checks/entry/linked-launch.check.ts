// End-to-end proof of the linked-package launch decision (packages/clawwright/entry/root.ts):
// when the app's node_modules/@phpcraftdream/clawwright is a link to the running package, the
// entry's advice must name the DEPLOYMENT's launcher, not the framework checkout the link
// resolves to. The child process resolves its main module through the link to its real
// path, so frameworkPackage() inside it returns the real package — that is the mechanism
// the fix keys on. Only platform-independent facts are asserted (the spelled program); the
// launch kind's mode differs per platform by contract and is never asserted here.

import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { frameworkPackage } from "#framework/core/env.ts";
import { defaultFrame } from "#framework/entry/root.ts";
import { SHIM_PROGRAM, WINDOWS_BIN_PROGRAM } from "#framework/core/io/invocation/render.ts";
import { checkTrue, finish } from "#checks/kit/harness.ts";

const pkg = await frameworkPackage();
checkTrue("this check runs inside the framework package", pkg !== undefined);
if (pkg !== undefined) {
  // Windows detection as a value selection (the path separator is the host fact here), not
  // a platform probe: every branch runs on every host, only the expected value differs.
  const WINDOWS = isAbsolute("C:\\");
  const launcher = WINDOWS ? WINDOWS_BIN_PROGRAM : SHIM_PROGRAM;
  // Each output line is split into argv-like words; the advice is the word pair
  // [launcher, "init"] (trailing punctuation of the prose around it dropped). Word equality,
  // not a substring search: a longer path ending in the launcher name does not match.
  const lines = (text: string): string[][] =>
    text.split(/\r?\n/).map((line) => line.trim().split(/\s+/).filter((word) => word !== "" && word !== "→" && word !== "->"));
  const advisesInit = (text: string): boolean =>
    lines(text).some((words) => words.some((word, index) => word === launcher && words[index + 1]?.replace(/[).,]+$/, "") === "init"));
  const slashed = (path: string): string => path.replaceAll("\\", "/");
  const mentions = (text: string, root: string): boolean =>
    lines(text).some((words) => words.some((word) => slashed(word).startsWith(slashed(root))));

  const linked = await mkdtemp(join(tmpdir(), "clawwright-linked-"));
  const plain = await mkdtemp(join(tmpdir(), "clawwright-plain-"));
  try {
    // --- the linked layout: node_modules/@phpcraftdream/clawwright is a link to this checkout ---
    await mkdir(join(linked, "node_modules", "@phpcraftdream"), { recursive: true });
    await writeFile(join(linked, "package.json"), JSON.stringify({ dependencies: { "@phpcraftdream/clawwright": "file:linked" } }) + "\n");
    const pkgDir = await realpath(pkg.dir);
    await symlink(pkgDir, join(linked, "node_modules", "@phpcraftdream", "clawwright"), WINDOWS ? "junction" : "dir");

    const linkedRun = spawnSync(process.execPath, ["--experimental-strip-types", join(linked, "node_modules", "@phpcraftdream", "clawwright", "entry", "bin.ts"), "help"], { cwd: linked, encoding: "utf8" });
    checkTrue("linked: the child launcher run exits 0", linkedRun.status === 0);
    const text = `${linkedRun.stdout ?? ""}${linkedRun.stderr ?? ""}`;
    checkTrue(`linked: help advises init through the deployment's launcher (${WINDOWS ? "cmd/pwsh npm wrapper" : "bash shim"})`, advisesInit(text));
    // The wrong launcher sat at the framework CHECKOUT root (two levels above the package).
    checkTrue("linked: no word names the framework checkout", !mentions(text, join(pkgDir, "..", "..")));
    const frame = await defaultFrame(linked, { host: WINDOWS ? "win32" : "posix", msys: false, cwd: linked });
    checkTrue("linked: the launch is rooted at the deployment", "root" in frame.launch && frame.launch.root === linked);
    checkTrue("linked: the launch kind spells the deployment's launcher", SHIM_PROGRAM === launcher ? frame.launch.kind === "deployment-shim" : frame.launch.kind === "npm-bin");
    checkTrue("linked: the frame names the deployment as its place", frame.places.deploymentRoot === linked);

    // --- the non-linked layout: a real node_modules copy answers exactly as before ---------
    // Node refuses --experimental-strip-types for any file whose real path is under a real
    // node_modules directory (the linked run above only works because its entry resolves to
    // this checkout), so the deployment's node_modules itself is a junction to a plain store
    // directory. That is fixture plumbing only: node_modules/@phpcraftdream/clawwright inside it
    // is still a REAL copy of the running package, not a link to it, which is what the probe
    // must not disturb.
    const store = join(plain, "store");
    await mkdir(join(store, "@phpcraftdream"), { recursive: true });
    await symlink(store, join(plain, "node_modules"), WINDOWS ? "junction" : "dir");
    await writeFile(join(plain, "package.json"), JSON.stringify({ dependencies: { "@phpcraftdream/clawwright": "file:plain" } }) + "\n");
    await cp(pkg.dir, join(plain, "node_modules", "@phpcraftdream", "clawwright"), {
      recursive: true,
      filter: (source) => {
        const base = source.replaceAll("\\", "/").split("/").pop() ?? "";
        return base !== "node_modules" && base !== "dist";
      },
    });
    // Dependency plumbing, as npm itself would install it: the copy's own node_modules is a
    // link to the checkout's, so its runtime imports resolve; @phpcraftdream/clawwright itself
    // stays a REAL copy of the running package — the thing the probe must not disturb.
    await symlink(join(pkg.dir, "..", "..", "node_modules"), join(plain, "node_modules", "@phpcraftdream", "clawwright", "node_modules"), WINDOWS ? "junction" : "dir");
    const plainPkg = join(plain, "node_modules", "@phpcraftdream", "clawwright");
    const plainRun = spawnSync(process.execPath, ["--experimental-strip-types", join(plainPkg, "entry", "bin.ts"), "help"], { cwd: plain, encoding: "utf8" });
    checkTrue("non-linked: the child launcher run exits 0", plainRun.status === 0);
    const plainText = `${plainRun.stdout ?? ""}${plainRun.stderr ?? ""}`;
    checkTrue("non-linked: help advises init through the deployment's launcher", advisesInit(plainText));
    checkTrue("non-linked: no word names the deployment's absolute path", !mentions(plainText, plain));
  } finally {
    await rm(linked, { recursive: true, force: true });
    await rm(plain, { recursive: true, force: true });
  }
}

finish("linked package launch");

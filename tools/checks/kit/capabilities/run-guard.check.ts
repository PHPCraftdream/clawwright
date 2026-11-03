// Pins the two pure decision layers run.ts added for invariant I10: folding a ran file's
// case-level capability skips (harness `requires()`) into the runner's skip breakdown, and
// the before/after checkout snapshot diff (R33-02: a check deleted other people's
// apps/gateprobe-* deployments in the real checkout). The pure parts touch no process; the
// snapshot walk itself is proven against a temp dir — a write INSIDE an existing apps/<name>
// changes neither top-level names nor `git status --porcelain`, so only a recursive listing
// can catch it.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { check, checkTrue, finish, requires } from "#checks/kit/harness.ts";
import { diffSnapshots, snapshotCheckout, type AppsEntry, type CheckoutSnapshot } from "../run.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { runProcess } from "../spawn.ts";
import { parseCaseSkips } from "./gate.ts";

// --- parseCaseSkips: the same shape the runner already prints for skipped files ---------------

check(
  "a case-level skip line is recognized with its name and capability",
  parseCaseSkips("  SKIP the status hints case — needs docker\n"),
  [{ name: "the status hints case", capabilities: ["docker"] }],
);
check(
  "several lines in a file's output are all recognized",
  parseCaseSkips("before\n  SKIP case one — needs docker\nmiddle\n  SKIP case two — needs wsl, rsync\n"),
  [
    { name: "case one", capabilities: ["docker"] },
    { name: "case two", capabilities: ["wsl", "rsync"] },
  ],
);
check("an unknown capability in the list is dropped, not invented", parseCaseSkips("  SKIP c — needs not-a-cap\n"), []);
check("the lowercase ad-hoc skips some checks print are ignored", parseCaseSkips("  skip status hints: no reachable target on this host\n"), []);
check("ordinary output produces nothing", parseCaseSkips("  ok   something\nall demo checks passed\n"), []);

// --- diffSnapshots: apps/ entries and git status must survive the run unchanged -----------------

const withoutMode = (entry: AppsEntry): AppsEntry => { const { mode: _mode, ...rest } = entry; return rest; };
const file = (path: string, size: number, hash?: string): AppsEntry => ({ path, size, ...(hash === undefined ? {} : { hash }) });
const snapshot = (over: Partial<CheckoutSnapshot> = {}): CheckoutSnapshot => ({
  apps: [file("a", 1, "h1"), file("b", 2, "h2")],
  gitStatus: "",
  ignoredStatus: "",
  ...over,
});

check("an unchanged checkout is no change", diffSnapshots(snapshot(), snapshot()), []);
check("an app that appeared is named", diffSnapshots(snapshot(), snapshot({ apps: [...snapshot().apps, file("gateprobe-x", 3, "h3")] })), ["apps/ gained: gateprobe-x"]);
check("an app that disappeared is named", diffSnapshots(snapshot(), snapshot({ apps: [file("a", 1, "h1")] })), ["apps/ lost: b"]);
check("appearing and losing are named together", diffSnapshots(snapshot({ apps: [file("b", 2, "h2")] }), snapshot({ apps: [file("a", 1, "h1"), file("c", 3, "h3")] })), ["apps/ gained: a, c", "apps/ lost: b"]);
check(
  "a same-path entry with a different hash is reported as changed",
  diffSnapshots(snapshot(), snapshot({ apps: [file("a", 1, "h1"), file("b", 2, "different")] })),
  ["apps/ changed: b (2B h2 → 2B differen)"],
);
check(
  "a size change without a hash is also a change",
  diffSnapshots(snapshot(), snapshot({ apps: [file("a", 1, "h1"), file("b", 9)] })),
  ["apps/ changed: b (2B h2 → 9B)"],
);
check("a directory that vanished is reported lost", diffSnapshots(snapshot({ apps: [{ path: "a", directory: true }] }), snapshot()), ["apps/ gained: b", "apps/ changed: a (dir → 1B h1)"]);
check("a lost entry is named even when nothing else changed", diffSnapshots(snapshot(), snapshot({ apps: [file("a", 1, "h1")] })), ["apps/ lost: b"]);

check("a link entry that appeared is named", diffSnapshots(snapshot(), snapshot({ apps: [...snapshot().apps, { path: "gateprobe-l", link: "a" }] })), ["apps/ gained: gateprobe-l"]);
check("a link that vanished is reported lost", diffSnapshots(snapshot({ apps: [file("a", 1, "h1"), { path: "b", link: "a" }] }), snapshot({ apps: [file("a", 1, "h1")] })), ["apps/ lost: b"]);
check(
  "a retargeted link is reported as changed",
  diffSnapshots(snapshot({ apps: [{ path: "l", link: "a" }, file("b", 2, "h2")] }), snapshot({ apps: [{ path: "l", link: "c" }, file("b", 2, "h2")] })),
  ["apps/ changed: l (link a → link c)"],
);
check(
  "a link replaced by a real file is reported as changed",
  diffSnapshots(snapshot({ apps: [{ path: "l", link: "a" }, file("b", 2, "h2")] }), snapshot({ apps: [file("l", 1, "h1"), file("b", 2, "h2")] })),
  ["apps/ changed: l (link a → 1B h1)"],
);

check(
  "a tracked or untracked change is named by its porcelain line",
  diffSnapshots(snapshot(), snapshot({ gitStatus: " M packages/clawwright/core/env.ts\n" })),
  ["git status gained:  M packages/clawwright/core/env.ts"],
);
check(
  "gained and lost porcelain lines are both listed, sorted",
  diffSnapshots(
    snapshot({ gitStatus: "?? a-old\n M b-edited\n" }),
    snapshot({ gitStatus: "?? a-new\n M b-edited\n M c-new\n" }),
  ),
  ["git status gained:  M c-new", "git status gained: ?? a-new", "git status lost: ?? a-old"],
);
check(
  "the same porcelain content in both passes is no change",
  diffSnapshots(snapshot({ gitStatus: "?? dist-new/\n" }), snapshot({ gitStatus: "?? dist-new/\n" })),
  [],
);
check(
  "git available in only one pass is not compared — only the note prints",
  diffSnapshots(snapshot(), snapshot({ gitStatus: undefined })),
  [],
);
check(
  "git unavailable on both passes skips the comparison instead of failing",
  diffSnapshots(snapshot({ gitStatus: undefined }), snapshot({ gitStatus: undefined })),
  [],
);
check(
  "a leftover in ignored space is named, though --porcelain hides it",
  diffSnapshots(snapshot(), snapshot({ ignoredStatus: "!! .claude/clawwright-deploy-policy-scratch/unrelated.secrets.env\n" })),
  ["git ignored gained: !! .claude/clawwright-deploy-policy-scratch/unrelated.secrets.env"],
);
check(
  "an ignored file that vanished during the run is named too",
  diffSnapshots(snapshot({ ignoredStatus: "!! secrets/leaked.txt\n" }), snapshot()),
  ["git ignored lost: !! secrets/leaked.txt"],
);
check(
  "ignored content present in both passes is no change",
  diffSnapshots(snapshot({ ignoredStatus: "!! data/state\n" }), snapshot({ ignoredStatus: "!! data/state\n" })),
  [],
);
check(
  "ignored space is not compared when git saw it in only one pass",
  diffSnapshots(snapshot(), snapshot({ ignoredStatus: undefined })),
  [],
);

// --- All filesystem witnesses live in one throwaway git repository, never the checkout. -------

const root = await mkdtemp(join(tmpdir(), "clawwright-runguard-"));
try {
  const git = await runProcess("git", ["init", "-q"], { cwd: root, timeoutMs: 60_000 });
  if (git.code !== 0) throw new Error("throwaway git init failed: " + git.output);
  await writeFile(join(root, ".gitignore"), ".claude/\n*.token\nnode_modules/\npackages/clawwright/dist/\n");
  const apps = join(root, "apps");
  await mkdir(join(apps, "existing"), { recursive: true });
  await writeFile(join(apps, "existing", "data.env"), "alpha\n");
  const before = await snapshotCheckout(root);
  await writeFile(join(apps, "existing", "data.env"), "beta\n");
  const after = await snapshotCheckout(root);
  check("a clean temp snapshot diffs to nothing", diffSnapshots(before, before), []);
  check("a rewrite inside apps/existing is named by the recursive walk", diffSnapshots(before, after),
    ["apps/ changed: existing/data.env (6B b6a98d9c → 5B f2c82dec)"]);

  const large = join(apps, "existing", "large.bin");
  await writeFile(large, Buffer.alloc(65537, 65));
  const beforeLarge = await snapshotCheckout(root);
  await writeFile(large, Buffer.alloc(65537, 66));
  const afterLarge = await snapshotCheckout(root);
  check("65537 A to B bytes change despite identical size", { entries: afterLarge.apps.filter((entry) => entry.path === "existing/large.bin").map(withoutMode), changes: diffSnapshots(beforeLarge, afterLarge).length },
    { entries: [file("existing/large.bin", 65537, "29683b6ad0ba6b29316e012afeb0c176df5ec24773beb5193f7a60f7c855b0a1")], changes: 1 });
  check("65537 A bytes have an independent full SHA256", beforeLarge.apps.find((entry) => entry.path === "existing/large.bin")?.hash,
    "ac72112c832fa4683b15ebff51a8f5f2ca08226c0d59bdb9ac739c2cdc28a05c");
  check("65537 B bytes have an independent full SHA256", afterLarge.apps.find((entry) => entry.path === "existing/large.bin")?.hash,
    "29683b6ad0ba6b29316e012afeb0c176df5ec24773beb5193f7a60f7c855b0a1");

  // Keep this binding explicit: a temp-copy mutation restoring monorepoRoot must fail
  // the does-not-touch-checkout assertion BEFORE any write or cleanup can reach it.
  const claudeDir = resolve(root, ".claude");
  const scratch = resolve(claudeDir, "clawwright-deploy-policy-scratch");
  const isolated = scratch.startsWith(root + sep) && !scratch.startsWith(monorepoRoot + sep);
  checkTrue("does not touch checkout: ignored scratch is inside the throwaway repo", isolated);
  if (isolated) {
    await mkdir(claudeDir, { recursive: true });
    await writeFile(join(claudeDir, "settings.local.json"), "{}\n");
    const beforeScratch = await snapshotCheckout(root);
    await mkdir(scratch);
    await writeFile(join(scratch, "unrelated.secrets.env"), "SECRET\n");
    const afterScratch = await snapshotCheckout(root);
    check("a leftover inside an existing ignored directory is named",
      afterScratch.ignoredStatus?.split("\n").filter((line) => !beforeScratch.ignoredStatus?.split("\n").includes(line)),
      ["!! .claude/clawwright-deploy-policy-scratch/unrelated.secrets.env"]);

    const token = join(claudeDir, "preexisting.token");
    await writeFile(token, "AAAA");
    const beforeToken = await snapshotCheckout(root);
    await writeFile(token, "BBBB");
    const afterToken = await snapshotCheckout(root);
    check("existing ignored AAAA to BBBB changes despite identical name and size", { entries: afterToken.ignored?.filter((entry) => entry.path === ".claude/preexisting.token").map(withoutMode), changes: diffSnapshots(beforeToken, afterToken).length },
      { entries: [file(".claude/preexisting.token", 4, "4a8d8134f29b0b7b60c126f5532bc9f5d9bb73037373cf6fb872d81f1dcefdfd")], changes: 1 });
    check("ignored AAAA has an independent full SHA256", beforeToken.ignored?.find((entry) => entry.path === ".claude/preexisting.token")?.hash,
      "63c1dd951ffedf6f7fd968ad4efa39b8ed584f162f46e715114ee184f8de9201");
    check("ignored BBBB has an independent full SHA256", afterToken.ignored?.find((entry) => entry.path === ".claude/preexisting.token")?.hash,
      "4a8d8134f29b0b7b60c126f5532bc9f5d9bb73037373cf6fb872d81f1dcefdfd");

    // A directly ignored filename forces the NUL porcelain path parser, not just recursion.
    const spaced = join(root, "space quoted ü.token");
    await writeFile(spaced, "AAAA");
    const beforeSpace = await snapshotCheckout(root);
    await writeFile(spaced, "BBBB");
    const afterSpace = await snapshotCheckout(root);
    check("ignored paths with spaces and Unicode retain their content witness", { entries: afterSpace.ignored?.filter((entry) => entry.path === spaced.slice(root.length + 1)).map(withoutMode), changes: diffSnapshots(beforeSpace, afterSpace).length },
      { entries: [file("space quoted ü.token", 4, "4a8d8134f29b0b7b60c126f5532bc9f5d9bb73037373cf6fb872d81f1dcefdfd")], changes: 1 });
    checkTrue("the temp snapshot records ignored space", afterSpace.ignoredStatus !== undefined);
    checkTrue("every ignored status line is an ignored entry", (afterSpace.ignoredStatus ?? "").split("\n").every((line) => line.slice(0, 3).trimEnd() === "!!"));
    check("pruned generated roots stay absent", afterSpace.ignored?.some((entry) => entry.path.startsWith("node_modules/")), false);

    // dist is no longer pruned: a file written there between snapshots is reported.
    const beforeDist = await snapshotCheckout(root);
    await mkdir(join(root, "packages", "clawwright", "dist", "entry"), { recursive: true });
    await writeFile(join(root, "packages", "clawwright", "dist", "entry", "bin.js"), "AAAA");
    const afterDist = await snapshotCheckout(root);
    check("a new file under packages/clawwright/dist is reported", diffSnapshots(beforeDist, afterDist).some((line) => line.includes("packages/clawwright/dist/entry/bin.js")), true);
  }

  await requires("symlink", "the walk records symlinks without following them", async () => {
    const outside = join(root, "outside.env");
    await writeFile(outside, "alpha\n");
    const beforeLink = await snapshotCheckout(root);
    await symlink(outside, join(apps, "linked"), "file");
    const afterLink = await snapshotCheckout(root);
    check("an app symlink stores its exact target", afterLink.apps.filter((entry) => entry.path === "linked").map(withoutMode)[0], { path: "linked", link: outside });
    check("a symlink created between snapshots is named", { entries: afterLink.apps.filter((entry) => entry.path === "linked").map(withoutMode), changes: diffSnapshots(beforeLink, afterLink).length }, { entries: [{ path: "linked", link: outside }], changes: 1 });
    const dirLink = join(apps, "linked-dir");
    await symlink(join(apps, "existing"), dirLink, "dir");
    const withDirLink = await snapshotCheckout(root);
    checkTrue("a directory symlink is never walked", withDirLink.apps.some((entry) => entry.path === "linked-dir" && entry.link !== undefined) && !withDirLink.apps.some((entry) => entry.path.startsWith("linked-dir/")));
    await rm(dirLink);
    check("a removed directory symlink is named", diffSnapshots(withDirLink, await snapshotCheckout(root)), ["apps/ lost: linked-dir"]);
    const ignoredLink = join(root, "linked.token");
    await symlink(outside, ignoredLink, "file");
    const beforeTarget = await snapshotCheckout(root);
    await writeFile(outside, "beta\n");
    const afterTarget = await snapshotCheckout(root);
    check("an ignored symlink stores its target, not its content", afterTarget.ignored?.filter((entry) => entry.path === "linked.token").map(withoutMode)[0], { path: "linked.token", link: outside });
    check("neither apps nor ignored symlinks follow target rewrites", diffSnapshots(beforeTarget, afterTarget).filter((line) => line.split(/\s+/)[0] !== "checkout"), []);
    checkTrue("the target rewrite itself is still observed", diffSnapshots(beforeTarget, afterTarget).some((line) => line.includes("outside.env")));
  });
} finally {
  await rm(root, { recursive: true, force: true });
}
checkTrue("the created throwaway repository was removed", !existsSync(root));

// Comparing hashes must not use the abbreviated display hash as equality.
check("full hash differences sharing an eight-character prefix are detected",
  diffSnapshots(snapshot({ apps: [file("x", 4, "12345678aaaa")] }), snapshot({ apps: [file("x", 4, "12345678bbbb")] })).length,
  1);

finish("run guard");

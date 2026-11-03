// All fake sources/output live under the canonical OS temp root; no checkout dist edits.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { warnIfDistStale, warnForEntry } from "#framework/entry/root.ts";
import { check, finish } from "#checks/kit/harness.ts";

const root = realpathSync.native(mkdtempSync(resolve(realpathSync.native(tmpdir()), "clawwright-stale-dist-")));
const moduleUrl = new URL("../../../../packages/clawwright/entry/root.ts", import.meta.url).href;
const old = new Date("2020-01-01T00:00:00Z");
const newer = new Date("2020-01-02T00:00:00Z");
function file(rel: string, date: Date): void {
  const path = resolve(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "// fixture\n");
  utimesSync(path, date, date);
}
function lines(env: Record<string, string | undefined> = {}): string[] {
  const captured: string[] = [];
  warnIfDistStale(root, env, (line) => { captured.push(line); });
  return captured;
}
function checkWarning(name: string, captured: string[]): void {
  const text = captured.join("");
  const tokens = text.trim().split(/\s+/);
  const words = tokens.map((token) => token.replace(/^\W+|\W+$/g, ""));
  const facts = [captured.length, text.split("\n").length - 1, text.endsWith("\n"),
    tokens[0] === "clawwright:" && tokens[1] === "warning:",
    tokens.some((token, index) => token === "npm" && tokens[index + 1] === "run" && tokens[index + 2] === "build"),
    words.includes("dist") && words.includes("sources"),
    words.includes("newer") || words.includes("older"),
    words.includes("checkout") && words.includes("root"),
    !tokens.some((token) => /(?:^|["'`(=])(?:[A-Za-z]:[\\/]|[\\/])/.test(token))];
  if (facts[0] !== 1 || facts[1] !== 1 || facts.slice(2).some((fact) => fact !== true)) {
    process.stderr.write(`captured stale-dist diagnostic: ${JSON.stringify(captured)}\n`);
  }
  check(name, facts, [1, 1, true, true, true, true, true, true, true]);
}
function child(env: Record<string, string> = {}) {
  const entry = pathToFileURL(resolve(root, "dist/entry/bin.js")).href;
  return spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
    `import { warnForEntry } from ${JSON.stringify(moduleUrl)}; warnForEntry(${JSON.stringify(entry)});`], {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: "", OC_NO_STALE_DIST_WARNING: "", ...env },
    encoding: "utf8",
    timeout: 10000,
  });
}
try {
  check("no sources or dist is silent", lines().length, 0);
  file("entry/bin.ts", old);
  check("no dist is inconclusive and silent", lines().length, 0);
  file("dist/entry/bin.js", newer);
  check("clone then build is current", lines().length, 0);
  file("core/example.ts", newer);
  file("dist/core/example.js", old);
  checkWarning("nested newer source warns exactly one line", lines());
  check("OC suppression", lines({ OC_NO_STALE_DIST_WARNING: "1" }).length, 0);
  checkWarning("zero does not suppress", lines({ OC_NO_STALE_DIST_WARNING: "0" }));
  let threw = false;
  try { warnIfDistStale(root, {}, () => { throw new Error("closed stderr"); }); } catch { threw = true; }
  check("diagnostic sink errors never throw", threw, false);
  const result = child();
  check("built entry diagnostic succeeds", [result.status, result.error === undefined], [0, true]);
  check("built entry diagnostic leaves stdout empty (JSON/MCP safe)", result.stdout.length, 0);
  checkWarning("built entry diagnostic emits only one stderr line", [result.stderr]);
  const suppressed = child({ OC_NO_STALE_DIST_WARNING: "1" });
  check("suppressed startup leaves both channels empty", [suppressed.status, suppressed.stdout.length, suppressed.stderr.length], [0, 0, 0]);
  file("dist/core/example.js", newer);
  check("equal timestamps are current", lines().length, 0);
  const current = child();
  check("current startup leaves both channels empty", [current.status, current.stdout.length, current.stderr.length], [0, 0, 0]);
  file("node_modules/ignored.ts", newer);
  file("dist/ignored.ts", newer);
  check("generated and dependency trees are ignored", lines().length, 0);
  rmSync(resolve(root, "entry"), { recursive: true });
  check("installed package without sources stays silent", lines().length, 0);
  const installed = child();
  check("installed startup leaves both channels empty", [installed.status, installed.stdout.length, installed.stderr.length], [0, 0, 0]);
  let badUrlThrew = false;
  try { warnForEntry("not a file URL"); } catch { badUrlThrew = true; }
  check("invalid entry URL does not throw", badUrlThrew, false);
  file("entry/bin.ts", old);
  file("core/example.ts", newer);
  file("dist/core/example.js", old);
  file("core/missing.ts", old);
  checkWarning("later missing output does not suppress earlier known stale", lines());
  file("dist/core/example.js", newer);
  check("old unbuilt source is silent", lines().length, 0);
  file("core/missing.ts", new Date("2020-01-03T00:00:00Z"));
  checkWarning("new source without output newer than built entry warns", lines());
  file("core/missing.ts", newer);
  check("unbuilt source equal to built entry is silent", lines().length, 0);
  rmSync(resolve(root, "core/missing.ts"));
  mkdirSync(resolve(root, "core/missing.ts"));
  file("core/missing.ts/unbuilt.ts", newer);
  check("old missing nested output stays silent", lines().length, 0);
  rmSync(resolve(root, "core/missing.ts"), { recursive: true });
  // Bounds without evidence stay silent; known stale evidence still warns immediately.
  let deep = "depth";
  for (let i = 0; i < 18; i++) deep += "/nested";
  file(`${deep}/too-deep.ts`, newer);
  check("depth bound without stale evidence stays silent", lines().length, 0);
  file("entry/bin.ts", new Date("2020-01-03T00:00:00Z"));
  checkWarning("known stale entry warns despite later depth bound", lines());
  file("entry/bin.ts", old);
  rmSync(resolve(root, "depth"), { recursive: true });
  for (let i = 0; i < 4100; i++) file(`breadth/item-${i}.txt`, old);
  check("entry count bound without stale evidence stays silent", lines().length, 0);
  file("entry/bin.ts", new Date("2020-01-03T00:00:00Z"));
  checkWarning("known stale entry warns despite later entry count bound", lines());
} finally {
  rmSync(root, { recursive: true, force: true });
}
finish("stale-dist");

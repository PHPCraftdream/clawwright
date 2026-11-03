// Pure parts of check:linux (tools/dev/check-linux.ts): argument passthrough, the clean
// file-list filter, and the exact docker argv it would run — none of this needs a real Docker
// daemon, and it must behave identically on every host OS since it never touches an OS-specific
// path separator (see check-linux-argv.ts's own header comment).

import assert from "node:assert/strict";
import {
  buildCopyArgv,
  buildCreateArgv,
  buildInnerScript,
  buildUserScript,
  SNAPSHOT_REPO,
  buildRemoveArgv,
  buildStartArgv,
  CONTAINER_WORKDIR,
  filterCleanFileList,
  isHostArtifactPath,
  shellQuoteSingle,
} from "#tools/dev/check-linux-argv.ts";

// --- shell quoting: the one place a user-supplied filter crosses into `sh -c` -------------

assert.equal(shellQuoteSingle("backup"), "'backup'");
assert.equal(shellQuoteSingle("runtime lifecycle"), "'runtime lifecycle'");
assert.equal(shellQuoteSingle("it's"), "'it'\\''s'");
assert.equal(shellQuoteSingle(""), "''");

// --- the inner script: no filters, one, several, and one needing escaping -----------------

assert.equal(buildUserScript([]), `cd ${CONTAINER_WORKDIR} && ${SNAPSHOT_REPO} && npm ci && npm run check && npm run format:check`);
assert.equal(buildUserScript(["backup"]), `cd ${CONTAINER_WORKDIR} && ${SNAPSHOT_REPO} && npm ci && npm run check -- 'backup' && npm run format:check`);
assert.equal(
  buildUserScript(["runtime lifecycle", "foo's"]),
  `cd ${CONTAINER_WORKDIR} && ${SNAPSHOT_REPO} && npm ci && npm run check -- 'runtime lifecycle' 'foo'\\''s' && npm run format:check`,
);

// The steps run as `node`, not root: a read-only directory must actually refuse a write.
assert.equal(
  buildInnerScript(["backup"]),
  `chown -R node:node ${CONTAINER_WORKDIR} && exec runuser -u node -- env HOME=/home/node sh -c ${shellQuoteSingle(buildUserScript(["backup"]))}`,
);

// --- the exact docker argv, so a flag change is a visible diff here, not just in behavior --

assert.deepEqual(buildCreateArgv("clawwright-check-linux-abcd1234", []), [
  "create",
  "--rm",
  "--name",
  "clawwright-check-linux-abcd1234",
  "-e",
  "CI=true",
  "node:24",
  "sh",
  "-c",
  buildInnerScript([]),
]);

assert.deepEqual(buildCreateArgv("c1", ["backup"]).slice(-1), [buildInnerScript(["backup"])]);

assert.deepEqual(buildCopyArgv("/tmp/clawwright-check-linux-xyz", "c1"), ["cp", "/tmp/clawwright-check-linux-xyz", `c1:${CONTAINER_WORKDIR}`]);
// A host path is passed through untouched — no separator rewriting, no trailing-dot suffix:
// buildCopyArgv relies on CONTAINER_WORKDIR not pre-existing in the container instead (see
// check-linux-argv.ts), which is exactly what makes this safe to build the same way on every
// host OS, backslashes and drive letters included.
assert.deepEqual(buildCopyArgv("C:\\Users\\dev\\AppData\\Local\\Temp\\clawwright-check-linux-xyz", "c1"), [
  "cp",
  "C:\\Users\\dev\\AppData\\Local\\Temp\\clawwright-check-linux-xyz",
  `c1:${CONTAINER_WORKDIR}`,
]);

assert.deepEqual(buildStartArgv("c1"), ["start", "-a", "c1"]);
assert.deepEqual(buildRemoveArgv("c1"), ["rm", "-f", "c1"]);

// --- host-artifact filtering: node_modules/dist never reach the snapshot, at any depth ----

assert.equal(isHostArtifactPath("node_modules/foo/index.js"), true);
assert.equal(isHostArtifactPath("a/node_modules/b/c.js"), true);
assert.equal(isHostArtifactPath("packages/clawwright/dist"), true);
assert.equal(isHostArtifactPath("packages/clawwright/dist/entry/bin.js"), true);
assert.equal(isHostArtifactPath("tools/framework/dist"), true);
assert.equal(isHostArtifactPath("tools/framework/dist/entry/bin.js"), true);
assert.equal(isHostArtifactPath("tools/framework/distinct-file.ts"), false);
assert.equal(isHostArtifactPath("tools/clawwright.ts"), false);
assert.equal(isHostArtifactPath("package.json"), false);
// Same directory, unrelated name: a prefix match on "dist" alone would wrongly drop this.
assert.equal(isHostArtifactPath("packages/clawwright/distinct-file.ts"), false);

// --- file-list building: git ls-files' raw stdout, trimmed, blank lines and artifacts out -

assert.deepEqual(
  filterCleanFileList(["package.json", "", "node_modules/foo/index.js", "packages/clawwright/dist/entry/bin.js", "tools/dev/check-linux.ts", ""]),
  ["package.json", "tools/dev/check-linux.ts"],
);
assert.deepEqual(filterCleanFileList([]), []);

process.stderr.write("check:linux pure argv/file-list checks passed\n");

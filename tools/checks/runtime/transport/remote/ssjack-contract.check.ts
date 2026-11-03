import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { frameworkRoot } from "#framework/core/env.ts";
import { SSJACK_REQUIREMENTS, validateSsjackSupply } from "#framework/runtime/transport/remote/ssjack-contract.ts";

const metadata = JSON.parse(await readFile(resolve(frameworkRoot, "package.json"), "utf8")) as {
  ssjackRuntime?: { requirements: unknown; supply: unknown };
};
assert.ok(metadata.ssjackRuntime);
assert.deepEqual(metadata.ssjackRuntime.requirements, SSJACK_REQUIREMENTS);
validateSsjackSupply(metadata.ssjackRuntime.supply);

assert.equal(SSJACK_REQUIREMENTS.optional, true);
assert.equal(SSJACK_REQUIREMENTS.protocol, 1);
assert.equal(SSJACK_REQUIREMENTS.chunkSize, 16384);
assert.deepEqual(SSJACK_REQUIREMENTS.capabilities, ["exec", "stdin", "binary", "backpressure", "cancel"]);
assert.equal(SSJACK_REQUIREMENTS.cancellation, "connection-only");

const base = {
  repository: "PHPCraftdream/ssjack",
  commit: "1".repeat(40),
  platform: "windows-amd64",
  archiveSHA256: "2".repeat(64),
  executableSHA256: "3".repeat(64),
};
const ci = { ...base, kind: "ci", runId: 123, artifactId: 456, artifactName: "verified-cli-Windows-X64" };
const release = { ...base, kind: "release", version: "v1.2.3", asset: "ssjack_windows_amd64.exe" };
assert.deepEqual(validateSsjackSupply(ci), ci);
assert.deepEqual(validateSsjackSupply(release), release);
for (const invalid of [
  undefined, null, [], {},
  { ...ci, repository: "other/ssjack" },
  { ...ci, commit: "main" },
  { ...ci, commit: "1".repeat(7) },
  { ...ci, archiveSHA256: "" },
  { ...ci, executableSHA256: "latest" },
  { ...ci, artifactId: 0 },
  { ...ci, runId: 1.5 },
  { ...ci, runId: Number.MAX_SAFE_INTEGER + 1 },
  { ...ci, platform: "auto" },
  { ...ci, artifactName: "../archive.zip" },
  { ...ci, endpoint: "https://127.0.0.1:12345/mcp" },
  { ...ci, token: "must-not-persist" },
  { ...ci, version: "v1.2.3" },
  { ...release, version: "latest" },
  { ...release, artifactId: 456 },
  { ...release, asset: "/private/binary" },
]) assert.throws(() => validateSsjackSupply(invalid), /SSJACK_SUPPLY_INVALID/);

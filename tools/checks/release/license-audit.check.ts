import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { audit } from "./license-audit.ts";

type Lock = { packages: Record<string, Record<string, unknown>> };

const root = resolve(import.meta.dirname, "../../..");
const sandbox = mkdtempSync(resolve(tmpdir(), "license-audit-"));
const paths = ["package-lock.json", "tools/framework/package.json", "LICENSE", "LICENSE-MIT", "LICENSE-APACHE", "NOTICE", "tools/framework/LICENSE", "tools/framework/LICENSE-MIT", "tools/framework/LICENSE-APACHE", "tools/framework/NOTICE"];
try {
  for (const path of paths) {
    const target = resolve(sandbox, path);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, readFileSync(resolve(root, path)));
  }
  const run = (): string | undefined => {
    try {
      audit(sandbox);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  const valid = run();
  if (valid !== undefined) throw new Error(`Valid inventory unexpectedly failed: ${valid}`);

  const mutateLock = (update: (lock: Lock) => void): void => {
    const path = resolve(sandbox, "package-lock.json");
    const lock = JSON.parse(readFileSync(path, "utf8")) as Lock;
    update(lock);
    writeFileSync(path, JSON.stringify(lock));
  };
  const adversarial: Array<[string, string, (lock: Lock) => void]> = [
    ["forged json5 integrity", "json5 lock metadata differs", (lock) => { lock.packages["node_modules/json5"].integrity = "sha512-forged"; }],
    ["untrusted json5 registry", "json5 lock metadata differs", (lock) => { lock.packages["node_modules/json5"].resolved = "https://evil.example/json5.tgz"; }],
    ["changed json5 license", "No exact-version reviewed provenance for json5@2.2.3", (lock) => { lock.packages["node_modules/json5"].license = "Apache-2.0"; }],
    ["missing production license", "Missing version/license metadata", (lock) => { delete lock.packages["node_modules/json5"].license; }],
    ["unreviewed production dependency", "No exact-version reviewed provenance for unreviewed-package@1.0.0", (lock) => {
      lock.packages[""].dependencies = { ...(lock.packages[""].dependencies as Record<string, string>), "unreviewed-package": "1.0.0" };
      lock.packages["node_modules/unreviewed-package"] = { version: "1.0.0", resolved: "https://registry.npmjs.org/unreviewed-package/-/unreviewed-package-1.0.0.tgz", integrity: "sha512-abc", license: "MIT" };
      const manifestPath = resolve(sandbox, "tools/framework/package.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { dependencies: Record<string, string> };
      manifest.dependencies["unreviewed-package"] = "1.0.0";
      writeFileSync(manifestPath, JSON.stringify(manifest));
    }],
    ["transitive peer dependency", "Transitive peerDependencies are unsupported", (lock) => {
      lock.packages["node_modules/json5"].dependencies = { "nested-peer-host": "1.0.0" };
      lock.packages["node_modules/nested-peer-host"] = { version: "1.0.0", resolved: "https://registry.npmjs.org/nested-peer-host/-/nested-peer-host-1.0.0.tgz", integrity: "sha512-abc", license: "MIT", peerDependencies: { absent: "*" } };
    }],
    ["unreviewed scoped package", "No exact-version reviewed provenance for @unreviewed/pkg@1.0.0", (lock) => {
      lock.packages["node_modules/json5"].dependencies = { "@unreviewed/pkg": "1.0.0" };
      lock.packages["node_modules/@unreviewed/pkg"] = { version: "1.0.0", resolved: "https://registry.npmjs.org/@unreviewed/pkg/-/pkg-1.0.0.tgz", integrity: "sha512-abc", license: "MIT" };
    }],
    ["unreviewed hoisted transitive package", "No exact-version reviewed provenance for nested-peer-host@1.0.0", (lock) => {
      lock.packages["node_modules/json5"].dependencies = { "nested-peer-host": "1.0.0" };
      lock.packages["node_modules/nested-peer-host"] = { version: "1.0.0", resolved: "https://registry.npmjs.org/nested-peer-host/-/nested-peer-host-1.0.0.tgz", integrity: "sha512-abc", license: "MIT" };
    }],
    ["transitive alias range", "Unsupported dependency range or alias for nested-peer-host", (lock) => {
      lock.packages["node_modules/json5"].dependencies = { "nested-peer-host": "git+https://example.com/pkg.git" };
    }],

    ["manifest range mismatch", "Manifest/lock range mismatch for json5", () => {
      const manifestPath = resolve(sandbox, "tools/framework/package.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { dependencies: Record<string, string> };
      manifest.dependencies.json5 = "^2.2.4";
      writeFileSync(manifestPath, JSON.stringify(manifest));
    }],
    ["bundled dependency", "Published bundled dependencies are unsupported", () => {
      const manifestPath = resolve(sandbox, "tools/framework/package.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { bundleDependencies?: string[] };
      manifest.bundleDependencies = ["json5"];
      writeFileSync(manifestPath, JSON.stringify(manifest));
    }],
  ];
  for (const [description, expected, mutate] of adversarial) {
    const lockPath = resolve(sandbox, "package-lock.json");
    const originalLock = readFileSync(lockPath, "utf8");
    const manifestPath = resolve(sandbox, "tools/framework/package.json");
    const originalManifest = readFileSync(manifestPath, "utf8");
    mutateLock(mutate);
    const result = run();
    writeFileSync(lockPath, originalLock);
    writeFileSync(manifestPath, originalManifest);
    if (result === undefined) throw new Error(`Adversarial mutation passed: ${description}`);
    if (!result.includes(expected)) throw new Error(`Mutation ${description} failed for the wrong reason: ${result}`);
  }
  const notice = resolve(sandbox, "tools/framework/NOTICE");
  const originalNotice = readFileSync(notice, "utf8");
  writeFileSync(notice, `${originalNotice}\nforged`);
  const noticeResult = run();
  if (noticeResult === undefined) throw new Error("Notice-copy mutation passed");
  console.log(`License audit regression checks passed: valid inventory and ${adversarial.length + 1} fail-closed mutations.`);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

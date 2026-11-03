// Release metadata must stay aligned with the files npm actually publishes.

import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { monorepoRoot } from "#framework/core/env.ts";

const packageRoot = resolve(monorepoRoot, "packages", "clawwright");
const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as {
  name?: string;
  private?: boolean;
  version?: string;
  license?: string;
  homepage?: string;
  bugs?: { url?: string };
  repository?: { type?: string; url?: string; directory?: string };
  bin?: Record<string, string>;
  main?: string;
  exports?: Record<string, string | { types?: string; default?: string }>;
  files?: string[];
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  publishConfig?: { access?: string };
};

const requiredFiles = ["README.md", "LICENSE", "LICENSE-MIT", "LICENSE-APACHE", "NOTICE", "THIRD_PARTY_NOTICES.md"];
for (const file of requiredFiles) await access(resolve(packageRoot, file));
const expectedFiles = ["dist", ...requiredFiles];
if (JSON.stringify(manifest.files) !== JSON.stringify(expectedFiles)) throw new Error("the package files allowlist must contain dist and the exact release metadata files");
if (manifest.name !== "@phpcraftdream/clawwright" || manifest.version !== "0.1.2") throw new Error("package name/version changed during runtime relocation");
if (JSON.stringify(Object.keys(manifest.exports ?? {}).sort()) !== JSON.stringify(["./app", "./commands", "./mounts", "./private-config", "./recipe-kit"].sort())) throw new Error("the package's five public exports changed");
if (JSON.stringify(manifest.dependencies) !== JSON.stringify({ json5: "^2.2.3" })) throw new Error("package runtime dependencies changed during relocation");
const prepackCommand = ["node", "--experimental-strip-types", "../../tools/build-framework-package.ts"];
const prepack = manifest.scripts?.prepack;
if (typeof prepack !== "string" || JSON.stringify(prepack.split(" ")) !== JSON.stringify(prepackCommand)) throw new Error("package prepack does not target the retained repository builder");

if (manifest.private === true) throw new Error("the published package must not be private");
if (manifest.license !== "(MIT OR Apache-2.0)") throw new Error("the package must declare the dual SPDX license");
if (!manifest.homepage || !manifest.bugs?.url || manifest.repository?.type !== "git" || !manifest.repository.url) {
  throw new Error("the package must declare repository, homepage and issue metadata");
}
if (manifest.bin?.clawwright !== "dist/entry/bin.js") throw new Error("the package bin must be clawwright -> dist/entry/bin.js");
const exported = (name: string, types: string, runtime: string): boolean => {
  const entry = manifest.exports?.[name];
  return typeof entry === "object" && entry !== null && entry.types === types && entry.default === runtime;
};
if (!exported("./app", "./dist/core/app.d.ts", "./dist/core/app.js") ||
    !exported("./mounts", "./dist/runtime/mounts.d.ts", "./dist/runtime/mounts.js") ||
    !exported("./commands", "./dist/commands/interface/index.d.ts", "./dist/commands/interface/index.js") ||
    !exported("./private-config", "./dist/security/privacy/private-config.d.ts", "./dist/security/privacy/private-config.js") ||
    !exported("./recipe-kit", "./dist/recipe-kit/index.d.ts", "./dist/recipe-kit/index.js")) {
  throw new Error("the package exports must follow the source layout");
}
// "main": "index.js" sat here naming a file the package does not ship and never did. Nothing
// broke, because "exports" takes precedence over it — but a manifest that points at a file
// that is not there is a claim nobody can act on, and the next tool to read it may not have
// exports to fall back to.
if (manifest.main !== undefined && !manifest.files?.some((entry) => manifest.main?.startsWith(entry))) {
  throw new Error(`the package declares "main": ${JSON.stringify(manifest.main)}, which is not among the files it publishes`);
}
if (manifest.publishConfig?.access !== "public") throw new Error("scoped publishing must declare public access");
if (!requiredFiles.every((file) => manifest.files?.includes(file))) throw new Error("the package files list omits release metadata");

const workflow = await readFile(resolve(monorepoRoot, ".github", "workflows", "publish.yml"), "utf8");
// After 0.1.0 (the one token release) releases publish through npm Trusted Publishing; the
// token job stays only as a fallback, and the OIDC job stays gated by the repository variable.
if (!workflow.includes("default: trusted-publisher") || !workflow.includes("id-token: write") ||
    !workflow.includes("vars.CLAWWRIGHT_ENABLE_TRUSTED_PUBLISHER == 'true'")) {
  throw new Error("releases must default to the Trusted Publisher job, which requests an OIDC token and stays gated by its repository variable");
}

process.stderr.write("package release metadata and legal files passed\n");

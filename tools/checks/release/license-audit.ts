import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function audit(root: string): void {
  const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(resolve(root, "tools/framework/package.json"), "utf8"));
  const packages = lock.packages as Record<string, Record<string, unknown>>;
  if (lock.lockfileVersion !== 3 || !lock.requires || !packages[""]) throw new Error("Unsupported or incomplete npm lockfile");
  if (!manifest.name || !manifest.version || !manifest.dependencies || typeof manifest.dependencies !== "object" || Array.isArray(manifest.dependencies)) throw new Error("Published manifest lacks auditable production metadata");
  if (manifest.peerDependencies && Object.keys(manifest.peerDependencies).length) throw new Error("Published peerDependencies are unsupported until explicitly audited");
  if (manifest.optionalDependencies !== undefined && (!manifest.optionalDependencies || typeof manifest.optionalDependencies !== "object" || Array.isArray(manifest.optionalDependencies))) throw new Error("Unsupported published optionalDependencies metadata");
  if (manifest.dependencies && manifest.optionalDependencies && Object.keys(manifest.dependencies).some((name) => name in manifest.optionalDependencies)) throw new Error("Dependency declared in both required and optional sections");
  if (manifest.peerDependenciesMeta && Object.keys(manifest.peerDependenciesMeta).length) throw new Error("Published peerDependenciesMeta is unsupported until explicitly audited");
  if (manifest.bundleDependencies !== undefined && (!Array.isArray(manifest.bundleDependencies) || manifest.bundleDependencies.length)) throw new Error("Published bundled dependencies are unsupported until explicitly audited");
  if (manifest.bundledDependencies !== undefined && (!Array.isArray(manifest.bundledDependencies) || manifest.bundledDependencies.length)) throw new Error("Published bundled dependencies are unsupported until explicitly audited");
  for (const name of Object.keys(packages)) {
    const entry = packages[name];
    if (entry.inBundle === true) throw new Error(`Bundled lock entry unsupported: ${name}`);
  }
  if (!packages[""]["dependencies"] || typeof packages[""]["dependencies"] !== "object") throw new Error("Root lock dependencies are missing");
  if (manifest.optionalDependencies && !packages[""]["optionalDependencies"]) throw new Error("Root lock optionalDependencies are missing");

  // Exact package/version evidence is recorded in docs/license-audit.md. No license value is
  // accepted generically: each resolved production name/version must have an individual review.
  const reviewed: Record<string, { version: string; license: string; gitHead: string; integrity: string }> = {
    json5: {
      version: "2.2.3",
      license: "MIT",
      gitHead: "c3a75242772a5026a49c4017a16d9b3543b62776",
      integrity: "sha512-XmOWe7eyHYH14cLdVPoyg+GOH3rYX++KpzrylJwSW98t3Nk+U8XOl8FWKOgwtzdb8lXGf6zYwDUzeHMWfxasyg==",
    },
  };
  const packageName = (path: string): string => {
    const marker = "/node_modules/";
    const index = path.lastIndexOf(marker);
    const installed = index >= 0 ? path.slice(index + marker.length) : path.replace(/^node_modules\//, "");
    const segments = installed.split("/");
    return segments[0].startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
  };
  const lockEntry = (parent: string, name: string): string => {
    let path = parent;
    while (true) {
      const candidate = `${path ? `${path}/` : ""}node_modules/${name}`;
      if (Object.hasOwn(packages, candidate)) return candidate;
      const index = path.lastIndexOf("/node_modules/");
      if (index >= 0) path = path.slice(0, index);
      else if (path.startsWith("node_modules/")) path = "";
      else break;
    }
    const top = `node_modules/${name}`;
    if (Object.hasOwn(packages, top)) return top;
    throw new Error(`Dependency missing from lockfile: ${parent || manifest.name} -> ${name}`);
  };
  const lockedRoot = packages[""]["dependencies"] as Record<string, string>;
  const lockedOptional = (packages[""]["optionalDependencies"] ?? {}) as Record<string, string>;
  function unsupportedRange(name: string, range: unknown): asserts range is string {
    if (typeof range !== "string" || range.startsWith("npm:") || range.startsWith("file:") || range.startsWith("workspace:")
      || range.startsWith("git+") || range.startsWith("http") || range.startsWith("link:")) {
      throw new Error(`Unsupported dependency range or alias for ${name}`);
    }
  }
  const rangeEntries = (edges: unknown, parent: string): [string, string][] => {
    if (edges === undefined) return [];
    if (!edges || typeof edges !== "object" || Array.isArray(edges)) throw new Error(`Unsupported dependency metadata: ${parent}`);
    return Object.entries(edges).map(([name, range]) => {
      unsupportedRange(name, range);
      return [name, range];
    });
  };
  const queue: Array<{ name: string; path: string }> = [
    ...rangeEntries(manifest.dependencies, "published dependencies").map(([name]) => ({ name, path: lockEntry("", name) })),
    ...rangeEntries(manifest.optionalDependencies, "published optionalDependencies").map(([name]) => ({ name, path: lockEntry("", name) })),
  ];
  for (const [name, range] of rangeEntries(manifest.dependencies, "published dependencies")) {
    if (lockedRoot[name] !== range) throw new Error(`Manifest/lock range mismatch for ${name}: ${range} vs ${lockedRoot[name] ?? "(missing)"}`);
  }
  for (const [name, range] of rangeEntries(manifest.optionalDependencies, "published optionalDependencies")) {
    if (lockedOptional[name] !== range) throw new Error(`Manifest/lock range mismatch for ${name}: ${range} vs ${lockedOptional[name] ?? "(missing)"}`);
  }

  const visited = new Set<string>();
  while (queue.length) {
    const { name, path } = queue.shift()!;
    if (visited.has(path)) continue;
    visited.add(path);
    const entry = packages[path];
    if (typeof entry.resolved !== "string" || !/^https:\/\//.test(entry.resolved) || typeof entry.integrity !== "string" || !/^sha(1|256|384|512)-/.test(entry.integrity)) {
      throw new Error(`Unsupported or incomplete resolved/integrity lock metadata: ${path}`);
    }
    if (entry.peerDependencies !== undefined && (!entry.peerDependencies || typeof entry.peerDependencies !== "object" || Array.isArray(entry.peerDependencies))) throw new Error(`Unsupported peerDependencies metadata: ${path}`);
    if (entry.peerDependencies && Object.keys(entry.peerDependencies).length) throw new Error(`Transitive peerDependencies are unsupported until explicitly audited: ${path}`);
    if (typeof entry.version !== "string" || typeof entry.license !== "string" || !entry.license.trim()) throw new Error(`Missing version/license metadata: ${path}`);
    const license = entry.license;
    const evidence = reviewed[name];
    if (!evidence || evidence.version !== entry.version || evidence.license !== license) {
      throw new Error(`No exact-version reviewed provenance for ${name}@${entry.version} (lock license: ${license})`);
    }
    if (name === "json5") {
      if (entry.version !== evidence.version || license !== evidence.license || entry.integrity !== evidence.integrity
        || entry.resolved !== "https://registry.npmjs.org/json5/-/json5-2.2.3.tgz") {
        throw new Error("json5 lock metadata differs from the registry evidence reviewed for 2.2.3");
      }
      if (evidence.gitHead !== "c3a75242772a5026a49c4017a16d9b3543b62776") throw new Error("json5 reviewed source provenance mismatch");
    }
    for (const field of ["dependencies", "optionalDependencies"] as const) {
      const edges = entry[field];
      if (edges === undefined) continue;
      const resolvedEdges = rangeEntries(edges, `${field}: ${path}`);
      for (const [child, range] of resolvedEdges) {
        const childPath = lockEntry(path, child);
        const childEntry = packages[childPath];
        if (!childEntry) throw new Error(`Dependency missing from lockfile: ${path} -> ${child}`);
        if (childEntry.version !== range) throw new Error(`Dependency range/version mismatch for ${child}: ${range} vs ${String(childEntry.version ?? "(missing)")}`);
        if (!visited.has(childPath)) queue.push({ name: packageName(childPath), path: childPath });
      }
    }
  }
  for (const file of ["LICENSE", "LICENSE-MIT", "LICENSE-APACHE", "NOTICE"]) {
    const repositoryNotice = readFileSync(resolve(root, file), "utf8");
    const frameworkNotice = readFileSync(resolve(root, "tools/framework", file), "utf8");
    if (repositoryNotice !== frameworkNotice) throw new Error(`Repository/framework notice mismatch: ${file}`);
  }
  console.log(`License audit passed for ${visited.size} exact-version reviewed production dependency entries; LICENSE/NOTICE copies match.`);
}

const defaultRoot = resolve(import.meta.dirname, "../../..");
if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) audit(defaultRoot);

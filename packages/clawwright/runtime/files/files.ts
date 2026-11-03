import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Transport } from "../transport/transport.ts";
import { assertTargetContained } from "./target-boundary.ts";

export interface MirrorResult {
  readonly written: number;
  readonly removed: string[];
}

/** Apply an explicit, already-filtered file list using the provision-agent mirror algorithm. */
export async function syncFileTree(
  transport: Transport,
  dataDir: string,
  sourceDir: string,
  targetDir: string,
  relPaths: readonly string[],
  previouslyOwned?: readonly string[],
): Promise<MirrorResult> {
  const alreadyThere = await transport.listFiles(targetDir);
  const declared = new Set(relPaths);
  const eligible = previouslyOwned === undefined ? alreadyThere : alreadyThere.filter((rel) => previouslyOwned.includes(rel));
  const foldedPaths = relPaths.map((rel) => rel.toLocaleLowerCase("en-US"));
  for (let i = 0; i < foldedPaths.length; i += 1) {
    for (let j = i + 1; j < foldedPaths.length; j += 1) {
      if (foldedPaths[i] === foldedPaths[j] || foldedPaths[i].startsWith(`${foldedPaths[j]}/`) || foldedPaths[j].startsWith(`${foldedPaths[i]}/`)) {
        throw new Error(`desired paths collide case-insensitively: ${relPaths[i]} and ${relPaths[j]}`);
      }
    }
  }
  const isBelow = (parent: string, child: string): boolean => child.startsWith(`${parent}/`);
  const stale = eligible.filter((rel) => !declared.has(rel));
  const foldedStaleAliases = stale.filter((rel) => relPaths.some((desired) =>
    rel !== desired && rel.toLocaleLowerCase("en-US") === desired.toLocaleLowerCase("en-US"),
  ));
  await assertTargetContained(transport, dataDir, [targetDir, ...relPaths.map((rel) => `${targetDir}/${rel}`), ...stale.map((rel) => `${targetDir}/${rel}`)]);
  const removed = new Set<string>();
  for (const rel of foldedStaleAliases) {
    await transport.remove(`${targetDir}/${rel}`);
    removed.add(rel);
  }
  for (const rel of stale.filter((old) => relPaths.some((desired) => isBelow(old, desired)))) {
    if (removed.has(rel)) continue;
    await transport.remove(`${targetDir}/${rel}`);
    removed.add(rel);
  }
  for (const desired of relPaths) {
    const descendants = stale.filter((rel) => isBelow(desired, rel));
    if (descendants.length === 0) continue;
    for (const rel of descendants) {
      if (removed.has(rel)) continue;
      await transport.remove(`${targetDir}/${rel}`);
      removed.add(rel);
    }
    if (transport.removeEmptyTree === undefined || !(await transport.removeEmptyTree(`${targetDir}/${desired}`))) {
      throw new Error(`cannot replace directory with file "${targetDir}/${desired}" safely: it contains unknown content`);
    }
  }
  const dirs = new Set<string>();
  for (const rel of relPaths) {
    const slash = rel.lastIndexOf("/");
    if (slash !== -1) dirs.add(rel.slice(0, slash));
  }
  await transport.mkdirp(targetDir);
  for (const dir of dirs) await transport.mkdirp(`${targetDir}/${dir}`);
  for (const rel of relPaths) {
    const path = `${targetDir}/${rel}`;
    if (!alreadyThere.includes(rel) && transport.removeEmptyTree !== undefined) await transport.removeEmptyTree(path);
    const content = await readFile(resolve(sourceDir, ...rel.split("/")));
    await transport.writeFile(path, content);
  }
  for (const rel of stale) {
    if (removed.has(rel)) continue;
    await transport.remove(`${targetDir}/${rel}`);
    removed.add(rel);
  }
  return { written: relPaths.length, removed: [...removed].sort() };
}

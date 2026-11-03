// `tailscale serve reset` wipes every other service's route on the target, so no text this
// framework ships (command sources, help, guide) may recommend it — it may only be named
// to say "never". A scan over the texts, so a new advice string cannot slip the rule.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { monorepoRoot } from "#framework/core/env.ts";
import { check, finish } from "#checks/kit/harness.ts";

const ROOTS = [join(monorepoRoot, "packages", "clawwright"), join(monorepoRoot, "docs", "guide")];
const PHRASE = /serve\s+reset/g;

const offenders: string[] = [];
let scanned = 0;
for (const root of ROOTS) {
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(ts|md)$/.test(entry.name)) continue;
    const path = join(entry.parentPath, entry.name);
    if (path.includes("node_modules")) continue;
    const text = await readFile(path, "utf8");
    scanned += 1;
    for (const match of text.matchAll(PHRASE)) {
      const before = text.slice(Math.max(0, match.index - 80), match.index);
      if (!/\bnever\b/i.test(before)) offenders.push(`${path}:${text.slice(0, match.index).split("\n").length}`);
    }
  }
}

check("the scan saw the framework sources and the guide", scanned > 50, true);
check("no shipped text recommends `tailscale serve reset` (only \"never\" mentions)", offenders, []);

finish("no-serve-reset");

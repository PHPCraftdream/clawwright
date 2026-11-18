// Regenerates the golden snapshots under tools/checks/golden/expected/ from the current
// behaviour. Run via `npm run golden:update`; the committed diff is the review artifact —
// never commit a snapshot change you cannot explain.

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderGolden, snapshotsDir } from "#checks/golden/render.ts";

const rendered = await renderGolden();
await mkdir(snapshotsDir(), { recursive: true });
for (const [name, text] of Object.entries(rendered)) {
  await writeFile(resolve(snapshotsDir(), name), text, "utf8");
  process.stderr.write(`wrote expected/${name} (${Buffer.byteLength(text)} bytes)\n`);
}

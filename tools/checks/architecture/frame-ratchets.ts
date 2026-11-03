import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { checkTrue } from "#checks/kit/harness.ts";

interface PerFileMetric { readonly comment: string; readonly total: number; readonly files: Record<string, number>; }
interface Ratchet { readonly name: string; readonly expected: number; readonly actual: number; readonly grew: readonly string[]; readonly unrecordedShrank: readonly string[]; readonly unrecordedMessages: readonly string[]; readonly details: readonly string[]; }
function perFileRatchet(name: string, before: Record<string, number>, after: Map<string, number>): Ratchet {
  const grew: string[] = []; const shrank: string[] = []; const unrecordedMessages: string[] = []; const files = new Set([...Object.keys(before), ...after.keys()]); let expectedTotal = 0; let actualTotal = 0;
  for (const file of files) { const was = before[file] ?? 0; const now = after.get(file) ?? 0; expectedTotal += was; actualTotal += now; if (now > was) grew.push(`${file} (${was} → ${now})`); if (now < was) { shrank.push(`${file} (${was} → ${now})`); unrecordedMessages.push(`${name}: lower the baseline to ${now} in the same commit (decreased: ${file} (${was} → ${now}))`); } }
  const details = [...grew]; if (shrank.length > 0) details.push(`lower the baseline to ${actualTotal} in the same commit`, ...shrank);
  return { name, expected: expectedTotal, actual: actualTotal, grew, unrecordedShrank: shrank, unrecordedMessages, details };
}
function ratchet(name: string, expected: number, actual: number): Ratchet { return { name, expected, actual, grew: [], unrecordedShrank: actual < expected ? [`lower baseline to ${actual}`] : [], unrecordedMessages: [], details: actual < expected ? [`lower the baseline to ${actual} in the same commit`] : [] }; }
function report(result: Ratchet): void { checkTrue(`${result.name} equals the baseline (${result.actual} measured, ${result.expected} recorded)`, result.actual === result.expected); const problems = result.grew.map((file) => `${result.name}: a new occurrence was added: ${file}`); problems.push(...(result.unrecordedMessages.length > 0 ? result.unrecordedMessages : result.unrecordedShrank.map((file) => `${result.name}: lower the baseline to ${result.actual} in the same commit (decreased: ${file})`))); checkTrue(`${result.name}: no single-file growth and no unrecorded decrease`, problems.length === 0); for (const line of [...problems, ...result.details]) process.stderr.write(`    ${line}\n`); }
export async function runFrameRatchets(root: string, frameworkFiles: readonly string[], rel: (full: string) => string, baseline: { frameReads: { total: number }; frameInstalls: PerFileMetric; modeDeciders: PerFileMetric }): Promise<void> {
const FRAME_READ = /\b(?:invocation|currentFrame)\(\s*\)/;
// help-render.ts and log.ts left the exemption with S1.4: both take the frame from the invocation module (renderCurrentAdviceRows) now.
const FRAME_READ_EXEMPT = (file: string): boolean => file.startsWith("packages/clawwright/core/io/invocation/");
let frameReadTotal = 0;
for (const full of [...frameworkFiles, resolve(root, "tools", "clawwright.ts")]) {
  if (FRAME_READ_EXEMPT(rel(full))) continue;
  for (const line of (await readFile(full, "utf8")).split("\n")) {
    let stripped = line.replace(/(^|\s)\/\/.*$/, "$1");
    stripped = stripped.replace(/\/\*.*?\*\//g, "");
    const trimmed = stripped.trim();
    if (trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    frameReadTotal += (stripped.match(new RegExp(FRAME_READ.source, "g")) ?? []).length;
  }
}
report(ratchet("frameReads", baseline.frameReads.total, frameReadTotal));
const FRAME_INSTALL = /\b(?:installFrame|setInvocation)\(/;
const frameInstallsAfter = new Map<string, number>(); let frameInstallTotal = 0;
for (const full of [...frameworkFiles, resolve(root, "tools", "clawwright.ts")]) { if (rel(full).startsWith("packages/clawwright/core/io/invocation/")) continue; let counted = 0; for (const line of (await readFile(full, "utf8")).split("\n")) { let stripped = line.replace(/(^|\s)\/\/.*$/, "$1"); stripped = stripped.replace(/\/\*.*?\*\//g, ""); const trimmed = stripped.trim(); if (trimmed.startsWith("*") || trimmed.startsWith("/*")) continue; counted += (stripped.match(new RegExp(FRAME_INSTALL.source, "g")) ?? []).length; } if (counted > 0) { frameInstallsAfter.set(rel(full), counted); frameInstallTotal += counted; } }
report(perFileRatchet("frameInstalls", baseline.frameInstalls.files, frameInstallsAfter));
report(ratchet("frameInstalls.total", baseline.frameInstalls.total, frameInstallTotal));
const MODE_LITERAL = /(?:\bmode\s*(?:===|!==|==|!=|=)\s*["'](?:installed|checkout|local-package)["']|\bkind\s*(?:===|!==|==|!=|=)\s*["'](?:system|checkout-shim|deployment-shim|npm-bin|verbatim)["']|\bcase\s+["'](?:system|checkout-shim|deployment-shim|npm-bin|verbatim|installed|checkout|local-package)["']\s*:|[?]\s*["'](?:installed|checkout|local-package)["']\s*:\s*["'](?:installed|checkout|local-package)["'])/;
const MODE_EXEMPT_LINES: Readonly<Record<string, ReadonlySet<string>>> = {
  "packages/clawwright/core/io/invocation/frame.ts": new Set(["case \"system\": return \"installed\";", "case \"checkout-shim\":", "case \"deployment-shim\": return \"checkout\";", "case \"npm-bin\": return \"local-package\";", "case \"verbatim\": return launch.mode;"]),
  "packages/clawwright/core/io/invocation/index.ts": new Set(["mode: value.mode as InvocationMode", "mode: mode as InvocationMode", "readonly mode: InvocationMode;", "mode: \"checkout\"", "if (mode === \"installed\" && (trimmed.startsWith(\"./\") || trimmed.startsWith(\".\\\\\"))) return undefined;"]),
  "packages/clawwright/core/io/invocation/render.ts": new Set(["mode: modeOf(launch),", "const launchRoot = f.launch.kind === \"checkout-shim\" || f.launch.kind === \"deployment-shim\" || f.launch.kind === \"npm-bin\" ? f.launch.root : undefined;"]),
  "packages/clawwright/entry/delegate.ts": new Set(["if (rootedLaunch(frame.launch).kind === \"system\") {"]),
  "packages/clawwright/entry/resolve.ts": new Set(["if (rootedLaunch(frame.launch).kind === \"system\") {", "...(rootedLaunch(frame.launch).kind === \"system\""]),
  "packages/clawwright/integration/mcp/project.ts": new Set(["return mode === \"installed\" ? INSTALLED_LAUNCHER : MONOREPO_LAUNCHER;"]),
  "packages/clawwright/integration/deployment/init.ts": new Set(),
};
const modeDecidersAfter = new Map<string, number>();
const modeOfSource = await readFile(resolve(root, "packages/clawwright/core/io/invocation/frame.ts"), "utf8");
const modeOfBody = modeOfSource.slice(modeOfSource.indexOf("export function modeOf(")).split("\n/**")[0];
// frame.ts is the sole modeOf owner: its switch arms are the one computation, counted once
// when modeOf's own decision body exists (not per-arm); a new mode decision construct anywhere
// else (comparison, case arm, ternary pair) outside the exact allow-list above fails.
const modeOfLines = modeOfBody.split("\n").filter((line) => MODE_LITERAL.test(line) && !MODE_EXEMPT_LINES["packages/clawwright/core/io/invocation/frame.ts"].has(line.trim()));
modeDecidersAfter.set("packages/clawwright/core/io/invocation/frame.ts", modeOfLines.length === 0 && /export function modeOf\(/.test(modeOfBody) ? 1 : modeOfLines.length);
for (const full of [...frameworkFiles, resolve(root, "tools", "clawwright.ts")]) { const file = rel(full); if (file === "packages/clawwright/core/io/invocation/frame.ts") continue; let counted = 0; for (const sourceLine of (await readFile(full, "utf8")).split("\n")) { const line = sourceLine.replace(/(^|\s)\/\/.*$/, "$1").replace(/\/\*.*?\*\//g, ""); if (line.trim().startsWith("*") || line.trim().startsWith("/*")) continue; if (MODE_EXEMPT_LINES[file]?.has(line.trim()) === true || file === "packages/clawwright/integration/deployment/init.ts") continue; if (MODE_LITERAL.test(line)) counted++; } if (counted > 0) modeDecidersAfter.set(file, counted); }
report(perFileRatchet("modeDeciders", baseline.modeDeciders.files, modeDecidersAfter));
report(ratchet("modeDeciders.total", baseline.modeDeciders.total, modeDecidersAfter.size));
}

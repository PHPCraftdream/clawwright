import { readFile, stat, writeFile, rename, unlink, chmod } from "node:fs/promises";
import { dirname, resolve, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { prepareLint } from "#src/commands/management/recipe/recovery/checks/lint/plan.ts";
import { collectPortableRecipeFiles } from "#src/security/privacy/recipe-portable-content.ts";
import { extractArtifactDeclarations } from "#src/commands/management/recipe/recovery/checks/lint/artifacts.ts";
import { fetchPublishedChecksum, type FetchSeam } from "./checksum.ts";

export type PinErrorCode = "version" | "not-found" | "ambiguous" | "already-current" | "unsupported" | "stale" | "utf8" | "shared";
export class PinError extends Error { readonly name = "PinError"; readonly code: PinErrorCode; constructor(code: PinErrorCode, message: string) { super(message); this.code = code; } }
export interface PinPlan { readonly directory: string; readonly file: string; readonly snapshot: Buffer; readonly updated: Buffer; readonly version: string; readonly artifact: string; readonly oldVersion: string; readonly oldChecksum: string; readonly versionLine: number; readonly checksumLine: number; readonly assetURL: string; readonly spans: readonly { start: number; end: number; role: "version" | "checksum"; value: string }[] }
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.+-]*$/;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export async function preparePin(directory: string, version: string, artifact?: string): Promise<PinPlan> {
  if (!TOKEN.test(version) || version === "." || version === "..") throw new PinError("version", "version must be a plain token (letters/digits, then letters digits _ . + -)");
  const walked = await collectPortableRecipeFiles(directory, { excludeTop: "node_modules" });
  const portable = walked.files.filter((f) => !f.split("/").includes("node_modules")).sort();
  const lint = await prepareLint(directory, portable);
  type Entry = { file: string; bytes: Buffer; source: string; declaration: ReturnType<typeof extractArtifactDeclarations>[number] };
  const all: Entry[] = [];
  const found: Entry[] = [];
  const selectorOf = (declaration: Entry["declaration"]): string => basename(declaration.urlTemplate.replace(new RegExp(`\\$\\{?${declaration.versionArg}\\}?`, "g"), declaration.version));
  for (const file of lint.targets) {
    const bytes = await readFile(resolve(directory, ...file.split("/")));
    let source: string;
    try { source = utf8.decode(bytes); } catch { throw new PinError("utf8", `${file} is not valid UTF-8; re-encode the file and rerun the pin command`); }
    for (const declaration of extractArtifactDeclarations(source)) {
      const entry: Entry = { file, bytes, source, declaration };
      all.push(entry);
      if (artifact === undefined || artifact === selectorOf(declaration)) found.push(entry);
    }
  }
  if (!found.length) throw new PinError("not-found", `no pinned artifact declaration matching ${artifact === undefined ? "any artifact" : `artifact "${artifact}"`} found in recipe files under ${directory} (searched Dockerfiles for ADD --checksum=sha256:$ARG with a versioned https:// URL)`);
  if (found.length !== 1) throw new PinError("ambiguous", `multiple pinned artifacts match: ${[...new Set(found.map((e) => selectorOf(e.declaration)))].join(", ")}; pass --artifact to choose one`);
  const { file, bytes, source, declaration: d } = found[0];
  if (version === d.version) throw new PinError("already-current", `version ${d.version} is already pinned; pass a different version to update it`);
  const conflicts = all.filter((e) => !(e.file === file && e.declaration.line === d.line) && (e.declaration.versionArg === d.versionArg || e.declaration.checksumArg === d.checksumArg || (e.file === file && e.declaration.checksumArgLine === d.checksumArgLine)));
  if (conflicts.length) {
    const described = conflicts.map((e) => `${selectorOf(e.declaration)} (ARG ${[e.declaration.versionArg, e.declaration.checksumArg].filter((n) => n === d.versionArg || n === d.checksumArg).join(", ")})`);
    throw new PinError("shared", `artifact ${selectorOf(d)} shares ARG definitions with other pinned artifacts: ${described.join(", ")}; repinning would change those artifacts too — split the ARGs per artifact first`);
  }
  const assetURL = d.urlTemplate.replaceAll(`\${${d.versionArg}}`, version).replaceAll(`$${d.versionArg}`, version);
  const spans: { start: number; end: number; role: "version" | "checksum"; value: string }[] = [];
  const lines = source.split(/\r\n|\n|\r/);
  const offsets: number[] = []; let cursor = 0;
  for (const line of lines) { offsets.push(cursor); cursor += line.length + (source.slice(cursor + line.length).startsWith("\r\n") ? 2 : source.slice(cursor + line.length).startsWith("\n") || source.slice(cursor + line.length).startsWith("\r") ? 1 : 0); }
  const locate = (lineNo: number, arg: string, expected: string): void => {
    const line = lines[lineNo - 1] ?? "";
    const m = /^([\t ]*ARG[\t ]+)([A-Za-z_]\w*)([\t ]*=\s*)(["']?)([^\s"'#]+)(["']?)([\t ]*(?:#.*)?)$/i.exec(line);
    if (!m || m[2] !== arg || m[5] !== expected || Boolean(m[4]) !== Boolean(m[6]) || (m[4] && m[4] !== m[6])) throw new PinError("unsupported", `unsupported ARG line shape at ${file}:${lineNo}: expected "ARG ${arg}=<value>" with optional matching quotes and no inline comment, found "${line.trim()}"`);
    const start = offsets[lineNo - 1] + m[1].length + m[2].length + m[3].length + m[4].length;
    spans.push({ start, end: start + m[5].length, role: arg === d.versionArg ? "version" : "checksum", value: expected });
  };
  locate(d.versionArgLine, d.versionArg, d.version);
  locate(d.checksumArgLine, d.checksumArg, d.checksum);
  return { directory, file, snapshot: bytes, updated: bytes, version, artifact: basename(assetURL), oldVersion: d.version, oldChecksum: d.checksum, versionLine: d.versionArgLine, checksumLine: d.checksumArgLine, assetURL, spans };
}

export async function executePin(plan: PinPlan, options: { fetcher?: FetchSeam; beforeWrite?: () => void | Promise<void>; apply?: boolean } = {}) {
  const checksum = await fetchPublishedChecksum(plan.assetURL, options.fetcher);
  let patched = plan.snapshot.toString("utf8");
  for (const span of [...plan.spans].sort((a, b) => b.start - a.start)) {
    const replacement = span.role === "version" ? plan.version : checksum.digest;
    patched = patched.slice(0, span.start) + replacement + patched.slice(span.end);
  }
  const output = Buffer.from(patched, "utf8");
  if (options.apply) {
    const path = resolve(plan.directory, ...plan.file.split("/"));
    await options.beforeWrite?.();
    if (!(await readFile(path)).equals(plan.snapshot)) throw new PinError("stale", `${plan.file} changed since the plan was prepared; rerun the pin command`);
    const mode = (await stat(path)).mode;
    const temp = resolve(dirname(path), `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);
    try { await writeFile(temp, output, { flag: "wx", mode }); await chmod(temp, mode); if (!(await readFile(path)).equals(plan.snapshot)) throw new PinError("stale", `${plan.file} changed since the plan was prepared; rerun the pin command`); await rename(temp, path); }
    catch (error) { await unlink(temp).catch(() => undefined); throw error; }
  }
  return { old: { version: plan.oldVersion, checksum: plan.oldChecksum }, new: { version: plan.version, checksum: checksum.digest }, digest: checksum.digest, sourceURL: checksum.sourceURL, assetURL: plan.assetURL, applied: options.apply === true, file: plan.file, versionLine: plan.versionLine, checksumLine: plan.checksumLine, diff: `-${plan.oldVersion} / ${plan.oldChecksum}\n+${plan.version} / ${checksum.digest}`, next: "recipe install" };
}

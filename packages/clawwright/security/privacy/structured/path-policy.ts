import type { Context } from "../../../core/context.ts";
import type { ExecResult } from "../../../runtime/transport/transport.ts";
import { installedRecipePrivatePaths } from "../../../service/recipe.ts";

/** Normalizes a data-relative POSIX path by segments: collapses "//" and ".", resolves ".."
 *  textually. Returns null when the path climbs above its root. */
function normalizeRelativeSegments(path: string): string[] | null {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments;
}

// Fed to `sh -s` on stdin with the candidate ancestors as argv, since a multi-line argument
// doesn't survive wsl.exe's re-parsing. Explicit `exit 0` keeps the verdict on stdout alone —
// a for loop's exit status is its body's last command, so an all-clear scan would exit 1.
const SYMLINK_SCAN = `for p in "$@"; do
  [ -h "$p" ] && echo "$p"
done
exit 0
`;

/** Enforces the existing declared-path and ancestor-symlink policy. */
export async function assertDeclaredPrivatePath(
  ctx: Context,
  path: string,
  mode: "file" | "directory",
): Promise<{ ledger: string; boundary: string; target: string }> {
  const dataDir = ctx.settings?.dataDir ?? "";
  if (dataDir === "" || !path.startsWith(`${dataDir}/`)) {
    throw new Error(`private target path must be inside the data directory (${dataDir === "" ? "context has no dataDir" : dataDir}): ${path}`);
  }
  const rawRelative = path.slice(dataDir.length + 1);
  const relative = normalizeRelativeSegments(rawRelative);
  if (relative === null || relative.length === 0) {
    throw new Error(`private target path must stay inside the data directory: ${path}`);
  }
  const declared = await installedRecipePrivatePaths();
  const boundary = declared.find((candidate) => {
    const declaredSegments = candidate.split("/");
    return declaredSegments.length > 0 && relative.length >= declaredSegments.length
      && declaredSegments.every((segment, index) => relative[index] === segment);
  });
  if (boundary === undefined) {
    throw new Error(
      `private target path is not covered by any recipe's privatePaths — declare it (or a parent directory of it) in recipes/<name>/recipe.json: ${path}`,
    );
  }
  // Every proper prefix of the raw path is a directory the kernel crosses before the final
  // component. Directory mode adds the final component itself.
  const rawSegments = rawRelative.split("/");
  const checked = Array.from(
    { length: rawSegments.length - 1 },
    (_, depth) => `${dataDir}/${rawSegments.slice(0, depth + 1).join("/")}`,
  );
  if (mode === "directory") checked.push(`${dataDir}/${relative.join("/")}`);
  if (checked.length > 0) {
    let result: ExecResult;
    try {
      result = await ctx.transport.exec("sh", ["-s", "--", ...checked], { input: SYMLINK_SCAN, allowFailure: true });
    } catch (error) {
      throw new Error(`could not check the private target path for symlinks: ${(error as Error).message}`);
    }
    if (result.code !== 0) {
      throw new Error(`could not check the private target path for symlinks (exit ${result.code}): ${result.stderr.trim()}`);
    }
    const lines = result.stdout.split("\n").filter((line) => line !== "");
    if (lines.length > 0) {
      throw new Error(`private target path crosses a symlinked directory (${lines[0]}): ${path}`);
    }
  }
  return { ledger: relative.join("/"), boundary, target: `${dataDir}/${relative.join("/")}` };
}


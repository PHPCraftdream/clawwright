import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/** Refuse transport mutations outside the fixture, including through existing symlinks. */
export async function fixtureMutationTarget(root: string, path: string): Promise<string> {
  const base = await realpath(root);
  const target = resolve(base, relative(resolve(root), resolve(path)));
  const inside = (value: string) => {
    const part = relative(base, value);
    return part !== "" && part !== ".." && !part.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(part);
  };
  if (!inside(target)) throw new Error("fixture mutation outside root");
  // Check every component, not just the nearest existing one: lstat follows
  // symlinks in intermediate components. This is not atomic with the mutation.
  let ancestor = target;
  while (ancestor !== base) {
    try {
      const info = await lstat(ancestor);
      if (info.isSymbolicLink()) throw new Error("fixture mutation through symlink");
      const actual = await realpath(ancestor);
      if (actual !== base && !inside(actual)) throw new Error("fixture mutation through outside symlink");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    ancestor = dirname(ancestor);
  }
  return target;
}

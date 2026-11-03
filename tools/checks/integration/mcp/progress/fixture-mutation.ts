import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** Refuse transport mutations outside the fixture, including through existing symlinks. */
export async function fixtureMutationTarget(root: string, path: string): Promise<string> {
  const base = await realpath(root);
  const target = resolve(base, relative(resolve(root), resolve(path)));
  const inside = (value: string) => {
    const part = relative(base, value);
    return part !== "" && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
  };
  if (!inside(target)) throw Object.assign(new Error("FIXTURE_OUTSIDE_ROOT"), { code: "FIXTURE_OUTSIDE_ROOT" });
  // Check every component, not just the nearest existing one: lstat follows
  // symlinks in intermediate components. This is not atomic with the mutation.
  let ancestor = target;
  while (ancestor !== base) {
    try {
      const info = await lstat(ancestor);
      if (info.isSymbolicLink()) throw new Error("FIXTURE_SYMLINK");
      const actual = await realpath(ancestor);
      if (actual !== base && !inside(actual)) throw new Error("FIXTURE_OUTSIDE_SYMLINK");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    ancestor = dirname(ancestor);
  }
  return target;
}

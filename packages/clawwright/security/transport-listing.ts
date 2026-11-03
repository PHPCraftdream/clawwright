import type { ExecOptions, ExecResult } from "../runtime/transport/transport.ts";

/** Lists files through a remote transport; only a missing root is empty. */
export async function listFilesVia(
  exec: (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>,
  dir: string,
): Promise<string[]> {
  const result = await exec("find", [dir, "-type", "f"], { allowFailure: true, env: { LC_ALL: "C" } });
  if (result.code !== 0) {
    if (isMissingFindRoot(result.stderr, dir)) return [];
    throw new Error(`could not list files in ${dir}: ${result.stderr.trim() || `find exited ${result.code}`}`);
  }
  const prefix = `${dir.replace(/\/+$/, "")}/`;
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
}

function isMissingFindRoot(stderr: string, dir: string): boolean {
  const roots = new Set([dir, dir.replace(/\/+$/, "") || "/"]);
  const messages = [...roots].flatMap((root) => [
    `find: '${root}': No such file or directory`,
    `find: ‘${root}’: No such file or directory`,
    `find: "${root}": No such file or directory`,
    `find: ${root}: No such file or directory`,
  ]);
  return messages.includes(stderr.trim());
}

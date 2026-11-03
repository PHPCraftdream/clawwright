// Target and tooling share a filesystem: the fast path.

import { randomBytes } from "node:crypto";
import { readFile, mkdir, rm, rmdir, access, readdir, stat, lstat, open, rename, type FileHandle } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { ExecOptions, ExecResult, Transport } from "./exec.ts";
import { spawnLocal, composeExecFailure } from "./exec.ts";
import { PUBLISH_STAGING_MARKER } from "./quoting.ts";

export class LocalTransport implements Transport {
  readonly description = "local";
  readonly cancellation = "confirmed-local" as const;

  async exec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    try {
      return await spawnLocal(command, args, options);
    } catch (error) {
      // spawnLocal always rejects on ENOENT, even under allowFailure. Here `command` IS the
      // target command, so a missing one is the target's ordinary "not found" (exit 127).
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const result: ExecResult = { code: 127, stdout: "", stderr: `${command}: command not found\n` };
        if (options.allowFailure === true) return result;
        throw composeExecFailure(command, args, result);
      }
      throw error;
    }
  }

  readFile(path: string): Promise<string> {
    return readFile(path, "utf8");
  }

  async writeFile(path: string, content: string | Uint8Array, mode?: string): Promise<void> {
    // Same publish contract as publishCommand() on the remote transports: a temp sibling
    // renamed over the name. rename(2) replaces a symlink at path instead of following it.
    const temporary = `${path}${PUBLISH_STAGING_MARKER}${randomBytes(8).toString("hex")}`;
    let handle: FileHandle | undefined;
    try {
      handle = await open(temporary, "wx", mode === undefined ? 0o666 : Number.parseInt(mode, 8));
      await handle.writeFile(content);
      await handle.close();
      await rename(temporary, path);
    } catch (error) {
      await handle?.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async writePrivateFile(path: string, content: string | Uint8Array): Promise<void> {
    const { createPrivateBinaryFile, createPrivateFile } = await import("../../security/privacy/private-file.ts");
    if (typeof content === "string") await createPrivateFile(path, content);
    else await createPrivateBinaryFile(path, content);
  }

  async mkdirPrivate(path: string): Promise<void> {
    await mkdir(path, { mode: 0o700 });
    try {
      const { protectPrivateDirectory } = await import("../../security/privacy/private-file.ts");
      await protectPrivateDirectory(path);
    } catch (error) {
      await rmdir(path).catch(() => {});
      throw error;
    }
  }

  /** Same distinction existsVia() makes: ENOENT/ENOTDIR is an answer; any other errno (EACCES,
   *  an I/O error) is the check failing, not "absent". */
  async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return false;
      throw new Error(`could not check whether ${path} exists: ${(error as Error).message}`);
    }
  }

  async existsEntry(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return false;
      throw error;
    }
  }

  async mkdirp(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }

  async remove(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  }

  async removeEmptyDir(path: string): Promise<void> {
    await rmdir(path);
  }

  async removeEmptyTree(path: string): Promise<boolean> {
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return false;
      throw error;
    }
    if (!info.isDirectory()) return false;
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) await this.removeEmptyTree(join(path, entry.name));
    }
    try {
      await rmdir(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOTEMPTY") return false;
      throw error;
    }
  }

  async listFiles(dir: string): Promise<string[]> {
    try {
      const info = await stat(dir);
      if (!info.isDirectory()) throw new Error(`cannot list files: not a directory: ${dir}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const entries = await readdir(dir, { withFileTypes: true, recursive: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"));
  }

  clientInvocation(entryPath: string, args: string[]): { command: string; args: string[] } {
    return { command: entryPath, args };
  }
}

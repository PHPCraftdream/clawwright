// The path bridge: one place that knows how the same file is named in different worlds.
//
// Four coordinate systems, each meaningless in another: tool (where this process runs —
// D:\dev\x on Windows, /mnt/d/dev/x in WSL, /d/dev/x in Git Bash), target (the machine the
// instance lives on, e.g. /srv/openclaw/data), container (inside the gateway, e.g.
// /home/node/.openclaw), remote (an install dir on a server, e.g. /opt/openclaw).
//
// Centralised because: docker compose runs on the target, not tool coordinates; a batch
// file for `config set` must use container coordinates; the WSL automount root
// (/etc/wsl.conf) is configurable, not always /mnt; bind mounts nest, so translation must
// prefer the longest match or it silently lands in the wrong mount.
//
// Rule for the rest of the codebase: no string surgery on paths outside this module.

import { isAbsolute, relative, resolve } from "node:path";
import { DEFAULT_WSL_DISTRO } from "./env.ts";
import { UserError } from "./io/log.ts";

/** One bind mount, in the two coordinate systems it connects. */
export interface MountPoint {
  /** Path on the target, e.g. /srv/openclaw/data/workspace. */
  readonly target: string;
  /** Path inside the container, e.g. /home/node/.openclaw/workspace. */
  readonly container: string;
}

// The bind-mount map itself is application data: which host directory appears where inside
// the container is a property of the image being run, not of path translation. It arrives
// as a parameter.

/** What the bridge can answer. Implementations live alongside the transports. */
export interface PathBridge {
  /** A path on this machine, expressed in the target's coordinates. */
  toTarget(toolPath: string): Promise<string>;
  /** A path on the target, expressed in ours — for reading target files locally when the
   *  two share a filesystem. Rejects when no such mapping exists. */
  toTool(targetPath: string): Promise<string>;
  /** A path on the target, expressed inside the container. Rejects when the path is not
   *  under any bind mount, because passing it on would silently address the wrong file. */
  toContainer(targetPath: string): string;
  /** The inverse of toContainer. */
  fromContainer(containerPath: string): string;
}

/** Target is a remote host: our checkout and its copy live at different paths. */
export class SshPathBridge implements PathBridge {
  #mounts: MountPoint[];
  /** Slash-normalised, for prefix matching against either D:\dev\x or /mnt/d/dev/x. */
  #localRepo: string;
  /** As the caller wrote it, so the reverse translation gives paths back in the same
   *  shape rather than a mixed D:\dev\x/clawwright. */
  #localRepoOriginal: string;
  #localSeparator: string;
  #remoteRepo: string;

  constructor(options: { mounts: MountPoint[]; localRepo: string; remoteRepo: string }) {
    this.#mounts = options.mounts;
    this.#localRepoOriginal = options.localRepo.replace(/[\\/]+$/, "");
    this.#localRepo = this.#localRepoOriginal.replaceAll("\\", "/");
    this.#localSeparator = this.#localRepoOriginal.includes("\\") ? "\\" : "/";
    this.#remoteRepo = options.remoteRepo.replace(/\/+$/, "");
  }

  async toTarget(toolPath: string): Promise<string> {
    const candidate = toolPath.replaceAll("\\", "/");
    if (candidate === this.#localRepo) return this.#remoteRepo;
    if (candidate.startsWith(`${this.#localRepo}/`)) {
      return normalisePosix(`${this.#remoteRepo}/${candidate.slice(this.#localRepo.length + 1)}`);
    }
    // Absolute paths that are not part of the checkout already refer to the server.
    if (candidate.startsWith("/")) return normalisePosix(candidate);
    throw new Error(`cannot express ${toolPath} on the remote host — it is outside the checkout`);
  }

  async toTool(targetPath: string): Promise<string> {
    const normalised = normalisePosix(targetPath);
    if (normalised === this.#remoteRepo) return this.#localRepoOriginal;
    if (normalised.startsWith(`${this.#remoteRepo}/`)) {
      const suffix = normalised.slice(this.#remoteRepo.length + 1).replaceAll("/", this.#localSeparator);
      return `${this.#localRepoOriginal}${this.#localSeparator}${suffix}`;
    }
    // Everything else exists only on the server; there is no local path for it.
    throw new Error(`${targetPath} exists only on the remote host — it has no local path`);
  }

  toContainer(targetPath: string): string {
    return toContainerPath(targetPath, this.#mounts);
  }

  fromContainer(containerPath: string): string {
    return fromContainerPath(containerPath, this.#mounts);
  }
}

/** A scoped target shares mount coordinates, never the operator's filesystem or checkout. */
export class ScopedPathBridge implements PathBridge {
  readonly #mounts: MountPoint[];

  /** Copy application-owned mounts without inventing an operator/target path mapping. */
  constructor(mounts: MountPoint[]) {
    this.#mounts = mounts.map((mount) => ({ ...mount }));
  }

  /** Operator files must be explicitly staged through the transport. */
  async toTarget(_toolPath: string): Promise<never> {
    throw new UserError("SSJACK_PATH_MAPPING_UNSUPPORTED");
  }

  /** A target path is not an operator-side readable file. */
  async toTool(_targetPath: string): Promise<never> {
    throw new UserError("SSJACK_PATH_MAPPING_UNSUPPORTED");
  }

  /** Translate only the application-declared target/container mount relationship. */
  toContainer(targetPath: string): string {
    return toContainerPath(targetPath, this.#mounts);
  }

  /** Recover target coordinates from an application-declared container mount. */
  fromContainer(containerPath: string): string {
    return fromContainerPath(containerPath, this.#mounts);
  }
}

/** Builds the bridge for a transport. The automount root is read from the target rather
 *  than assumed, which is why this is async. */
export async function createPathBridge(options: {
  readFile: (path: string) => Promise<string>;
  mounts: MountPoint[];
  kind: "local" | "wsl" | "ssh" | "scoped";
  distro?: string;
  localRepo?: string;
  remoteRepo?: string;
}): Promise<PathBridge> {
  if (options.kind === "scoped") return new ScopedPathBridge(options.mounts);
  if (options.kind === "local") return new LocalPathBridge(options.mounts);

  if (options.kind === "ssh") {
    return new SshPathBridge({
      mounts: options.mounts,
      localRepo: options.localRepo ?? "",
      remoteRepo: options.remoteRepo ?? "/opt/openclaw",
    });
  }

  const automountRoot = await readAutomountRoot(options.readFile);
  return new WslPathBridge({
    mounts: options.mounts,
    distro: options.distro ?? DEFAULT_WSL_DISTRO,
    automountRoot,
    onWindows: process.platform === "win32",
  });
}

/** Normalises a POSIX path: collapses duplicate slashes, resolves . and .., drops the
 *  trailing slash. Deliberately string-only — the path belongs to another machine, so
 *  node:path (which follows this platform's rules) must not be used. */
export function normalisePosix(path: string): string {
  const isAbsolute = path.startsWith("/");
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!isAbsolute) parts.push("..");
      continue;
    }
    parts.push(segment);
  }
  const joined = parts.join("/");
  if (isAbsolute) return `/${joined}`;
  return joined === "" ? "." : joined;
}

/** True when `child` is the same path as `parent` or sits underneath it. */
export function isUnder(child: string, parent: string): boolean {
  const c = normalisePosix(child);
  const p = normalisePosix(parent).replace(/\/+$/, "");
  return c === p || c.startsWith(`${p}/`);
}

/** Whether `dir` is `root` or inside it, as native tool paths. */
export function isWithin(root: string, dir: string): boolean {
  const within = relative(resolve(root), resolve(dir));
  return within === "" || (!within.startsWith("..") && !isAbsolute(within));
}

// --- target ↔ container -------------------------------------------------------

/** Translates a target path into container coordinates.
 *
 *  Mounts are sorted longest-first because they nest: /data/workspace lives inside the
 *  /data/config mount, and a shortest-match would quietly resolve it to the wrong file
 *  instead of failing. */
export function toContainerPath(targetPath: string, mounts: MountPoint[]): string {
  const path = normalisePosix(targetPath);
  const ordered = [...mounts].sort((a, b) => b.target.length - a.target.length);

  for (const mount of ordered) {
    if (isUnder(path, mount.target)) {
      const suffix = path.slice(normalisePosix(mount.target).length);
      return normalisePosix(`${mount.container}${suffix}`);
    }
  }

  throw new Error(
    `${targetPath} is not inside any bind mount — it has no path inside the container`,
  );
}

/** The inverse: a container path expressed on the target. */
export function fromContainerPath(containerPath: string, mounts: MountPoint[]): string {
  const path = normalisePosix(containerPath);
  const ordered = [...mounts].sort((a, b) => b.container.length - a.container.length);

  for (const mount of ordered) {
    if (isUnder(path, mount.container)) {
      const suffix = path.slice(normalisePosix(mount.container).length);
      return normalisePosix(`${mount.target}${suffix}`);
    }
  }

  throw new Error(
    `${containerPath} is not inside any bind mount — it exists only inside the container`,
  );
}

// --- tool ↔ target ------------------------------------------------------------

/** D:\dev\x, D:/dev/x → { drive: "d", rest: "dev/x" }. */
function splitWindowsPath(path: string): { drive: string; rest: string } | undefined {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  if (match === null) return undefined;
  return { drive: match[1].toLowerCase(), rest: match[2].replaceAll("\\", "/") };
}

/** /d/dev/x — the shape Git Bash reports. Only meaningful when this process runs on
 *  Windows: on Linux the very same string is a genuine POSIX path. */
function splitMsysPath(path: string): { drive: string; rest: string } | undefined {
  const match = /^\/([A-Za-z])\/(.*)$/.exec(path);
  if (match === null) return undefined;
  return { drive: match[1].toLowerCase(), rest: match[2] };
}

/** Reads the WSL automount root from /etc/wsl.conf. Configurable, so assuming /mnt would
 *  break silently for anyone who changed it. */
export async function readAutomountRoot(
  readFile: (path: string) => Promise<string>,
): Promise<string> {
  let content: string;
  try {
    content = await readFile("/etc/wsl.conf");
  } catch {
    return "/mnt";
  }

  let inAutomount = false;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.split("#")[0].trim();
    if (line === "") continue;
    if (line.startsWith("[")) {
      inAutomount = line.toLowerCase().startsWith("[automount]");
      continue;
    }
    if (!inAutomount) continue;
    const match = /^root\s*=\s*(.+)$/.exec(line);
    if (match !== null) {
      return match[1].trim().replace(/["']/g, "").replace(/\/+$/, "") || "/";
    }
  }
  return "/mnt";
}

/** Target and tooling share a filesystem: paths need no translation at all. */
export class LocalPathBridge implements PathBridge {
  #mounts: MountPoint[];

  constructor(mounts: MountPoint[]) {
    this.#mounts = mounts;
  }

  async toTarget(toolPath: string): Promise<string> {
    return normalisePosix(toolPath);
  }

  async toTool(targetPath: string): Promise<string> {
    return normalisePosix(targetPath);
  }

  toContainer(targetPath: string): string {
    return toContainerPath(targetPath, this.#mounts);
  }

  fromContainer(containerPath: string): string {
    return fromContainerPath(containerPath, this.#mounts);
  }
}

/** The tooling runs on Windows or in WSL; the target is a WSL distribution. */
export class WslPathBridge implements PathBridge {
  #mounts: MountPoint[];
  #distro: string;
  #automountRoot: string;
  /** True when this process is the Windows Node; on Linux, paths are already native. */
  #onWindows: boolean;

  constructor(options: {
    mounts: MountPoint[];
    distro: string;
    automountRoot: string;
    onWindows: boolean;
  }) {
    this.#mounts = options.mounts;
    this.#distro = options.distro;
    this.#automountRoot = options.automountRoot.replace(/\/+$/, "") || "";
    this.#onWindows = options.onWindows;
  }

  async toTarget(toolPath: string): Promise<string> {
    const windows = splitWindowsPath(toolPath);
    if (windows !== undefined) {
      return normalisePosix(`${this.#automountRoot}/${windows.drive}/${windows.rest}`);
    }

    // Git Bash reports /d/dev/x. Indistinguishable from a POSIX path by shape alone —
    // only the platform tells us which it is.
    if (this.#onWindows) {
      const msys = splitMsysPath(toolPath);
      if (msys !== undefined) {
        return normalisePosix(`${this.#automountRoot}/${msys.drive}/${msys.rest}`);
      }
    }

    if (toolPath.startsWith("/")) return normalisePosix(toolPath);

    throw new Error(
      `cannot express ${toolPath} in target coordinates — expected an absolute path such as D:\\dev\\x`,
    );
  }

  async toTool(targetPath: string): Promise<string> {
    const normalised = normalisePosix(targetPath);
    if (!this.#onWindows) return normalised;

    // Under the automount root the file is a real Windows path.
    const automount = this.#automountRoot === "" ? "/" : `${this.#automountRoot}/`;
    if (normalised.startsWith(automount)) {
      const rest = normalised.slice(automount.length);
      const slash = rest.indexOf("/");
      const drive = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase();
      if (/^[a-z]$/.test(drive)) {
        const tail = slash === -1 ? "" : rest.slice(slash + 1);
        return `${drive.toUpperCase()}:\\${tail.replaceAll("/", "\\")}`;
      }
    }

    // Everything else lives in the distribution's own filesystem, reachable over UNC.
    return `\\\\wsl.localhost\\${this.#distro}\\${normalised.replace(/^\//, "").replaceAll("/", "\\")}`;
  }

  toContainer(targetPath: string): string {
    return toContainerPath(targetPath, this.#mounts);
  }

  fromContainer(containerPath: string): string {
    return fromContainerPath(containerPath, this.#mounts);
  }
}

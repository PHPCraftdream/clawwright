// Table-driven checks for the path bridge.
//
// This module is where a mistake is silent: a wrong translation still yields a valid-
// looking path, the bind mount points somewhere else, and the failure surfaces much later
// as "the file is empty". So every case is asserted, including the ones that must fail.
//
// Runs without a live instance:  node tools/checks/paths.check.ts

import {
  LocalPathBridge,
  SshPathBridge,
  WslPathBridge,
  fromContainerPath,
  isUnder,
  normalisePosix,
  readAutomountRoot,
  toContainerPath,
} from "#framework/core/paths.ts";
import { mountPoints } from "#framework/runtime/mounts.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

const DATA = "/srv/openclaw/data";
const MOUNTS = mountPoints(DATA);

async function checkThrows(name: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
    checkTrue(name, false);
  } catch {
    checkTrue(name, true);
  }
}

// --- normalisation ------------------------------------------------------------

check("normalise: duplicate slashes", normalisePosix("/srv//openclaw///data"), "/srv/openclaw/data");
check("normalise: trailing slash", normalisePosix("/srv/openclaw/data/"), "/srv/openclaw/data");
check("normalise: dot segments", normalisePosix("/srv/openclaw/./data/../data"), "/srv/openclaw/data");
check("normalise: root stays root", normalisePosix("/"), "/");
check("isUnder: nested", isUnder(`${DATA}/workspace/SOUL.md`, `${DATA}/workspace`), true);
check("isUnder: sibling prefix is not nested", isUnder(`${DATA}/workspace-extra`, `${DATA}/workspace`), false);

// --- target ↔ container -------------------------------------------------------

check("container: config", toContainerPath(`${DATA}/config/openclaw.json`, MOUNTS), "/home/node/.openclaw/openclaw.json");
check("container: auth-secrets", toContainerPath(`${DATA}/auth-secrets/key`, MOUNTS), "/home/node/.config/openclaw/key");
// The workspace mount is nested inside the config mount; longest match must win.
check("container: nested workspace wins", toContainerPath(`${DATA}/workspace/SOUL.md`, MOUNTS), "/home/node/.openclaw/workspace/SOUL.md");
check("container: mount root itself", toContainerPath(`${DATA}/config`, MOUNTS), "/home/node/.openclaw");
check("container: trailing slash tolerated", toContainerPath(`${DATA}/config/`, MOUNTS), "/home/node/.openclaw");
// The mount map is built by the application; a trailing slash in the data directory must
// not leak into the mount targets.
check("mounts: dataDir with trailing slash", toContainerPath(`${DATA}/config/x`, mountPoints(`${DATA}/`)), "/home/node/.openclaw/x");

check("from container: state", fromContainerPath("/home/node/.openclaw/openclaw.json", MOUNTS), `${DATA}/config/openclaw.json`);
check("from container: nested workspace wins", fromContainerPath("/home/node/.openclaw/workspace/SOUL.md", MOUNTS), `${DATA}/workspace/SOUL.md`);
check("from container: auth", fromContainerPath("/home/node/.config/openclaw/key", MOUNTS), `${DATA}/auth-secrets/key`);

// Round trip must be lossless for every mount.
for (const relative of ["config/openclaw.json", "workspace/SOUL.md", "auth-secrets/key"]) {
  const target = `${DATA}/${relative}`;
  check(`round trip: ${relative}`, fromContainerPath(toContainerPath(target, MOUNTS), MOUNTS), target);
}

await checkThrows("container: path outside every mount rejects", () => toContainerPath("/etc/passwd", MOUNTS));
await checkThrows("container: data root itself rejects", () => toContainerPath(DATA, MOUNTS));
await checkThrows("from container: container-only path rejects", () => fromContainerPath("/usr/bin/node", MOUNTS));

// --- tool ↔ target (WSL, tooling on Windows) -----------------------------------

const wsl = new WslPathBridge({ mounts: MOUNTS, distro: "Ubuntu-24.04", automountRoot: "/mnt", onWindows: true });

check("wsl: windows path", await wsl.toTarget("D:\\work\\fixture\\clawwright"), "/mnt/d/work/fixture/clawwright");
check("wsl: windows path, forward slashes", await wsl.toTarget("D:/work/fixture/clawwright"), "/mnt/d/work/fixture/clawwright");
check("wsl: lowercase drive", await wsl.toTarget("d:\\dev\\x"), "/mnt/d/dev/x");
check("wsl: spaces survive", await wsl.toTarget("C:\\Program Files\\nodejs"), "/mnt/c/Program Files/nodejs");
// Git Bash reports this shape; on Windows it is a drive path, not a POSIX one.
check("wsl: msys form", await wsl.toTarget("/d/work/fixture/clawwright"), "/mnt/d/work/fixture/clawwright");
check("wsl: already POSIX passes through", await wsl.toTarget("/srv/openclaw/data"), "/srv/openclaw/data");
check("wsl: back to windows path", await wsl.toTool("/mnt/d/work/fixture/x"), "D:\\work\\fixture\\x");
check("wsl: distro-only path becomes UNC", await wsl.toTool("/srv/openclaw/data"), "\\\\wsl.localhost\\Ubuntu-24.04\\srv\\openclaw\\data");
await checkThrows("wsl: relative path rejects", () => wsl.toTarget("tools/clawwright.ts"));

// A non-default automount root must be honoured rather than assumed to be /mnt.
const wslCustom = new WslPathBridge({ mounts: MOUNTS, distro: "Ubuntu-24.04", automountRoot: "/windows", onWindows: true });
check("wsl: custom automount root", await wslCustom.toTarget("D:\\dev\\x"), "/windows/d/dev/x");
check("wsl: custom automount root, reverse", await wslCustom.toTool("/windows/d/dev/x"), "D:\\dev\\x");

// Running inside WSL: /d/dev/x is a real POSIX path and must not be mangled.
const wslNative = new WslPathBridge({ mounts: MOUNTS, distro: "Ubuntu-24.04", automountRoot: "/mnt", onWindows: false });
check("wsl (native): posix path untouched", await wslNative.toTarget("/d/dev/x"), "/d/dev/x");

// --- tool ↔ target (ssh) --------------------------------------------------------

const ssh = new SshPathBridge({
  mounts: MOUNTS,
  localRepo: "D:\\work\\fixture\\clawwright",
  remoteRepo: "/opt/openclaw",
});

check("ssh: checkout root", await ssh.toTarget("D:\\work\\fixture\\clawwright"), "/opt/openclaw");
check("ssh: file in the checkout", await ssh.toTarget("D:\\work\\fixture\\clawwright\\docker-compose.yml"), "/opt/openclaw/docker-compose.yml");
check("ssh: forward slashes", await ssh.toTarget("D:/work/fixture/clawwright/config/x.json"), "/opt/openclaw/config/x.json");
// Absolute paths outside the checkout already refer to the server.
check("ssh: server path passes through", await ssh.toTarget("/srv/openclaw/data"), "/srv/openclaw/data");
check("ssh: back to the local checkout", await ssh.toTool("/opt/openclaw/clawwright"), "D:\\work\\fixture\\clawwright\\clawwright");
check("ssh: reverse keeps posix form when the checkout is posix", await new SshPathBridge({ mounts: MOUNTS, localRepo: "/mnt/d/dev/x", remoteRepo: "/opt/openclaw" }).toTool("/opt/openclaw/clawwright"), "/mnt/d/dev/x/clawwright");
await checkThrows("ssh: relative path rejects", () => ssh.toTarget("tools/clawwright.ts"));
// A server-only path has no local equivalent — better an error than a plausible-looking lie.
await checkThrows("ssh: server-only path has no local form", () => ssh.toTool("/srv/openclaw/data"));

// --- tool ↔ target (local) ------------------------------------------------------

const local = new LocalPathBridge(MOUNTS);
check("local: identity", await local.toTarget("/srv/openclaw/data"), "/srv/openclaw/data");
check("local: normalises", await local.toTarget("/srv//openclaw/data/"), "/srv/openclaw/data");

// --- automount parsing ----------------------------------------------------------

check("automount: default when file missing", await readAutomountRoot(async () => { throw new Error("no file"); }), "/mnt");
check("automount: default when unset", await readAutomountRoot(async () => "[boot]\nsystemd = true\n"), "/mnt");
check("automount: custom root", await readAutomountRoot(async () => "[automount]\nroot = /windows/\n"), "/windows");
check("automount: ignores other sections", await readAutomountRoot(async () => "[network]\nroot = /nope\n[automount]\nroot = /w\n"), "/w");
check("automount: comment stripped", await readAutomountRoot(async () => "[automount]\nroot = /w # inline\n"), "/w");

finish("path");

import { array, json, object, execResult, type StackIO } from "./io.ts";
import { volumeNames, verifyWriters } from "./migration-plan.ts";
import type { MigrationPrepared, Storage } from "./migration-plan.ts";

/** Structural slice the storage-backup helpers need; migration's full prepared context
 *  satisfies it, and so does the retire-legacy executor. */
export type BackupContext = Pick<MigrationPrepared, "helperImage"> & { plan: Pick<MigrationPrepared["plan"], "backupRoot"> };

// GNU tar compare checks bytes, ownership, modes, links and timestamps against cold data.
// ACLs/xattrs are refused below rather than claiming tar's compare proves those metadata.
const capability = `set -eu
command -v sh; command -v find; command -v stat; command -v sha256sum; command -v getfacl; command -v getfattr; command -v sort; command -v wc; command -v awk
 test -r /proc/self/mountinfo
version=$(tar --version)
case "$version" in *"GNU tar"*) ;; *) exit 1;; esac
test "$(id -u)" = 0
`;
const supportedTree = `
test -d /data && test ! -L /data
awk '$5 ~ /^\\/data\\// { bad=1 } END { exit bad }' /proc/self/mountinfo
# Device nodes, sockets, FIFOs, nested filesystems, ACLs and xattrs are not supported.
special=$(find /data -xdev ! -type d ! -type f ! -type l -print -quit)
test -z "$special"
devices=$(find /data -type d -exec stat -c %d {} +)
root_device=$(stat -c %d /data)
for device in $devices; do test "$device" = "$root_device"; done
attributes=$(getfattr -R -d -m - /data)
test -z "$attributes"
acls=$(getfacl -R -c -s /data)
test -z "$acls"
`;
export async function verifyTopology(io: StackIO, storage: Storage, capture = false): Promise<void> {
  if (storage.type !== "bind") return;
  // Target host and daemon must expose the same canonical filesystem. Record inode,
  // device and full mount table; even same-device bind mount changes invalidate it.
  const result = execResult(await io.transport.exec("sh", ["-c", `set -eu
command -v realpath >/dev/null; command -v awk >/dev/null; command -v sha256sum >/dev/null
test "$(realpath -e -- "$1")" = "$1"
test -d "$1"; test ! -L "$1"
awk -v root="$1" '$5 == root || index($5, root "/") == 1 { bad=1 } END { exit bad }' /proc/self/mountinfo
stat -c '%d:%i' -- "$1"
sha256sum /proc/self/mountinfo`, "recipe-topology", storage.source], { allowFailure: true, stream: false, timeoutMs: 10_000 }));
  if (result.code !== 0 || result.timedOut || !/^\d+:\d+\n[a-f0-9]{64}  \/proc\/self\/mountinfo\n?$/.test(result.stdout))
    throw new Error("recipe migration canonical bind topology unavailable or unsupported");
  if (capture) storage.topology = result.stdout;
  else if (!storage.topology || storage.topology !== result.stdout) throw new Error("recipe migration bind filesystem identity or topology changed");
}
export async function checkHelper(io: StackIO, prepared: Pick<MigrationPrepared, "helperImage" | "storage">): Promise<void> {
  try {
    await io.run(["run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--user", "0:0",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--entrypoint", "/bin/sh", prepared.helperImage, "-c", capability]);
  } catch {
    throw new Error("recipe migration checkHelper tool capability unavailable or unknown for selected local image; no automatic image fallback, build or pull");
  }
  for (const storage of prepared.storage) {
    await verifyTopology(io, storage, true);
    await helper(io, prepared, storage, true, supportedTree, false);
  }
}
function mount(storage: Storage, source: string, readonly: boolean, destination = "/data"): string {
  if (Array.from(source).some((char) => char === "," || [0, 10, 13].includes(char.charCodeAt(0)))) throw new Error("recipe migration mount path cannot be represented safely");
  return `type=${storage.type},${storage.type === "volume" ? "volume-nocopy," : ""}src=${source},dst=${destination}${readonly ? ",readonly" : ""}`;
}
async function helper(io: StackIO, p: BackupContext | { helperImage: string }, storage: Storage, readonly: boolean, script: string,
  backup = true, target = false): Promise<void> {
  const filesystem = storage.type === "bind" ? storage.topology?.split("\n")[0] : undefined;
  if (storage.type === "bind" && (!filesystem || !/^\d+:\d+$/.test(filesystem))) throw new Error("recipe migration bind filesystem proof missing");
  const identityCheck = filesystem ? `test "$(stat -c '%d:%i' /data)" = '${filesystem}'\n` : "";
  await io.run(["run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--user", "0:0",
    "--security-opt", "no-new-privileges", "--mount", mount(storage, target ? storage.target : storage.source, readonly),
    ...(backup && "plan" in p ? ["--mount", `type=bind,src=${p.plan.backupRoot},dst=/backup`] : []),
    "--entrypoint", "/bin/sh", p.helperImage, "-c", `set -eu\n${identityCheck}${script}`, "sh", storage.key]);
}
// Backup parents are operator-owned and verified by migration-plan; helper-created
// artifacts are always UID/GID 0 (the explicit helper user), never operator-owned.
const privateArtifacts = `
test -d /backup && test ! -L /backup
test "$(stat -c %a /backup)" = 700
for suffix in tar sha256; do
  file="/backup/$1.$suffix"
  test -f "$file" && test ! -L "$file"
  test "$(stat -c '%a:%u:%g:%h' -- "$file")" = '600:0:0:1'
done
`;
const checksum = `${privateArtifacts}
cd /backup
expected=$(sha256sum "$1.tar")
test "$(cat "$1.sha256")" = "$expected"
sha256sum -c --status "$1.sha256"
`;
// Narrow script boundary for Linux temporary-filesystem regressions. No executor.
export function storageHelperScript(operation: "backup" | "transfer" | "restore"): string {
  const body = operation === "backup" ? `${supportedTree}
test -d /backup && test ! -L /backup
test "$(stat -c %a /backup)" = 700
umask 077
set -C
# O_EXCL redirections close existence-check races, including dangling symlinks.
exec 3>"/backup/$1.tar"
exec 4>"/backup/$1.sha256"
${privateArtifacts}
tar --format=posix --numeric-owner --sparse -cpf /proc/self/fd/3 -C /data .
${privateArtifacts}
tar --numeric-owner --compare -f "/backup/$1.tar" -C /data
cd /backup
sha256sum "$1.tar" >&4
${checksum}` : `${operation === "restore" ? supportedTree : 'test -z "$(find /data -mindepth 1 -print -quit)"'}
${checksum}
${operation === "restore" ? 'tar -tf "$1.tar" >/dev/null\nfind /data -mindepth 1 -xdev -delete' : ""}
${privateArtifacts}
tar --numeric-owner --same-owner --same-permissions -xpf "$1.tar" -C /data
${privateArtifacts}
tar --numeric-owner --compare -f "$1.tar" -C /data`;
  // Never expose tar filenames, checksum contents or raw helper diagnostics.
  return `set -eu\n(\n${body}\n) >/dev/null 2>&1`;
}
export async function backupStorage(io: StackIO, p: BackupContext, storage: Storage): Promise<void> {
  await verifyTopology(io, storage);
  await helper(io, p, storage, true, storageHelperScript("backup"));
}
export async function transferStorage(io: StackIO, p: MigrationPrepared, storage: Storage): Promise<void> {
  if (storage.type === "bind") return; // Bind identity remains unchanged; verified backup is mandatory.
  // Creation is explicit and preceded by absence revalidation under the caller's lock.
  const existing = volumeNames((await io.run(["volume", "ls", "--format", "{{.Name}}"])).stdout);
  if (existing.includes(storage.target)) throw new Error("recipe migration fresh destination collided");
  await io.run(["volume", "create", "--driver", "local", "--label", `com.docker.compose.project=${io.project}`,
    "--label", `io.clawwright.recipe.migration=${p.plan.token}`,
    "--label", `com.docker.compose.volume=${storage.target.slice(io.project.length + 1)}`, storage.target]);
  await verifyTargetVolume(io, p, storage);
  await verifyWriters(io, p.storage, p.containers.map((c) => c.id));
  await helper(io, p, storage, false, storageHelperScript("transfer"), true, true);
}
export async function verifyTargetVolume(io: StackIO, p: MigrationPrepared, storage: Storage): Promise<void> {
  if (storage.type !== "volume") return;
  const values = array(json((await io.run(["volume", "inspect", storage.target])).stdout));
  if (values.length !== 1) throw new Error("recipe migration target volume identity unknown");
  const v = object(values[0]);
  const labels = object(v["Labels"]);
  if (v["Name"] !== storage.target || v["Driver"] !== "local" || Object.keys(object(v["Options"] ?? {})).length
    || labels["io.clawwright.recipe.migration"] !== p.plan.token || labels["com.docker.compose.project"] !== io.project
    || labels["com.docker.compose.volume"] !== storage.target.slice(io.project.length + 1))
    throw new Error("recipe migration target volume transaction ownership unproven");
}
export async function restoreBind(io: StackIO, p: MigrationPrepared, storage: Storage): Promise<void> {
  if (storage.type !== "bind") throw new Error("recipe migration restore requires a verified bind");
  await verifyTopology(io, storage);
  await helper(io, p, storage, false, storageHelperScript("restore"));
}

// Pure command construction for check-linux.ts — every piece here is a plain function over
// strings/arrays, assertable without a Docker daemon (see
// tools/checks/foundation/hygiene/check-linux.check.ts). Nothing here touches fs, spawns a
// process, or reads an OS-specific path separator: the container side is always POSIX and the
// host side never appears in these argv, only in check-linux.ts's own docker cp call.

/** Where the clean snapshot lands and checks run from. Never pre-created via `-w`: `docker
 *  cp` to a nonexistent destination creates it AS the copy, sidestepping the
 *  trailing-`/.`-vs-`\.` split between POSIX and Windows Docker CLIs entirely. */
export const CONTAINER_WORKDIR = "/repo";

const IMAGE = "node:24";

/** Single-quotes a POSIX shell word, escaping embedded single quotes the standard way
 *  ('\''). Every check filter crosses into the container through `sh -c`, so this is the one
 *  place a filter argument's quoting has to be exactly right. */
export function shellQuoteSingle(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The snapshot is committed as a fresh repo: the privacy checks vet tracked-and-clean files
 *  (e.g. .env.example) through git, and the copy carries no .git of the host. */
export const SNAPSHOT_REPO = "git init -q && git add -A && git -c user.name=snapshot -c user.email=snapshot@localhost commit -qm snapshot";

/** Runs as unprivileged `node`: install, the (optionally filtered) check suite, then
 *  typecheck/lint — same steps ci.yml's ubuntu "checks" job runs. Build and pack:check are
 *  not mirrored: they exercise dist packaging, not this tool's Linux-wording class of failure. */
export function buildUserScript(filters: readonly string[]): string {
  const checkArgs = filters.length === 0 ? "" : ` -- ${filters.map(shellQuoteSingle).join(" ")}`;
  return `cd ${CONTAINER_WORKDIR} && ${SNAPSHOT_REPO} && npm ci && npm run check${checkArgs} && npm run format:check`;
}

/** The container command. Root would make permission checks (read-only directories) vacuous,
 *  which the CI runner's non-root user does not: `docker cp` leaves the copy root-owned, so it
 *  is handed to `node` before the steps run as that user. */
export function buildInnerScript(filters: readonly string[]): string {
  return `chown -R node:node ${CONTAINER_WORKDIR} && exec runuser -u node -- env HOME=/home/node sh -c ${shellQuoteSingle(buildUserScript(filters))}`;
}

/** `--rm` mirrors `docker run --rm`'s auto-cleanup; staging the snapshot with `docker cp`
 *  before start (see check-linux.ts) is why this is `create` rather than a single `run`. */
export function buildCreateArgv(containerName: string, filters: readonly string[]): string[] {
  return ["create", "--rm", "--name", containerName, "-e", "CI=true", IMAGE, "sh", "-c", buildInnerScript(filters)];
}

/** `hostDir`'s CONTENTS become CONTAINER_WORKDIR — true because CONTAINER_WORKDIR does not
 *  already exist in a container created without `-w` (see its own doc comment above), not
 *  because of any trailing-dot path convention. */
export function buildCopyArgv(hostDir: string, containerName: string): string[] {
  return ["cp", hostDir, `${containerName}:${CONTAINER_WORKDIR}`];
}

/** Attached start: streams the container's stdout/stderr live and, like `docker run`, exits
 *  with the container's own exit code. */
export function buildStartArgv(containerName: string): string[] {
  return ["start", "-a", containerName];
}

/** Best-effort cleanup fallback for when `--rm` never got the chance to fire (docker create
 *  or docker cp itself failed, before the container ever started) — see check-linux.ts's
 *  finally block, which ignores this failing when `--rm` already did its job. */
export function buildRemoveArgv(containerName: string): string[] {
  return ["rm", "-f", containerName];
}

/** node_modules and packages/clawwright/dist must be built fresh in the container, not
 *  inherited from the dev machine — mirrors .gitignore, a defense-in-depth filter atop
 *  `git ls-files -co --exclude-standard`, which should already exclude both. */
export function isHostArtifactPath(relPath: string): boolean {
  return relPath.split("/").includes("node_modules")
    || relPath === "packages/clawwright/dist" || relPath.startsWith("packages/clawwright/dist/")
    || relPath === "tools/framework/dist" || relPath.startsWith("tools/framework/dist/");
}

/** Cleans up `git ls-files -co --exclude-standard`'s raw stdout: drops blank lines (a
 *  trailing newline splits into one) and any host-artifact path that should never have
 *  reached here in the first place. */
export function filterCleanFileList(rawLines: readonly string[]): string[] {
  return rawLines.map((line) => line.trim()).filter((line) => line !== "" && !isHostArtifactPath(line));
}

// Proves a set carries no secret VALUE before it is written — the manifest's shape has no
// field for one, but a value could still arrive smuggled inside free text (an acceptance
// check, an agent id, a file path). Called from set-manifest.ts (collectManifest, writeArtifact).

import { readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { resolve } from "node:path";
import { die } from "#src/core/io/log.ts";
import { parseEnv, readEnvFileText } from "#src/core/env.ts";
import { envFile, secretsDir } from "#src/runtime/deployment.ts";
import { canonicalJson } from "#src/set/artifacts/model.ts";
import type { SetManifest } from "#src/set/artifacts/model.ts";

/** Every string anywhere in a value, however deep — what the value scan walks. */
function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(stringsOf);
  return [];
}

// The same floor as log.ts's registerSecret: scanning for anything shorter than eight
// characters matches too much to mean anything — a two-letter "secret" sits inside some
// checksum's hex by chance, and the refusal would fire on every build.
export const MIN_VALUE_LENGTH = 8;
const PUBLIC_ENV_SETTINGS = new Set([
  "OPENCLAW_IMAGE", "OPENCLAW_GATEWAY_PORT", "OPENCLAW_TZ", "OPENCLAW_DISABLE_BONJOUR",
  "OC_DATA_DIR", "OC_BACKUP_DIR", "OC_SNAPSHOT_DIR", "OC_BIND_ADDRESS", "OC_BACKUP_KEEP",
  "OC_SNAPSHOT_KEEP", "OC_TARGET_LOCATION", "OC_WSL_DISTRO", "OC_SSH_HOST", "OC_REMOTE_PATH",
  "OC_APP", "COMPOSE_PROJECT_NAME",
]);

/** Refuses to let a secret VALUE through into a manifest.
 *
 *  buildSetManifest's shape has no field for a value, but one could still arrive smuggled
 *  in free text (acceptance check, agent id, file path). So the build proves the negative
 *  before writing anything: every value kept locally (.env, secrets/ stores) is searched
 *  for in the manifest. Exported so a check can feed it a doctored manifest and prove the
 *  scan actually fires. */
export function assertNoSecretValues(manifest: SetManifest, values: { name: string; value: string }[]): void {
  const canonical = canonicalJson(manifest);
  const strings = stringsOf(manifest);
  for (const { name, value } of values) {
    if (value.length < MIN_VALUE_LENGTH) continue;
    if (!canonical.includes(value) && !strings.some((text) => text.includes(value))) continue;
    // The variable is named, never its value: this message goes to logs and transcripts.
    die(
      `refusing to write the set: the manifest carries the value of ${name} — ` +
        "a secret has leaked into recipe content, acceptance checks or agent declarations",
    );
  }
}

/** The values the scan searches for, and the only thing .env/secret stores are read for —
 *  input to a refusal check, never to the manifest. */
export async function localSecretValues(): Promise<{ name: string; value: string }[]> {
  const found: { name: string; value: string }[] = [];
  const collect = (source: string, env: Record<string, string>): void => {
    for (const [key, value] of Object.entries(env)) {
      if (source === ".env" && PUBLIC_ENV_SETTINGS.has(key)) continue;
      if (value !== "") found.push({ name: `${key} (${source})`, value });
    }
  };
  const env = await readSecretSource(envFile(), readEnvFileText);
  if (env !== undefined) collect(".env", env);
  let entries: Dirent[];
  try {
    entries = await readdir(secretsDir(), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") entries = [];
    else {
      die(
        `cannot list ${secretsDir()} for the secret-value scan: ${(error as Error).message} — ` +
          "the scan would run without the values kept in the stores there",
      );
    }
  }
  for (const entry of entries) {
    if (!entry.name.endsWith(".env")) continue;
    // A store that is not a regular file cannot be read, and skipping it would shrink the
    // scan in exactly the way this guard exists to make impossible: stop and name it.
    if (!entry.isFile()) {
      die(
        `cannot read ${resolve(secretsDir(), entry.name)} for the secret-value scan: it is not a regular file — ` +
          "the scan would run without the values stored there",
      );
    }
    const store = await readSecretSource(resolve(secretsDir(), entry.name));
    if (store !== undefined) collect(`secrets/${entry.name}`, store);
  }
  return found;
}

/** Reads one secret source for the scan. Only a missing file is tolerable (pre-bootstrap
 *  has none yet); any other read error would silently shrink the scan, so it stops instead. */
async function readSecretSource(source: string, read: () => Promise<string> = () => readFile(source, "utf8")): Promise<Record<string, string> | undefined> {
  try {
    return parseEnv(await read(), source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    die(
      `cannot read ${source} for the secret-value scan: ${(error as Error).message} — ` +
        "the scan would run without the values stored there",
    );
  }
}

// The per-facet declared-vs-target comparisons `inspect` runs: the live
// openclaw.json against declared.ts's declaredState, the .env connection facts against the
// running container, and the local secret store against what the target holds. Split out of
// observe.ts; see helpers.ts (this same directory) for the pure pieces these use, and
// live.ts for what the target itself reports without a declared counterpart to compare.

import { readFile } from "node:fs/promises";
import { readIfExists, TargetReadUnknownError } from "#src/runtime/transport/transport.ts";
import JSON5 from "json5";
import { envFile, secretStoreFile } from "#src/runtime/deployment.ts";
import { parseEnv, readEnvFileText } from "#src/core/env.ts";
import { problem } from "#src/service/inspection.ts";
import type { Problem, DeclaredState, ConnectionFactObservation, SecretStoreObservation } from "#src/service/inspection.ts";
import type { SecretStatus } from "#src/service/secrets.ts";
import {
  CONNECTION_FACTS,
  staleConnectionFacts,
  unrecoverableConnectionFacts,
} from "#src/commands/operate/recover-env/facts.ts";
import type { ConnectionFacts } from "#src/commands/operate/recover-env/facts.ts";
import { DEFAULT_SECRET_STORE } from "#src/commands/management/configuration/secrets.ts";
import { readName } from "#src/core/values/names.ts";
import { readDeclaredConfig as readAppliedDeclarations } from "#src/set/ownership/declared-config.ts";
import { recipePathOwners, conflictingDeclaredPath } from "#src/set/ownership/recipe-paths.ts";
import type { RecipePathOwner } from "#src/set/ownership/recipe-paths.ts";
import { configPathParts, readConfigPath } from "#src/core/values/config/config-selectors.ts";
import { desiredConfig } from "#src/core/values/config/desired-config.ts";
import type { Context } from "#src/core/context.ts";

/** Parses GNU stat's fractional, timezone-qualified `%y` timestamp. */
function parseStatTimestamp(raw: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))? ([+-]\d{2}:?\d{2})$/.exec(raw.trim());
  if (match === null) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = "", zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const zoneDigits = zone.replace(":", "");
  const zoneHour = Number(zoneDigits.slice(1, 3));
  const zoneMinute = Number(zoneDigits.slice(3, 5));
  if (
    month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    hour > 23 || minute > 59 || second > 59 || zoneHour > 23 || zoneMinute > 59
  ) return undefined;

  const milliseconds = fraction.slice(0, 3).padEnd(3, "0");
  const parsed = Date.parse(`${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}.${milliseconds}${zone}`);
  if (Number.isNaN(parsed)) return undefined;
  // Runtime.startedAt() is in milliseconds; keep both sides at that resolution.
  return parsed;
}

/** The declared settings against their live values, and when the file was last written.
 *
 *  Deliberately outside the "is it running" branch: openclaw.json is readable whether or
 *  not anything is serving, and gating this on the gateway let `plan` emit just [up] and
 *  apply a config that was never actually compared. */
export async function observeConfig(
  ctx: Context,
  declared: DeclaredState,
  problems: Problem[],
): Promise<{ config: Record<string, unknown>; mtimeMs?: number }> {
  const config: Record<string, unknown> = {};
  const configFile = `${ctx.settings.dataDir}/config/openclaw.json`;
  let mtimeMs: number | undefined;

  // Recipe-owned paths are never the declaration's business, so their drift is skipped.
  // A broken catalog (bad recipe.json) must not take down the whole comparison: fail
  // visible as its own problem, then compare everything like before ownership existed.
  let owners: readonly RecipePathOwner[] | undefined;
  try {
    owners = await recipePathOwners();
  } catch (error) {
    if (error instanceof TargetReadUnknownError) throw error;
    problems.push(problem("SET_RECIPE_INVALID", `recipe config ownership could not be read: ${(error as Error).message}`));
  }

  const read = await readIfExists(ctx.transport, configFile);
  if (read.kind === "absent") return { config, mtimeMs };
  const raw = read.value;
  let parsed: unknown;
  try {
    // JSON5, not JSON: the live config is OpenClaw's JSON5 gateway format, where a comment
    // or trailing comma is legitimate.
    parsed = JSON5.parse(raw) as unknown;
  } catch {
    problems.push(problem("CONFIG_DRIFT", `${configFile} could not be read or compared`));
    return { config, mtimeMs };
  }
  try {
    for (const entry of declared.config) {
      const terminalSelector = configPathParts(entry.path).at(-1)?.kind === "selector";
      config[entry.path] = terminalSelector && Array.isArray(entry.value)
        ? readConfigPath(parsed, entry.path, "set")
        : readConfigPath(parsed, entry.path);
    }
    const previous = await readAppliedDeclarations(ctx);
    const desired = desiredConfig(parsed, declared.config, previous.entries);
    const conflicts = (owners ?? []).flatMap((owner) => {
      const paths = [...declared.config.map((entry) => entry.path), ...previous.entries.filter((entry) => !declared.config.some((current) => current.path === entry.path)).map((entry) => entry.path)];
      return paths.flatMap((path) => {
        const conflict = conflictingDeclaredPath([owner], path);
        return conflict === undefined ? [] : [path];
      });
    });
    if (conflicts.length > 0) {
      problems.push(problem("CONFIG_DRIFT", `configuration ownership conflict at ${[...new Set(conflicts)].join(", ")}`));
    } else if (desired.patch !== undefined) {
      problems.push(problem("CONFIG_DRIFT", `configuration differs at ${desired.affectedPaths.join(", ")}`));
    }
  } catch (error) {
    if (error instanceof TargetReadUnknownError) throw error;
    problems.push(problem("CONFIG_DRIFT", `${configFile} could not be read or compared`));
    return { config, mtimeMs };
  }
  const stamp = await ctx.transport.exec("stat", ["-c", "%y", configFile], { allowFailure: true });
  if (stamp.code === 0) mtimeMs = parseStatTimestamp(stamp.stdout);

  return { config, mtimeMs };
}

/** The deployment .env's connection facts against the running container — the same
 *  comparison recover-env reports on and --adopt-runtime resolves (staleConnectionFacts).
 *
 *  Findings name WHICH variable drifted, never a value: .env mixes a real secret
 *  (OPENCLAW_GATEWAY_TOKEN) with these facts, so nothing from that file is printable. */
export async function observeConnectionFacts(
  ctx: Context,
  problems: Problem[],
): Promise<ConnectionFactObservation[] | undefined> {
  // Optional on the runtime contract: a runtime that cannot introspect its container
  // skips this rather than being asked.
  if (typeof ctx.runtime.runningConnectionFacts !== "function") return undefined;
  const facts: ConnectionFacts | undefined = await ctx.runtime.runningConnectionFacts();
  // Not running, or uninspectable: a gap, not a verdict.
  if (facts === undefined) return undefined;
  let raw: string;
  try {
    raw = await readEnvFileText();
  } catch {
    // No .env — fresh-clone shape, not a finding.
    return undefined;
  }
  const current = parseEnv(raw, envFile());
  // From facts.ts, so inspect and recover-env can't disagree about what counts as stale.
  const stale = new Set(staleConnectionFacts(facts, current).map((entry) => entry.name));
  const unrecovered = new Set(unrecoverableConnectionFacts(facts).map((entry) => entry.name));
  const observations: ConnectionFactObservation[] = CONNECTION_FACTS.map((fact) => ({
    name: fact.name,
    state: unrecovered.has(fact.name) ? "unrecovered" : stale.has(fact.name) ? "stale" : "match",
  }));
  for (const name of stale) {
    problems.push(problem("ENV_STALE", `${name} in ${envFile()} differs from the running container`));
  }
  return observations;
}

/** The deployment's default local store against the values the target holds. Only checked
 *  when a store file exists — an absent store is how every healthy deployment starts, not
 *  evidence of loss. A store that exists missing a required name is unambiguous, so that's
 *  the finding; names the target itself lacks are SECRET_MISSING's business instead. */
export async function observeSecretStore(
  ctx: Context,
  secrets: readonly SecretStatus[],
  problems: Problem[],
): Promise<SecretStoreObservation | undefined> {
  const store = secretStoreFile(readName("store", DEFAULT_SECRET_STORE));
  let raw: string;
  try {
    raw = await readFile(store, "utf8");
  } catch {
    return undefined;
  }
  const values = parseEnv(raw, store);
  const missing = secrets.filter(
    (entry) => entry.required && entry.present && (values[entry.name] ?? "").trim() === "",
  );
  for (const entry of missing) {
    problems.push(problem("STORE_INCOMPLETE", storeIncompleteDetail(entry.name, entry.usedBy, store)));
  }
  return { file: store, missing: missing.map((entry) => entry.name) };
}

export function storeIncompleteDetail(name: string, usedBy: string, store: string): string {
  return `${name} (${usedBy}) is present on the target but has no value in ${store}`;
}

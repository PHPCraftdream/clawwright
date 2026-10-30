// What secrets this instance needs, where each is expected, and which are missing.
//
// Two things learned from inspecting a live instance, not the docs: (1) scanning
// openclaw.json for SecretRefs is not enough — the provider key is resolved by convention
// from the auth profile, not referenced there, so provider requirements are also inferred
// from configured ids. (2) the variables live in two places and confusing them breaks
// auth: repo-env is .env next to this checkout (compose-owned values); target-env is
// <data>/config/.env on the target, OpenClaw's own trusted environment (provider keys).

import JSON5 from "json5";
import type { Context } from "../core/context.ts";
import type { AppSecret } from "../core/app.ts";
import { parseEnv } from "../core/env.ts";
import { refuseUnenrolledSSJackReferences } from "../core/values/ssjack-secret-refs.ts";
import { sudoForRead } from "../runtime/files/datadir.ts";

/** Where a variable is expected to be defined. */
export type SecretLocation = "repo-env" | "target-env";

/** The template's note for a repo-env value, exported so checks assert the same text the
 *  product prints. */
export const REPO_ENV_COPY_NOTE = "already exists in the repository's own .env";

export interface SecretRequirement {
  /** Environment variable name. */
  readonly name: string;
  readonly location: SecretLocation;
  /** Human-readable origin, for example "gateway.auth.token" or "provider openai". */
  readonly usedBy: string;
  readonly required: boolean;
}

export interface SecretStatus extends SecretRequirement {
  readonly present: boolean;
}

/** Convert a provider id into its conventional credential variable. */
export function providerEnvironmentVariable(providerId: string): string | undefined {
  const normalized = providerId.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized === "" ? undefined : `${normalized}_API_KEY`;
}

/** Walks the config for {"source":"env","id":"VAR"} references. */
export function collectSecretRefs(config: unknown, path = ""): { name: string; usedBy: string }[] {
  const found: { name: string; usedBy: string }[] = [];

  if (Array.isArray(config)) {
    config.forEach((item, index) => found.push(...collectSecretRefs(item, `${path}[${index}]`)));
    return found;
  }

  if (config !== null && typeof config === "object") {
    const node = config as Record<string, unknown>;
    if (node.source === "env" && typeof node.id === "string") {
      found.push({ name: node.id, usedBy: path.replace(/^\./, "") || "(root)" });
    }
    for (const [key, value] of Object.entries(node)) {
      found.push(...collectSecretRefs(value, `${path}.${key}`));
    }
  }

  return found;
}

/** The provider id an auth.profiles entry names. Per OpenClaw's schema
 *  (zod-schema.root-shape.ts) the key is an arbitrary label; the id is the object's own
 *  .provider field, not the key split on ":". */
function profileProviderId(profile: unknown): string | undefined {
  if (profile === null || typeof profile !== "object" || Array.isArray(profile)) return undefined;
  const id = (profile as { provider?: unknown }).provider;
  return typeof id === "string" ? id : undefined;
}

/** Providers that are actually configured on this instance. */
export function collectConfiguredProviders(config: unknown): string[] {
  if (config === null || typeof config !== "object") return [];
  const node = config as {
    models?: { providers?: Record<string, unknown> };
    auth?: { profiles?: Record<string, unknown> };
  };

  const ids = new Set<string>();
  for (const id of Object.keys(node.models?.providers ?? {})) ids.add(id);
  for (const profile of Object.values(node.auth?.profiles ?? {})) {
    const id = profileProviderId(profile);
    if (id !== undefined) ids.add(id);
  }
  return [...ids];
}

/** Best-effort read of the live config for whether any model provider is configured — the
 *  likely cause behind a symptom as generic as "the agent did not answer". An unreadable
 *  config answers false rather than throwing, never replacing a caller's real failure. */
export async function noProviderConfigured(ctx: Context): Promise<boolean> {
  try {
    const config = JSON5.parse(await ctx.transport.readFile(`${ctx.settings.dataDir}/config/openclaw.json`)) as unknown;
    return collectConfiguredProviders(config).length === 0;
  } catch {
    return false;
  }
}

/** An explicit provider SecretRef wins over the conventional variable name. */
export function providerSecretVariable(config: unknown, providerId: string): string | undefined {
  if (config === null || typeof config !== "object") return undefined;
  const node = config as {
    models?: { providers?: Record<string, unknown> };
    auth?: { profiles?: Record<string, unknown> };
  };
  const providers = node.models?.providers;
  const provider = providers?.[providerId];
  if (provider !== null && typeof provider === "object" && !Array.isArray(provider)) {
    const ref = (provider as { apiKey?: unknown }).apiKey;
    if (ref !== null && typeof ref === "object" && !Array.isArray(ref) &&
        (ref as { source?: unknown }).source === "env" && typeof (ref as { id?: unknown }).id === "string") {
      return (ref as { id: string }).id;
    }
  }
  for (const value of Object.values(node.auth?.profiles ?? {})) {
    if (profileProviderId(value) !== providerId) continue;
    const ref = collectSecretRefs(value).find((entry) => entry.name !== "OPENCLAW_GATEWAY_TOKEN");
    if (ref !== undefined) return ref.name;
  }
  return undefined;
}

/** Whether this provider declared an auth mode needing no apiKey — OAuth, the AWS SDK's
 *  own credential chain, or a bearer token. Checked in both places OpenClaw records a mode:
 *  models.providers.<id>.auth ("api-key") and auth.profiles' own .mode ("api_key" —
 *  different spelling in the schema). A local subprocess service (localService)
 *  authenticates its own way, never through the conventional env-var guess. */
export function providerUsesNonApiKeyAuth(config: unknown, providerId: string): boolean {
  if (config === null || typeof config !== "object") return false;
  const node = config as {
    models?: { providers?: Record<string, unknown> };
    auth?: { profiles?: Record<string, unknown> };
  };

  const provider = node.models?.providers?.[providerId];
  if (provider !== null && typeof provider === "object" && !Array.isArray(provider)) {
    const mode = (provider as { auth?: unknown }).auth;
    if (mode === "oauth" || mode === "aws-sdk" || mode === "token") return true;
    if ((provider as { localService?: unknown }).localService !== undefined) return true;
  }

  for (const value of Object.values(node.auth?.profiles ?? {})) {
    if (profileProviderId(value) !== providerId) continue;
    const mode = (value as { mode?: unknown }).mode;
    if (mode === "oauth" || mode === "aws-sdk" || mode === "token") return true;
  }

  return false;
}

/** Whether apiKey is already an explicit non-env value — a plain string, or a
 *  file/exec/store SecretRef. Stops the conventional fallback from firing on top of an
 *  already-satisfied credential and inventing a phantom second requirement. */
export function providerApiKeyExplicit(config: unknown, providerId: string): boolean {
  if (config === null || typeof config !== "object") return false;
  const node = config as { models?: { providers?: Record<string, unknown> } };
  const provider = node.models?.providers?.[providerId];
  if (provider === null || typeof provider !== "object" || Array.isArray(provider)) return false;
  refuseUnenrolledSSJackReferences(provider);
  return "apiKey" in provider;
}

/** Whether this provider's baseUrl is loopback. OpenClaw's ModelProviderSchema makes
 *  apiKey/auth/localService all optional with no superRefine requiring credentials — a
 *  self-hosted local server with auth disabled (e.g. LM Studio) is a legitimate case
 *  OpenClaw trusts without a key, not a misconfigured remote provider missing one. */
export function providerIsLocalEndpoint(config: unknown, providerId: string): boolean {
  if (config === null || typeof config !== "object") return false;
  const node = config as { models?: { providers?: Record<string, unknown> } };
  const provider = node.models?.providers?.[providerId];
  if (provider === null || typeof provider !== "object" || Array.isArray(provider)) return false;
  const baseUrl = (provider as { baseUrl?: unknown }).baseUrl;
  if (typeof baseUrl !== "string") return false;
  try {
    const hostname = new URL(baseUrl).hostname;
    // Node normalizes a literal IPv6 host to the bracketed form ("[::1]"), not "::1" —
    // confirmed directly: new URL("http://[::1]:1234").hostname === "[::1]".
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

/** Secret names required by a configuration object — pure, no target involved. Exported so
 *  inspect's plan-relevant check can ask the same question of the DECLARED config merged
 *  over the live one: a SecretRef just added to desired-state.json is a real requirement
 *  before it has ever been applied. */
export function requirementsFromConfig(config: unknown): SecretRequirement[] {
  refuseUnenrolledSSJackReferences(config);
  const result: SecretRequirement[] = [];

  // Explicit references. The gateway token is supplied by compose from the repository
  // .env; anything else referenced this way is expected on the target.
  for (const ref of collectSecretRefs(config)) {
    result.push({
      name: ref.name,
      location: ref.name === "OPENCLAW_GATEWAY_TOKEN" ? "repo-env" : "target-env",
      usedBy: ref.usedBy,
      required: true,
    });
  }

  // Conventional provider keys no SecretRef points at — only for a provider that actually
  // needs one. OAuth/AWS-SDK/token/local-service auth without an apiKey, so guessing
  // <PROVIDER>_API_KEY there invents an unneeded requirement and blocks a correct instance.
  for (const provider of collectConfiguredProviders(config)) {
    if (providerUsesNonApiKeyAuth(config, provider)) continue;

    const envRef = providerSecretVariable(config, provider);
    if (envRef !== undefined) {
      if (!result.some((entry) => entry.name === envRef)) {
        result.push({ name: envRef, location: "target-env", usedBy: `provider ${provider}`, required: true });
      }
      continue;
    }

    // apiKey already explicit and non-env — satisfied on its own; the convention guess is
    // only for a provider that said nothing about credentials.
    if (providerApiKeyExplicit(config, provider)) continue;

    // Loopback baseUrl with nothing said about credentials is a self-hosted,
    // unauthenticated local server (e.g. LM Studio) — trusted by OpenClaw, not forgotten.
    if (providerIsLocalEndpoint(config, provider)) continue;

    const guessed = providerEnvironmentVariable(provider);
    if (guessed === undefined) continue;
    if (result.some((entry) => entry.name === guessed)) continue;
    result.push({ name: guessed, location: "target-env", usedBy: `provider ${provider}`, required: true });
  }

  return result;
}

/** Add application-owned requirements to framework requirements without weakening either. */
function withApplicationRequirements(
  base: SecretRequirement[],
  application: readonly AppSecret[],
): SecretRequirement[] {
  const result = [...base];
  for (const entry of application) {
    const required = entry.required !== false;
    const existing = result.find((candidate) => candidate.name === entry.name);
    if (existing !== undefined) {
      if (existing.location !== entry.location) {
        throw new Error(
          `application secret ${entry.name} conflicts with an existing ${existing.location} requirement`,
        );
      }
      if (required && !existing.required) {
        const index = result.indexOf(existing);
        result[index] = { ...existing, required: true };
      }
      continue;
    }
    result.push({
      name: entry.name,
      location: entry.location,
      usedBy: entry.usedBy,
      required,
    });
  }
  return result;
}

/** Validates requirements returned by the application's hook. */
async function applicationRequirements(ctx: Context): Promise<AppSecret[]> {
  if (ctx.applicationSecrets === undefined) return [];
  const entries = await ctx.applicationSecrets();
  if (!Array.isArray(entries)) throw new Error("application secrets must be an array");
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("application secret declarations must be objects");
    }
    if (typeof entry.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name)) {
      throw new Error(`application secret name must be a valid environment variable: ${String(entry.name)}`);
    }
    if (entry.location !== "repo-env" && entry.location !== "target-env") {
      throw new Error(`application secret ${entry.name} has an invalid location`);
    }
    if (typeof entry.usedBy !== "string" || entry.usedBy.trim() === "") {
      throw new Error(`application secret ${entry.name} needs usedBy`);
    }
    if (entry.required !== undefined && typeof entry.required !== "boolean") {
      throw new Error(`application secret ${entry.name} has an invalid required flag`);
    }
  }
  return entries;
}

/** Resolve requirements for a supplied configuration and this application's live hook. */
export async function requirementsForConfig(ctx: Context, config: unknown): Promise<SecretRequirement[]> {
  refuseUnenrolledSSJackReferences(config);
  const application = await applicationRequirements(ctx);
  return withApplicationRequirements(requirementsFromConfig(config), application);
}

/** Return secret names required by the target's LIVE configuration. */
export async function requirements(ctx: Context): Promise<SecretRequirement[]> {
  const configPath = `${ctx.settings.dataDir}/config/openclaw.json`;
  if (!(await ctx.transport.exists(configPath))) return requirementsForConfig(ctx, {});

  // JSON5, not JSON: OpenClaw's own gateway config format IS JSON5 — comments and trailing
  // commas are valid, and plain JSON.parse would abort this step (and the up/apply run it
  // is part of) before the gateway ever started.
  const config = JSON5.parse(await ctx.transport.readFile(configPath)) as unknown;
  return requirementsForConfig(ctx, config);
}

async function readTargetSecrets(ctx: Context, path: string): Promise<string> {
  try {
    return await ctx.transport.readFile(path);
  } catch (error) {
    // Readable yet unread: a real failure, not a permission to escalate past.
    const prefix = await sudoForRead(ctx, path);
    if (prefix.length === 0) throw error;
    const [head, ...rest] = [...prefix, "cat", path];
    return (await ctx.transport.exec(head, rest)).stdout;
  }
}

/** Requirements plus whether each is actually satisfied, for a caller-supplied list —
 *  resolves presence for requirements computed some other way than requirements(ctx)
 *  (inspect's prospective, declared-merged requirements). */
export async function statusForRequirements(ctx: Context, needed: SecretRequirement[]): Promise<SecretStatus[]> {
  const targetPath = `${ctx.settings.dataDir}/config/.env`;
  const targetEnv = (await ctx.transport.exists(targetPath))
    ? parseEnv(await readTargetSecrets(ctx, targetPath), targetPath)
    : {};

  return needed.map((entry) => {
    const value = entry.location === "repo-env" ? ctx.settings.env[entry.name] : targetEnv[entry.name];
    return { ...entry, present: value !== undefined && value.trim() !== "" };
  });
}

/** Requirements with presence resolved from repo and target environments. */
export async function status(ctx: Context): Promise<SecretStatus[]> {
  return statusForRequirements(ctx, await requirements(ctx));
}

/** Select required entries whose values are absent. */
export function missing(entries: SecretStatus[]): SecretStatus[] {
  return entries.filter((entry) => entry.required && !entry.present);
}

/** Renders a value-free environment template — safe to commit and ship alongside a snapshot. */
export function template(entries: SecretRequirement[]): string {
  const lines = [
    "# Secrets required by this OpenClaw instance.",
    "# Values are intentionally absent: fill them in on the target.",
    "#",
    "# repo-env    -> .env next to the repository (passed into the container by the runtime)",
    "# target-env  -> <data>/config/.env on the target (read by OpenClaw itself)",
    "",
  ];

  for (const location of ["repo-env", "target-env"] as SecretLocation[]) {
    const group = entries.filter((entry) => entry.location === location);
    if (group.length === 0) continue;
    lines.push(`# --- ${location} ---`);
    // A repo-env value is owned by the repository's own .env (compose/bootstrap wrote it
    // once) — inventing a fresh one here produces a value nothing running agrees with.
    if (location === "repo-env") {
      lines.push(`# a repo-env value usually ${REPO_ENV_COPY_NOTE} — copy it here, do not invent a new one`);
    }
    for (const entry of group) {
      lines.push(`# used by: ${entry.usedBy}`);
      lines.push(`${entry.name}=`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

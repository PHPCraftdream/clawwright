// Configure OpenClaw provider credentials without storing key values in JSON.

import JSON5 from "json5";
import { log, info } from "#src/core/io/log.ts";
import { commandLine } from "#src/core/io/invocation/render.ts";
import { emit } from "#src/core/io/output.ts";
import type { Context } from "#src/core/context.ts";
import { parseEnv } from "#src/core/env.ts";
import { secretsFileOnTarget } from "#src/runtime/files/datadir.ts";
import { collectConfiguredProviders, providerEnvironmentVariable, providerSecretVariable, providerApiKeyExplicit } from "#src/service/secrets.ts";
import { guardedWith, type LockTakeover } from "#src/runtime/lock/instance-lock.ts";
import { requireBootstrapped } from "#src/runtime/runtime.ts";
import { commandBody, runOnContext } from "#src/core/command/index.ts";
import type { ArgumentSpec, Values } from "#src/core/command/index.ts";
import * as kinds from "#src/core/values/kinds.ts";
import { BREAK_LOCK_ARGUMENT, BREAK_FOREIGN_LOCK_ARGUMENT, takeoverOf } from "#src/commands/interface/groups/shared-arguments.ts";

export const CONFIGURE_PROVIDER_ARGUMENTS = [
  { name: "provider", description: "Provider id, e.g. openai", kind: "option", valueName: "id", value: kinds.providerId() },
  { name: "env", description: "Secret variable, e.g. OPENAI_API_KEY", kind: "option", valueName: "var", value: kinds.envVar() },
  { name: "force", description: "Replace an existing SecretRef", kind: "flag" },
  BREAK_LOCK_ARGUMENT,
  BREAK_FOREIGN_LOCK_ARGUMENT,
  { name: "json", description: "Outcome as JSON", kind: "flag" },
] as const satisfies readonly ArgumentSpec[];

/** Gateway flags used by headless onboarding. */
function gatewayFlags(ctx: Context): string[] {
  return [
    "--gateway-auth", "token",
    "--gateway-token-ref-env", "OPENCLAW_GATEWAY_TOKEN",
    "--gateway-bind", "lan",
    "--gateway-port", ctx.settings.gatewayPort,
  ];
}

const SKIP_FLAGS = [
  "--skip-channels", "--skip-health", "--skip-daemon", "--skip-skills",
  "--skip-search", "--skip-hooks", "--skip-ui", "--suppress-gateway-token-output",
];

interface ProviderOptions {
  force: boolean;
  provider?: string;
  env?: string;
  jsonOnly: boolean;
  takeover: LockTakeover;
}

function providerOptions(values: Values<typeof CONFIGURE_PROVIDER_ARGUMENTS>): ProviderOptions {
  const { provider, env } = values;
  return { force: values.force === true, provider, env, jsonOnly: values.json === true, takeover: takeoverOf(values) };
}

/** The command body; configureProvider(ctx, args) stays for callers that already hold a Context. */
export const CONFIGURE_PROVIDER = commandBody({
  effect: "change",
  arguments: CONFIGURE_PROVIDER_ARGUMENTS,
  prepare(call) {
    return providerOptions(call.values as Values<typeof CONFIGURE_PROVIDER_ARGUMENTS>);
  },
  async run(ctx, plan) {
    await requireBootstrapped(ctx);
    // Same shape as restore/apply: the takeover from the bound values, breakLockSupported
    // defaults true.
    return guardedWith(ctx, "configure-provider", plan.takeover, () => configureProviderLocked(ctx, plan));
  },
});

export async function configureProvider(ctx: Context, args: string[]): Promise<void> {
  await runOnContext(CONFIGURE_PROVIDER, ctx, args);
}

async function configureProviderLocked(ctx: Context, options: ProviderOptions): Promise<void> {
  const secretsPath = secretsFileOnTarget(ctx);
  if (!(await ctx.transport.exists(secretsPath))) {
    if (options.jsonOnly) {
      emit(`${JSON.stringify({ ok: true, changed: false, configured: [], skipped: [`no ${secretsPath} yet`] }, null, 2)}\n`);
      return;
    }
    info(`no ${secretsPath} yet — nothing to configure`);
    return;
  }

  const secrets = parseEnv(await ctx.transport.readFile(secretsPath), secretsPath);
  const configPath = `${ctx.settings.dataDir}/config/openclaw.json`;
  // JSON5, not JSON: the live config is OpenClaw's JSON5 gateway format, where a comment or
  // trailing comma is legitimate.
  const config = (await ctx.transport.exists(configPath))
    ? JSON5.parse(await ctx.transport.readFile(configPath)) as unknown
    : {};
  const configured = options.provider === undefined ? collectConfiguredProviders(config) : [options.provider];
  const providers = new Set<string>(configured);
  // Auto-discovery only when no provider was named, and only for a secret no
  // already-configured provider already claims: converting an env var name back to an id
  // is lossy and can mint a second, distinct id for a differently-punctuated provider
  // already configured (a new, apiKey-only object missing its declared settings).
  if (options.provider === undefined) {
    for (const name of Object.keys(secrets)) {
      if (!name.endsWith("_API_KEY") || secrets[name] === "") continue;
      const alreadyCovered = configured.some((id) => (providerSecretVariable(config, id) ?? providerEnvironmentVariable(id)) === name);
      if (alreadyCovered) continue;
      providers.add(name.slice(0, -8).toLowerCase());
    }
  }

  const configuredIds: string[] = [];
  const skipped: string[] = [];
  for (const id of [...providers].sort()) {
    const env = options.env ?? providerSecretVariable(config, id) ?? providerEnvironmentVariable(id);
    if (env === undefined || secrets[env] === undefined || secrets[env] === "") continue;
    const current = providerSecretVariable(config, id);
    if (!options.force && current === env) {
      if (!options.jsonOnly) info(`provider ${id} already references ${env}`);
      skipped.push(`${id}: already references ${env}`);
      continue;
    }
    // providerSecretVariable only recognizes an env-sourced ref; undefined must not be
    // mistaken for "nothing set" — a file/exec/store ref or plain apiKey is a deliberate
    // credential this command must not silently replace.
    if (!options.force && current === undefined && providerApiKeyExplicit(config, id)) {
      if (!options.jsonOnly) info(`provider ${id} already has an explicit apiKey (not env-sourced) — use --force to replace it`);
      skipped.push(`${id}: explicit apiKey, not env-sourced — needs --force`);
      continue;
    }
    if (!options.jsonOnly) log(`configuring provider ${id} with ${env} (key stays in ${secretsPath})`);
    await ctx.runtime.runOneOff(
      "gateway",
      ["dist/index.js", "config", "set", `models.providers.${id}.apiKey`, JSON.stringify({ source: "env", id: env }), "--strict-json"],
      { noDeps: true, entrypoint: "node" },
    );
    configuredIds.push(id);
  }
  const changed = configuredIds.length > 0;
  if (options.jsonOnly) {
    emit(`${JSON.stringify({ ok: true, changed, configured: configuredIds, skipped }, null, 2)}\n`);
    return;
  }
  if (changed) log(`provider configuration updated — restart to apply: ${commandLine("restart")}`);
  else info("no provider changes");
}

/** Create the minimum local gateway configuration through OpenClaw onboarding. */
export async function ensureBaselineConfig(ctx: Context): Promise<void> {
  const configPath = `${ctx.settings.dataDir}/config/openclaw.json`;
  if (await ctx.transport.exists(configPath)) {
    info(`config already present: ${configPath}`);
    return;
  }

  log("creating the baseline config (headless onboarding)");
  await ctx.runtime.runOneOff(
    "gateway",
    [
      "dist/index.js", "onboard", "--non-interactive", "--accept-risk", "--mode", "local",
      "--auth-choice", "skip", ...gatewayFlags(ctx), ...SKIP_FLAGS,
    ],
    { noDeps: true, entrypoint: "node" },
  );
  if (!(await ctx.transport.exists(configPath))) throw new Error(`onboarding did not create ${configPath}`);
}

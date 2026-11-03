// Checks secret discovery, location, presence and rendering end to end.
//
// No target: openclaw.json content and the target .env are supplied by a stub transport.
// Assertions compare the actual returned arrays/objects/strings, not just "did not throw".
// Provider ids are inferred at runtime; no provider-specific table belongs in the framework.

import { collectSecretRefs, requirements, status, missing, template, providerEnvironmentVariable, providerSecretVariable, providerUsesNonApiKeyAuth, providerApiKeyExplicit, providerIsLocalEndpoint } from "#framework/service/secrets.ts";
import type { SecretRequirement, SecretStatus } from "#framework/service/secrets.ts";
import type { Context } from "#framework/core/context.ts";
import { check, finish } from "#checks/kit/harness.ts";

// --- collectSecretRefs: nested object -------------------------------------------

check(
  "collectSecretRefs finds a ref nested three levels deep",
  collectSecretRefs({ gateway: { auth: { token: { source: "env", id: "OPENCLAW_GATEWAY_TOKEN" } } } }),
  [{ name: "OPENCLAW_GATEWAY_TOKEN", usedBy: "gateway.auth.token" }],
);

// --- collectSecretRefs: array -----------------------------------------------------

check(
  "collectSecretRefs finds refs inside an array, indexed in usedBy",
  collectSecretRefs({ list: [{ source: "env", id: "FOO" }, { source: "env", id: "BAR" }] }),
  [
    { name: "FOO", usedBy: "list[0]" },
    { name: "BAR", usedBy: "list[1]" },
  ],
);

// --- requirements()/status(): stub Context --------------------------------------

const DATA_DIR = "/srv/openclaw/data";
const CONFIG_PATH = `${DATA_DIR}/config/openclaw.json`;
const TARGET_ENV_PATH = `${DATA_DIR}/config/.env`;

function makeCtx(options: {
  configExists?: boolean;
  config?: unknown;
  repoEnv?: Record<string, string>;
  targetEnvExists?: boolean;
  targetEnvText?: string;
}): Context {
  const { configExists = true, config = {}, repoEnv = {}, targetEnvExists = false, targetEnvText = "" } = options;
  return {
    settings: { dataDir: DATA_DIR, env: repoEnv },
    transport: {
      description: "stub",
      async exists(path: string): Promise<boolean> {
        if (path === CONFIG_PATH) return configExists;
        if (path === TARGET_ENV_PATH) return targetEnvExists;
        return false;
      },
      async readFile(path: string): Promise<string> {
        if (path === CONFIG_PATH) return JSON.stringify(config);
        if (path === TARGET_ENV_PATH) return targetEnvText;
        return "";
      },
      async writeFile(): Promise<void> {},
      async mkdirp(): Promise<void> {},
      async remove(): Promise<void> {},
      async exec(): Promise<{ code: number; stdout: string; stderr: string }> {
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;
}

const GATEWAY_CONFIG = { gateway: { auth: { token: { source: "env", id: "OPENCLAW_GATEWAY_TOKEN" } } } };
const OTHER_REF_CONFIG = { provider: { key: { source: "env", id: "SOME_OTHER_VAR" } } };

// --- requirements(): no config -> no requirements --------------------------------

check(
  "requirements is empty when openclaw.json does not exist",
  await requirements(makeCtx({ configExists: false })),
  [],
);

// --- requirements(): gateway token ref lands in repo-env --------------------------

check(
  "the gateway token ref is located in repo-env",
  await requirements(makeCtx({ config: GATEWAY_CONFIG })),
  [{ name: "OPENCLAW_GATEWAY_TOKEN", location: "repo-env", usedBy: "gateway.auth.token", required: true }],
);

// --- requirements(): any other ref lands in target-env -----------------------------

check(
  "a non-gateway ref is located in target-env",
  await requirements(makeCtx({ config: OTHER_REF_CONFIG })),
  [{ name: "SOME_OTHER_VAR", location: "target-env", usedBy: "provider.key", required: true }],
);

// --- requirements(): provider configured via models.providers ----------------------

check(
  "a provider configured via models.providers adds its conventional key",
  await requirements(makeCtx({ config: { models: { providers: { zai: {} } } } })),
  [{ name: "ZAI_API_KEY", location: "target-env", usedBy: "provider zai", required: true }],
);

check("provider ids map to conventional variables", providerEnvironmentVariable("openai-compatible"), "OPENAI_COMPATIBLE_API_KEY");
check(
  "an explicit provider SecretRef overrides the convention",
  providerSecretVariable({ models: { providers: { custom: { apiKey: { source: "env", id: "CUSTOM_TOKEN" } } } } }, "custom"),
  "CUSTOM_TOKEN",
);
check(
  "an auth profile SecretRef overrides the convention",
  providerSecretVariable({ auth: { profiles: { work: { provider: "custom", apiKey: { source: "env", id: "CUSTOM_TOKEN" } } } } }, "custom"),
  "CUSTOM_TOKEN",
);
// Regression: the profile's own key ("work") is an arbitrary label per OpenClaw's real
// schema, not a "provider:default"-formatted id — before the fix, a key that did not
// happen to start with "custom:" would silently fail to match at all.
check(
  "the profile's own key is irrelevant — only its .provider field is read",
  providerSecretVariable({ auth: { profiles: { anything_at_all: { provider: "custom", apiKey: { source: "env", id: "CUSTOM_TOKEN" } } } } }, "custom"),
  "CUSTOM_TOKEN",
);
check(
  "an arbitrary provider uses its inferred variable",
  await requirements(makeCtx({ config: { models: { providers: { custom: {} } } } })),
  [{ name: "CUSTOM_API_KEY", location: "target-env", usedBy: "provider custom", required: true }],
);

// --- requirements(): provider configured via auth.profiles -------------------------

check(
  "a provider configured via auth.profiles (its own .provider field, not the profile's key) adds its conventional key",
  await requirements(makeCtx({ config: { auth: { profiles: { "some-arbitrary-label": { provider: "zai" } } } } })),
  [{ name: "ZAI_API_KEY", location: "target-env", usedBy: "provider zai", required: true }],
);
// Regression: a profile keyed "zai:default" with no .provider field is not itself a
// provider id — before the fix, splitting the key on ":" treated "zai" (whatever came
// before the colon, even by coincidence) as the provider, masking the real bug that no
// .provider field means OpenClaw's own schema (auth.profiles.<key>: strictObject with a
// required .provider field) rejects this profile outright; the framework must not invent
// a provider id from a key shape the schema never actually guarantees.
check(
  "a profile with no .provider field names no provider at all",
  await requirements(makeCtx({ config: { auth: { profiles: { "zai:default": {} } } } })),
  [],
);

// --- requirements(): both paths configuring the same provider is not duplicated -----

check(
  "the same provider configured via both paths yields exactly one requirement",
  await requirements(
    makeCtx({ config: { models: { providers: { zai: {} } }, auth: { profiles: { default: { provider: "zai" } } } } }),
  ),
  [{ name: "ZAI_API_KEY", location: "target-env", usedBy: "provider zai", required: true }],
);

// --- requirements(): dedup by name between an explicit ref and a configured provider -

check(
  "an explicit SecretRef and a configured provider for the same name yield exactly one entry",
  await requirements(
    makeCtx({
      config: {
        models: { providers: { zai: {} } },
        provider: { key: { source: "env", id: "ZAI_API_KEY" } },
      },
    }),
  ),
  [{ name: "ZAI_API_KEY", location: "target-env", usedBy: "provider.key", required: true }],
);

// --- requirements(): providers that need no apiKey at all must not get a phantom one ---
//
// Four ways a provider is legitimately configured without an env-sourced apiKey, confirmed
// against OpenClaw's real config schema (github.com/openclaw/openclaw
// src/config/zod-schema.core.ts, zod-schema.root-shape.ts): an OAuth auth-profile, the AWS
// SDK's own credential chain, a bearer token issued some other way, and a local subprocess
// service. The prior code fell back to the <PROVIDER>_API_KEY convention in all four cases,
// which is exactly the reported defect: a correctly configured instance refused to start.

check(
  "an OAuth auth profile (mode: oauth) needs no apiKey",
  await requirements(makeCtx({ config: { auth: { profiles: { "openai-codex:default": { provider: "openai-codex", mode: "oauth" } } } } })),
  [],
);
check(
  "an aws-sdk provider (models.providers.<id>.auth) needs no apiKey",
  await requirements(makeCtx({ config: { models: { providers: { bedrock: { auth: "aws-sdk" } } } } })),
  [],
);
check(
  "a token-mode auth profile needs no apiKey",
  await requirements(makeCtx({ config: { auth: { profiles: { "vertex:default": { provider: "vertex", mode: "token" } } } } })),
  [],
);
check(
  "a local subprocess service (localService) needs no apiKey",
  await requirements(makeCtx({ config: { models: { providers: { local: { localService: { command: "llama-server" } } } } } })),
  [],
);
check(
  "a provider whose apiKey is already a file SecretRef is not given an additional phantom requirement",
  await requirements(makeCtx({ config: { models: { providers: { custom: { apiKey: { source: "file", path: "/run/secrets/custom" } } } } } })),
  [],
);
check(
  "a provider whose apiKey is already a plain string is not given an additional phantom requirement",
  await requirements(makeCtx({ config: { models: { providers: { custom: { apiKey: "inline-value-nobody-should-use" } } } } })),
  [],
);

// A local, unauthenticated server (baseUrl on loopback, nothing said about credentials) is
// a fifth legitimate case, confirmed against OpenClaw's real ModelProviderSchema (apiKey/
// auth/localService are all optional, no superRefine requires any of them) and its own docs
// for a self-hosted LM Studio with authentication disabled. Guessing LMSTUDIO_API_KEY here
// blocks a correctly configured, schema-valid instance exactly like the other four cases.
check(
  "a loopback provider (baseUrl on localhost) with nothing said about credentials needs no apiKey",
  await requirements(makeCtx({ config: { models: { providers: { lmstudio: { baseUrl: "http://localhost:1234/v1" } } } } })),
  [],
);
check(
  "a loopback provider on 127.0.0.1 needs no apiKey either",
  await requirements(makeCtx({ config: { models: { providers: { lmstudio: { baseUrl: "http://127.0.0.1:1234/v1" } } } } })),
  [],
);
check("providerIsLocalEndpoint is true for a localhost baseUrl", providerIsLocalEndpoint({ models: { providers: { lmstudio: { baseUrl: "http://localhost:1234" } } } }, "lmstudio"), true);
check("providerIsLocalEndpoint is false for a remote baseUrl", providerIsLocalEndpoint({ models: { providers: { custom: { baseUrl: "https://api.example.com" } } } }, "custom"), false);
check("providerIsLocalEndpoint is false when there is no baseUrl at all", providerIsLocalEndpoint({ models: { providers: { zai: {} } } }, "zai"), false);
// Regression: Node normalizes a literal IPv6 loopback host to "[::1]" (bracketed), not "::1".
check(
  "a loopback provider on IPv6 ([::1]) needs no apiKey either",
  await requirements(makeCtx({ config: { models: { providers: { lmstudio: { baseUrl: "http://[::1]:1234/v1" } } } } })),
  [],
);
check("providerIsLocalEndpoint is true for an IPv6 loopback baseUrl", providerIsLocalEndpoint({ models: { providers: { lmstudio: { baseUrl: "http://[::1]:1234" } } } }, "lmstudio"), true);

// The convention fallback itself must still fire for the one case it exists for: a provider
// present in models.providers or auth.profiles with nothing at all said about credentials.
check("providerUsesNonApiKeyAuth is false for a bare provider entry", providerUsesNonApiKeyAuth({ models: { providers: { zai: {} } } }, "zai"), false);
check("providerUsesNonApiKeyAuth is false when the provider is not configured at all", providerUsesNonApiKeyAuth({}, "zai"), false);
check("providerApiKeyExplicit is false when apiKey is absent", providerApiKeyExplicit({ models: { providers: { zai: {} } } }, "zai"), false);
check(
  "an api-key-mode provider still gets its conventional key when no env ref is set",
  await requirements(makeCtx({ config: { models: { providers: { zai: { auth: "api-key" } } } } })),
  [{ name: "ZAI_API_KEY", location: "target-env", usedBy: "provider zai", required: true }],
);

// --- status(): repo-env presence follows ctx.settings.env --------------------------

check(
  "a repo-env requirement is present when settings.env carries a non-blank value",
  await status(makeCtx({ config: GATEWAY_CONFIG, repoEnv: { OPENCLAW_GATEWAY_TOKEN: "abc123" } })),
  [
    {
      name: "OPENCLAW_GATEWAY_TOKEN",
      location: "repo-env",
      usedBy: "gateway.auth.token",
      required: true,
      present: true,
    },
  ],
);

check(
  "a repo-env requirement is absent when settings.env lacks the key",
  await status(makeCtx({ config: GATEWAY_CONFIG, repoEnv: {} })),
  [
    {
      name: "OPENCLAW_GATEWAY_TOKEN",
      location: "repo-env",
      usedBy: "gateway.auth.token",
      required: true,
      present: false,
    },
  ],
);

check(
  "a repo-env value that is blank after trim counts as absent",
  (await status(makeCtx({ config: GATEWAY_CONFIG, repoEnv: { OPENCLAW_GATEWAY_TOKEN: "   " } })))[0]?.present,
  false,
);

// --- status(): target-env is read from <dataDir>/config/.env on the target ---------

check(
  "a target-env requirement is present when the target .env has a value",
  await status(makeCtx({ config: OTHER_REF_CONFIG, targetEnvExists: true, targetEnvText: "SOME_OTHER_VAR=value123\n" })),
  [
    {
      name: "SOME_OTHER_VAR",
      location: "target-env",
      usedBy: "provider.key",
      required: true,
      present: true,
    },
  ],
);

check(
  "target-env is treated as empty when the target .env file does not exist",
  await status(makeCtx({ config: OTHER_REF_CONFIG, targetEnvExists: false })),
  [
    {
      name: "SOME_OTHER_VAR",
      location: "target-env",
      usedBy: "provider.key",
      required: true,
      present: false,
    },
  ],
);

// --- missing(): required and not present --------------------------------------------

const statusEntries: SecretStatus[] = [
  { name: "A", location: "repo-env", usedBy: "x", required: true, present: true },
  { name: "B", location: "target-env", usedBy: "y", required: true, present: false },
  { name: "C", location: "target-env", usedBy: "z", required: false, present: false },
];

check("missing filters to entries that are required and not present", missing(statusEntries), [
  { name: "B", location: "target-env", usedBy: "y", required: true, present: false },
]);

// --- template(): section headers, used-by comments, bare NAME= lines ----------------

const templateEntries: SecretRequirement[] = [
  { name: "OPENCLAW_GATEWAY_TOKEN", location: "repo-env", usedBy: "gateway.auth.token", required: true },
  { name: "ZAI_API_KEY", location: "target-env", usedBy: "provider zai", required: true },
];

const expectedTemplate =
  "# Secrets required by this OpenClaw instance.\n" +
  "# Values are intentionally absent: fill them in on the target.\n" +
  "#\n" +
  "# repo-env    -> .env next to the repository (passed into the container by the runtime)\n" +
  "# target-env  -> <data>/config/.env on the target (read by OpenClaw itself)\n" +
  "\n" +
  "# --- repo-env ---\n" +
  "# a repo-env value usually already exists in the repository's own .env — copy it here, do not invent a new one\n" +
  "# used by: gateway.auth.token\n" +
  "OPENCLAW_GATEWAY_TOKEN=\n" +
  "\n" +
  "# --- target-env ---\n" +
  "# used by: provider zai\n" +
  "ZAI_API_KEY=\n";

check(
  "template renders both sections with headers, used-by comments and bare NAME= lines",
  template(templateEntries),
  expectedTemplate,
);

check(
  "template omits a location's section header entirely when it has no entries",
  template([{ name: "OPENCLAW_GATEWAY_TOKEN", location: "repo-env", usedBy: "gateway.auth.token", required: true }]).includes(
    "# --- target-env ---",
  ),
  false,
);

// --- requirements(): the live openclaw.json is JSON5, not JSON -----------------------
//
// OpenClaw's own gateway config format IS JSON5 (docs.openclaw.ai/gateway/configuration:
// comments and trailing commas are valid). Before the fix, requirements() read it with
// plain JSON.parse, unwrapped in a try/catch — a real target config using either syntax
// threw a SyntaxError straight out of requirements(), aborting the `up`/`apply` secrets
// step before the gateway ever started.

function makeCtxWithRawConfig(rawConfig: string): Context {
  return {
    settings: { dataDir: DATA_DIR, env: {} },
    transport: {
      description: "stub",
      async exists(path: string): Promise<boolean> {
        return path === CONFIG_PATH;
      },
      async readFile(path: string): Promise<string> {
        return path === CONFIG_PATH ? rawConfig : "";
      },
      async writeFile(): Promise<void> {},
      async mkdirp(): Promise<void> {},
      async remove(): Promise<void> {},
      async exec(): Promise<{ code: number; stdout: string; stderr: string }> {
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;
}

{
  const raw = '{\n  // a comment plain JSON.parse rejects outright\n  "models": { "providers": { "zai": {}, }, },\n}\n';
  let threw = false;
  let result: SecretRequirement[] = [];
  try {
    result = await requirements(makeCtxWithRawConfig(raw));
  } catch {
    threw = true;
  }
  check("a JSON5 live config (comment, trailing commas) does not crash requirements()", threw, false);
  check(
    "and is actually parsed, not just tolerated",
    result,
    [{ name: "ZAI_API_KEY", location: "target-env", usedBy: "provider zai", required: true }],
  );
}

finish("requirements");

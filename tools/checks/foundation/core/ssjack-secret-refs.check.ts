import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import {
  collectSSJackReferences, parseSSJackPlaceholder, refuseUnenrolledSSJackReferences,
  INVALID_SSJACK_REFERENCE, SSJACK_DELIVERY_UNAVAILABLE, SSJACK_REFERENCE_FORMAT,
} from "#framework/core/values/ssjack-secret-refs.ts";
import { providerApiKeyExplicit, requirementsForConfig, requirementsFromConfig } from "#framework/service/secrets.ts";
import type { Context } from "#framework/core/context.ts";

const reference = {
  format: SSJACK_REFERENCE_FORMAT,
  store_id: "11".repeat(16), object_id: "22".repeat(16),
  version_id: "33".repeat(16), snapshot_id: "44".repeat(16),
} as const;
const placeholder = { $ssjack: reference };
function refusal(run: () => unknown): string {
  try { run(); return "accepted"; }
  catch (error) { return error instanceof Error ? error.message : "non-error"; }
}

check("exact metadata survives parsing", parseSSJackPlaceholder(placeholder), reference);
const parsed = parseSSJackPlaceholder(placeholder);
checkTrue("returned metadata is frozen and owned", parsed !== undefined && parsed !== reference && Object.isFrozen(parsed));
const shared = { left: placeholder, right: [placeholder] };
check("structural paths preserve aliased declarations", collectSSJackReferences(shared), [
  { path: ["left"], reference }, { path: ["right", 0], reference },
]);
check("literal text is not interpolated", collectSSJackReferences({ prompt: JSON.stringify(placeholder) }), []);
check("native environment references remain native", collectSSJackReferences({ source: "env", id: "API_KEY" }), []);
check("valid metadata is not permission", refusal(() => refuseUnenrolledSSJackReferences(placeholder)), SSJACK_DELIVERY_UNAVAILABLE);

for (const [label, body] of Object.entries({
  missing: { ...reference, snapshot_id: undefined },
  latest: { ...reference, version_id: "latest" },
  wildcard: { ...reference, version_id: "*" },
  zero: { ...reference, object_id: "00".repeat(16) },
  uppercase: { ...reference, object_id: "AB".repeat(16) },
  short: { ...reference, object_id: "22".repeat(15) },
  extra: { ...reference, secret_value: "synthetic-sensitive-marker" },
  wrongFormat: { ...reference, format: "ssjack-secret-ref-v2" },
  nullBody: null,
})) {
  check(`${label} marker is rejected without input echo`, refusal(() => parseSSJackPlaceholder({ $ssjack: body })), INVALID_SSJACK_REFERENCE);
}
check("extra envelope keys are rejected", refusal(() => parseSSJackPlaceholder({ ...placeholder, other: true })), INVALID_SSJACK_REFERENCE);
let getterCalls = 0;
const accessor = Object.defineProperty({}, "$ssjack", { get: () => { getterCalls++; throw new Error("synthetic-sensitive-marker"); } });
check("accessor marker is rejected opaquely", refusal(() => parseSSJackPlaceholder(accessor)), INVALID_SSJACK_REFERENCE);
check("marker getters are not invoked", getterCalls, 0);
const cycle: { next?: unknown } = {};
cycle.next = cycle;
check("cycles fail before recursive exhaustion", refusal(() => collectSSJackReferences(cycle)), INVALID_SSJACK_REFERENCE);
let deep: unknown = placeholder;
for (let i = 0; i < 65; i++) deep = { next: deep };
check("depth is bounded", refusal(() => collectSSJackReferences(deep)), INVALID_SSJACK_REFERENCE);

const managedConfig = { models: { providers: { alpha: { apiKey: placeholder } } } };
check("managed apiKey is not a satisfied native credential", refusal(() => providerApiKeyExplicit(managedConfig, "alpha")), SSJACK_DELIVERY_UNAVAILABLE);
check("provider convention cannot replace a managed reference", refusal(() => requirementsFromConfig(managedConfig)), SSJACK_DELIVERY_UNAVAILABLE);
let hookCalls = 0;
const ctx = { applicationSecrets: async () => { hookCalls++; return []; } } as unknown as Context;
let asyncRefusal = "accepted";
try { await requirementsForConfig(ctx, managedConfig); }
catch (error) { asyncRefusal = error instanceof Error ? error.message : "non-error"; }
check("managed config is refused before the application hook", asyncRefusal, SSJACK_DELIVERY_UNAVAILABLE);
check("no hook was contacted", hookCalls, 0);
const standalone = {
  gateway: { auth: { token: { source: "env", id: "OPENCLAW_GATEWAY_TOKEN" } } },
  models: { providers: { alpha: { apiKey: { source: "file", id: "synthetic-native-file" } } } },
};
check("standalone file credentials keep their previous classification", providerApiKeyExplicit(standalone, "alpha"), true);
check("standalone environment requirements are preserved", requirementsFromConfig(standalone), [
  { name: "OPENCLAW_GATEWAY_TOKEN", location: "repo-env", usedBy: "gateway.auth.token", required: true },
]);
finish("ssjack secret reference metadata");

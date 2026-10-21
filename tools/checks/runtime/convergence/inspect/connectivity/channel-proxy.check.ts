// CHANNEL_PROXY_DOWN: when an unhealthy/unknown channel ACCOUNT routes through a proxy a
// recipe owns (consumerEndpoints), inspect names that recipe and its service's health —
// once per recipe, never the proxy URL, and never from a read that failed. Driven through
// the real gatherInspection pipeline (including real normalization of a custom channel
// key) for the headline cases, and through the pure correlation for the matrix around it.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gatherInspection } from "#framework/commands/orchestration/inspect/gather.ts";
import { channelProxyFindings, PROXY_NOT_RUNNING, proxyDownNote } from "#framework/commands/orchestration/inspect/live.ts";
import type { RecipeEndpointOwner } from "#framework/service/recipe.ts";
import { normalizeChannels } from "#framework/service/openclaw-cli.ts";
import type { StackServiceState } from "#framework/runtime/runtime.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { setupFixtureDeployment, teardownFixtureDeployment } from "../fixture.ts";

const fixture = await setupFixtureDeployment();
// A recipe with no agent directory: a plain service, skipped by recipe expectations, but
// present in the endpoint-owner catalog the correlation reads.
await mkdir(resolve(fixture.deployment, "recipes", "egress"), { recursive: true });
await writeFile(
  resolve(fixture.deployment, "recipes", "egress", "recipe.json"),
  JSON.stringify({ description: "egress proxy sidecar", consumerEndpoints: [{ configPath: "channels.telegram.proxy", service: "proxy" }] }),
);
await mkdir(resolve(fixture.deployment, "recipes", "relay"), { recursive: true });
await writeFile(
  resolve(fixture.deployment, "recipes", "relay", "recipe.json"),
  JSON.stringify({ description: "relay proxy sidecar", consumerEndpoints: [{ configPath: "channels.selfhosted-relay.proxy", service: "proxy" }] }),
);
const PROXY_URL = "socks5://user:secret@proxy.invalid:1080";
const PRIVATE_ACCOUNT = "acct-7f3a9c";

try {
  // --- the real pipeline: gather -> channel finding -> proxy correlation --------------------
  const pipelineSpec = {
    liveConfig: { channels: { telegram: { proxy: PROXY_URL } } },
    channelsStatus: { telegram: [{ configured: true, enabled: true, running: false }] },
  };
  const ctx = fixture.stubContext(pipelineSpec);
  (ctx.runtime as { stack: unknown }).stack = () => ({
    async serviceStates(): Promise<Record<string, StackServiceState>> {
      return { proxy: { running: true, health: "unhealthy" } };
    },
  });
  const gathered = await gatherInspection(ctx);
  const proxyFindings = gathered.problems.filter((entry) => entry.code === "CHANNEL_PROXY_DOWN");
  check("an unhealthy channel behind an unhealthy proxy recipe gains the explaining finding", proxyFindings.length, 1);
  check("the finding names the owning recipe and the health state", [proxyFindings[0]?.detail.includes('"egress"'), proxyFindings[0]?.detail.includes('"unhealthy"'), proxyFindings[0]?.detail.includes('"telegram"')], [true, true, true]);
  check("the proxy URL with its credentials never reaches the finding", [proxyFindings[0]?.detail.includes("socks5"), proxyFindings[0]?.detail.includes("secret"), proxyFindings[0]?.detail.includes("proxy.invalid")], [false, false, false]);
  check("the finding is a warning beside the channel warning it explains", [proxyFindings[0]?.severity, gathered.problems.some((entry) => entry.code === "CHANNEL_UNHEALTHY")], ["warning", true]);
  const remedy = proxyFindings[0]?.next;
  check("the remedy is the recipe's gated diagnose, with its logs hint", [remedy?.kind, remedy?.kind === "clawwright" ? remedy.argv : undefined, remedy?.kind === "clawwright" ? remedy.note : undefined], ["clawwright", ["recipe", "diagnose", "egress"], proxyDownNote("egress")]);
  check("the logs hint names the recipe it was built for", proxyDownNote("egress").includes("egress"), true);

  const healthyCtx = fixture.stubContext(pipelineSpec);
  (healthyCtx.runtime as { stack: unknown }).stack = () => ({
    async serviceStates(): Promise<Record<string, StackServiceState>> {
      return { proxy: { running: true, health: "healthy" } };
    },
  });
  const healthyGathered = await gatherInspection(healthyCtx);
  check("a healthy proxy recipe is never blamed", healthyGathered.problems.some((entry) => entry.code === "CHANNEL_PROXY_DOWN"), false);

  // A custom channel key is NOT a display label: the fixture's status answer normalizes it
  // to an opaque channel-1, and only the private identity table still knows the key the
  // live configuration (and the recipe's consumerEndpoints) use.
  const CUSTOM_KEY = "selfhosted-relay";
  const customCtx = fixture.stubContext({
    liveConfig: { channels: { [CUSTOM_KEY]: { proxy: PROXY_URL } } },
    channelsStatus: { [CUSTOM_KEY]: [{ accountId: PRIVATE_ACCOUNT, configured: true, enabled: true, running: false }] },
  });
  (customCtx.runtime as { stack: unknown }).stack = () => ({
    async serviceStates(): Promise<Record<string, StackServiceState>> {
      return { proxy: { running: false } };
    },
  });
  const customGathered = await gatherInspection(customCtx);
  const customFindings = customGathered.problems.filter((entry) => entry.code === "CHANNEL_PROXY_DOWN");
  check("a custom channel key correlates through real normalization", customFindings.length, 1);
  check("the custom finding carries the normalized label and the owning recipe", [customFindings[0]?.detail.includes('"channel-1"'), customFindings[0]?.detail.includes('"relay"')], [true, true]);
  check("neither the real channel key nor the account id reaches the new finding", [JSON.stringify(customFindings).includes(CUSTOM_KEY), JSON.stringify(customFindings).includes(PRIVATE_ACCOUNT)], [false, false]);

  // --- the correlation matrix: raw telemetry through the REAL normalization --------------------
  const owners: readonly RecipeEndpointOwner[] = [{ recipe: "egress", service: "proxy", configPath: "channels.telegram.proxy" }];
  const accountOwners: readonly RecipeEndpointOwner[] = [
    { recipe: "egress-account", service: "proxy", configPath: "channels.telegram.accounts.700000000.proxy" },
    { recipe: "egress", service: "proxy", configPath: "channels.telegram.proxy" },
  ];
  const telemetry = (...accounts: Record<string, unknown>[]) => normalizeChannels({ channelAccounts: { telegram: accounts } })!;
  const live = (telegram: Record<string, unknown>) => ({ channels: { telegram } });
  const down = { proxy: { running: false } } as Record<string, StackServiceState>;
  const unhealthyAccount = { configured: true, enabled: true, running: false };
  const states = (value: Record<string, StackServiceState> | undefined) => () => value;

  check("unknown telemetry behind a down proxy still gains the finding", channelProxyFindings(live({ proxy: PROXY_URL }), telemetry({ configured: true, enabled: true, credentialPresent: true }), owners, states(down)).length, 1);
  const started = channelProxyFindings(live({ proxy: PROXY_URL }), telemetry(unhealthyAccount), owners, states({ proxy: { running: true, health: "starting" } }));
  check("a starting proxy is a finding carrying that state", started[0]?.detail.includes('"starting"'), true);
  const stopped = channelProxyFindings(live({ proxy: PROXY_URL }), telemetry(unhealthyAccount), owners, states({}));
  check("a service missing from a complete answer reads as not running", [stopped.length, stopped[0]?.detail.includes(PROXY_NOT_RUNNING)], [1, true]);
  check("a failed stack read is unknown, never down", channelProxyFindings(live({ proxy: PROXY_URL }), telemetry(unhealthyAccount), owners, states(undefined)), []);

  const withSibling = telemetry(unhealthyAccount, { accountId: "default", configured: true, enabled: true, running: true, connected: true });
  check("an unhealthy unproxied account beside a proxied sibling is not blamed", channelProxyFindings(live({ accounts: { default: { proxy: PROXY_URL } } }), withSibling, owners, states(down)), []);
  const defaultAccount = telemetry({ accountId: "default", configured: true, enabled: true, running: false });
  check("an account-level empty proxy overrides the channel-level one", channelProxyFindings(live({ proxy: PROXY_URL, accounts: { default: { proxy: "" } } }), defaultAccount, owners, states(down)), []);
  check("an account configured without a proxy key inherits the channel-level proxy", channelProxyFindings(live({ proxy: PROXY_URL, accounts: { default: { enabled: true } } }), defaultAccount, owners, states(down)).length, 1);

  const second = telemetry({ accountId: "700000000", configured: true, enabled: true, running: false }, { accountId: "default", configured: true, enabled: false, running: false });
  const perAccount = channelProxyFindings(live({ accounts: { "700000000": { proxy: PROXY_URL } } }), second, accountOwners, states({ proxy: { running: true, health: "unhealthy" } }));
  check("an account-level proxy resolves through the account-level declaration", [perAccount.length, perAccount[0]?.detail.includes('"egress-account"'), perAccount[0]?.detail.includes('"egress"')], [1, true, false]);
  check("an account-level proxy is not owned by a channel-level declaration alone", channelProxyFindings(live({ accounts: { "700000000": { proxy: PROXY_URL } } }), second, owners, states(down)), []);

  const twoAccounts = telemetry(unhealthyAccount, { configured: true, enabled: true, connected: false });
  const twoAccountFindings = channelProxyFindings(live({ proxy: PROXY_URL }), twoAccounts, owners, states(down));
  check("two unhealthy accounts of one channel produce one finding naming the channel once", [twoAccountFindings.length, twoAccountFindings[0]?.detail.split("telegram").length], [1, 2]);
  check("disabled accounts never alarm, so no proxy finding either", channelProxyFindings(live({ proxy: PROXY_URL }), telemetry({ configured: true, enabled: false, running: false }), owners, states(down)), []);
  check("no proxy configured means nothing to correlate", channelProxyFindings(live({}), telemetry(unhealthyAccount), owners, states(down)), []);
  check("a proxy no recipe declares is never blamed", channelProxyFindings(live({ proxy: PROXY_URL }), telemetry(unhealthyAccount), [], states(down)), []);
  const serialized = JSON.stringify(channelProxyFindings(live({ proxy: PROXY_URL }), telemetry(unhealthyAccount), owners, states(down)));
  check("no finding text carries the URL, its credentials or its host", ["socks5", "secret", "proxy.invalid", "1080", "@"].map((needle) => serialized.includes(needle)), [false, false, false, false, false]);
} finally {
  await teardownFixtureDeployment(fixture.deployment);
}

finish("inspect-channel-proxy");

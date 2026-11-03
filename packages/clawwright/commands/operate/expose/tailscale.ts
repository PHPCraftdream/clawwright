// `clawwright expose tailscale` — tailnet-only access to the loopback-bound gateway via
// `tailscale serve`. `tailscale funnel` (public internet) is refused outright.
//
// The probe runs on the TARGET through the transport, not the operator's machine — a tailnet
// identity locally says nothing about whether the target can serve anything.
//
// Per https://tailscale.com/docs/reference/tailscale-cli/serve: `--bg` backgrounds it so it
// survives this process exiting; a bare `http://127.0.0.1:<port>` target proxies HTTPS (tailnet
// cert, port 443) to that backend. Turning ONE route off repeats the original invocation's own
// flags with `off` appended — `serve status --json` keys each route by host:port and mount, so
// turning one off never touches another service's mapping.

import { log, info, die } from "#src/core/io/log.ts";
import { commandLine, renderArguments } from "#src/core/io/invocation/render.ts";
import { guardedWith } from "#src/runtime/lock/instance-lock.ts";
import { requireBootstrapped } from "#src/runtime/runtime.ts";
import type { Context } from "#src/core/context.ts";
import type { ExecResult } from "#src/runtime/transport/transport.ts";
import { defineAction, multiActionBody, runOnContext, type ArgumentSpec, type Values } from "#src/core/command/index.ts";
import { LOCK_TAKEOVER_ARGUMENTS, takeoverOf } from "#src/commands/interface/groups/shared-arguments.ts";

/** The slice of `expose`'s declaration this action's own argv actually uses. `--apply` is
 *  the one mutating flag: its effect raises the whole call to destroy (MCP confirmation and
 *  the instance lock read from the declaration, not from argv). */
export const EXPOSE_TAILSCALE_ARGUMENTS = [
  {
    name: "apply",
    summary: "run tailscale serve on the target",
    description: "With tailscale: run the printed `tailscale serve` command on the target instead of only printing it",
    kind: "flag",
    effect: "destroy",
  },
  ...LOCK_TAKEOVER_ARGUMENTS,
] as const satisfies readonly ArgumentSpec[];

/** The probe's refusal when the target has no tailscale, exported so checks assert the same
 *  text the product prints. */
export const TAILSCALE_ABSENT = "tailscale is not installed on the target";

export interface TailscaleProbe {
  readonly present: boolean;
  readonly loggedIn: boolean;
  readonly detail: string;
}

function backendState(result: ExecResult): string | undefined {
  try {
    const parsed = JSON.parse(result.stdout) as { BackendState?: unknown };
    return typeof parsed.BackendState === "string" ? parsed.BackendState : undefined;
  } catch {
    return undefined;
  }
}

/** Read-only: existence and login state, both asked on the target through the transport.
 *  `BackendState: "Running"` is tailscaled's own spelling for "logged in and connected" —
 *  anything else (NeedsLogin, Stopped, Starting, NoState, an unreadable answer) is not. */
export async function probeTailscale(ctx: Context): Promise<TailscaleProbe> {
  const found = await ctx.transport.exec("sh", ["-c", "command -v tailscale"], { allowFailure: true });
  if (found.code !== 0 || found.stdout.trim() === "") {
    return { present: false, loggedIn: false, detail: TAILSCALE_ABSENT };
  }
  const status = await ctx.transport.exec("tailscale", ["status", "--json"], { allowFailure: true });
  if (status.code !== 0) {
    return {
      present: true,
      loggedIn: false,
      detail: `tailscale is installed but \`tailscale status\` failed (exit ${status.code})`,
    };
  }
  const state = backendState(status);
  const loggedIn = state === "Running";
  return {
    present: true,
    loggedIn,
    detail: loggedIn
      ? "tailscale is installed and logged in"
      : `tailscale is installed but not logged in (state: ${state ?? "unknown"}) — run \`tailscale up\` on the target`,
  };
}

/** Tailnet-only HTTPS proxy to the gateway's own loopback. Never funnel — see the header. */
export function tailscaleServeCommand(gatewayPort: string): string[] {
  return ["tailscale", "serve", "--bg", `http://127.0.0.1:${gatewayPort}`];
}

/** One `tailscale serve` route that proxies to this gateway's own loopback port. */
export interface TailscaleGatewayRoute {
  /** "$SNI_NAME:$PORT", the Web map's own key. */
  readonly hostPort: string;
  /** The https port `--https=<port> off` needs — the numeric suffix of hostPort. */
  readonly port: string;
  /** The mount this route answers under ("/" for the bare-target form this module applies). */
  readonly mountPoint: string;
}

/** Every route in `tailscale serve status --json` that proxies to 127.0.0.1:<gatewayPort> —
 *  never any other service's mapping. `undefined` means the JSON did not parse as the
 *  documented shape (see header): the caller must not guess at what to turn off from a shape
 *  it does not recognise, and reports the exact manual command instead. */
export async function tailscaleGatewayRoutes(ctx: Context, gatewayPort: string): Promise<TailscaleGatewayRoute[] | undefined> {
  const result = await ctx.transport.exec("tailscale", ["serve", "status", "--json"], { allowFailure: true });
  if (result.code !== 0) return undefined;
  let parsed: { Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown }> }> };
  try {
    parsed = JSON.parse(result.stdout.trim() === "" ? "{}" : result.stdout) as typeof parsed;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const target = `http://127.0.0.1:${gatewayPort}`;
  const routes: TailscaleGatewayRoute[] = [];
  for (const [hostPort, entry] of Object.entries(parsed.Web ?? {})) {
    const port = /^.+:(\d+)$/.exec(hostPort)?.[1];
    if (port === undefined) return undefined; // an unrecognized key shape — refuse to guess at any of it
    for (const [mountPoint, handler] of Object.entries(entry?.Handlers ?? {})) {
      if (handler?.Proxy === target) routes.push({ hostPort, port, mountPoint });
    }
  }
  return routes;
}

/** Turns off exactly one route: the original invocation's own flags repeated with `off`
 *  appended (see header) — never `tailscale serve reset`, which would wipe every other
 *  mapping on the target too. */
export function tailscaleServeOffCommand(route: TailscaleGatewayRoute): string[] {
  const args = ["tailscale", "serve", `--https=${route.port}`];
  if (route.mountPoint !== "/") args.push(`--set-path=${route.mountPoint}`);
  args.push("off");
  return args;
}

async function runTailscale(ctx: Context, values: Values<typeof EXPOSE_TAILSCALE_ARGUMENTS>): Promise<void> {
  const { apply } = values;
  const probe = await probeTailscale(ctx);
  const command = tailscaleServeCommand(ctx.settings.gatewayPort);

  log("tailscale serve (tailnet-only)");
  info(probe.detail);
  info(renderArguments(command));
  info("reachable to tailnet members only — the exact https URL depends on this machine's");
  info(`tailnet name; see \`tailscale serve status\` (or ${commandLine(["expose", "status"])}) once applied.`);
  // The bare-target form above serves https 443 at "/": turn off just that route.
  const undo = tailscaleServeOffCommand({ hostPort: "", port: "443", mountPoint: "/" });
  info(`undo with: ${renderArguments(undo)} (run on the target; removes only this route — confirm the port with \`tailscale serve status\`)`);

  if (!apply) {
    if (!probe.present) info("install tailscale on the target, then `tailscale up`, before --apply");
    else if (!probe.loggedIn) info("run `tailscale up` on the target before --apply");
    return;
  }

  if (!probe.present) die(`cannot --apply: ${TAILSCALE_ABSENT}`);
  if (!probe.loggedIn) die(`cannot --apply: ${probe.detail}`);

  await requireBootstrapped(ctx);
  return guardedWith(ctx, "expose tailscale --apply", takeoverOf(values), async () => {
    log("applying tailscale serve on the target");
    const result = await ctx.transport.exec(command[0], command.slice(1), { allowFailure: true });
    if (result.code !== 0) {
      die(`tailscale serve failed (exit ${result.code}): ${(result.stderr || result.stdout).trim()}`);
    }
    log(`applied — check with ${commandLine(["expose", "status"])}, or \`tailscale serve status\` on the target`);
  });
}

/** Neither spelling is a declared argument: the parser refuses them with this reason instead
 *  of as unknown. */
const FUNNEL_REFUSAL =
  "expose tailscale never runs `tailscale funnel` — funnel shares a service with the " +
  "public internet, and this framework keeps the gateway off public ports on purpose " +
  "(.env.example: 0.0.0.0 only behind a reverse proxy with TLS and auth; OpenClaw's " +
  "own guidance keeps the gateway on loopback, reached through Tailscale or an SSH " +
  "tunnel). `tailscale serve` — tailnet-only, what this command prints and applies — " +
  "is the supported path.";

/** The `expose tailscale` action. */
export const EXPOSE_TAILSCALE = defineAction({
  refuse: { "--funnel": FUNNEL_REFUSAL, funnel: FUNNEL_REFUSAL },
  summary: "Tailnet-only HTTPS via `tailscale serve` — never funnel",
  arguments: EXPOSE_TAILSCALE_ARGUMENTS,
  run: runTailscale,
});

const ONLY_TAILSCALE = multiActionBody({ effect: "read", action: { description: "tailscale" }, actions: { tailscale: EXPOSE_TAILSCALE } });

/** Legacy (ctx, argv) entry: the pipeline's parse (refusals included), then run on the given
 *  context. Kept for importers outside this group. */
export async function exposeTailscale(ctx: Context, args: string[]): Promise<void> {
  await runOnContext(ONLY_TAILSCALE, ctx, ["tailscale", ...args], "expose");
}

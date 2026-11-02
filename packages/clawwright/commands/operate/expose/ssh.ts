// `clawwright expose ssh` — the SSH tunnel that reaches a loopback-bound remote gateway, for
// OC_TARGET_LOCATION=ssh deployments (the same shape `deploy` prints once, right after a
// fresh deploy). wsl/local targets need no tunnel at all: Docker Desktop's WSL2 integration
// (or a shared filesystem, for local) already forwards the published port to this machine's
// own loopback.

import { log, info, die, dieWithExitCode, UserError } from "#src/core/io/log.ts";
import { commandLine, renderArguments } from "#src/core/io/invocation/render.ts";
import { spawnLocal } from "#src/runtime/transport/transport.ts";
import { shouldFollow } from "#src/core/io/output.ts";
import type { Context } from "#src/core/context.ts";
import { bind, defineAction, tokenize, type ArgumentSpec, type Values } from "#src/core/command/index.ts";
import * as kinds from "#src/core/values/kinds.ts";

/** The slice of `expose`'s declaration this action's own argv actually uses. */
/** Fixed phrases of the tunnel report, exported so checks assert the same text the product
 *  prints instead of restating it. */
export const NO_TUNNEL_NOTE = "no SSH tunnel needed";
export const SAME_URL_NOTE = "already prints this exact URL";
export const SUBSTITUTE_NOTE = "substitute";
export const TOKEN_UNCHANGED_NOTE = "token from mcp-creds is unchanged";
export const SSH_HOST_UNSET = "OC_SSH_HOST is not set";
export const REAL_TERMINAL_NOTE = "needs a real terminal";
export const TUNNEL_FAILED = "SSH tunnel failed";

export const EXPOSE_SSH_ARGUMENTS = [
  {
    name: "local-port",
    summary: "local port to bind",
    description: "With ssh: local port to bind (defaults to the gateway's own port)",
    kind: "option",
    valueName: "port",
    value: kinds.port(),
  },
  {
    name: "run",
    summary: "Run the tunnel in the foreground",
    description: "With ssh: open the tunnel in the foreground until Ctrl+C; needs a real terminal",
    kind: "flag",
  },
] as const satisfies readonly ArgumentSpec[];

/** `ssh -N`: no remote command, only the forward. `-L <local>:127.0.0.1:<gatewayPort>` reaches
 *  the gateway on the REMOTE host's own loopback — the gateway is never asked to bind
 *  anywhere else, only reached through the tunnel. */
export function sshTunnelCommand(host: string, localPort: string, gatewayPort: string): string[] {
  return ["ssh", "-N", "-L", `${localPort}:127.0.0.1:${gatewayPort}`, host];
}

async function runSsh(ctx: Context, values: Values<typeof EXPOSE_SSH_ARGUMENTS>): Promise<void> {
  if (ctx.transport.sessionScoped === true) throw new UserError("SSJACK_PORT_FORWARDING_UNSUPPORTED");
  const requestedPort = values["local-port"];
  const { run } = values;

  if (ctx.settings.location !== "ssh") {
    log(`${NO_TUNNEL_NOTE} — reach the gateway directly at ${ctx.settings.serviceUrl}`);
    info(`target transport: ${ctx.transport.description} (a local or WSL container's published port is already reachable from this machine)`);
    return;
  }

  const host = ctx.settings.sshHost;
  if (host === "") die(`${SSH_HOST_UNSET}, but OC_TARGET_LOCATION=ssh — set OC_SSH_HOST to user@host`);
  const localPort = requestedPort === undefined ? ctx.settings.gatewayPort : String(requestedPort);
  const command = sshTunnelCommand(host, localPort, ctx.settings.gatewayPort);

  log("SSH tunnel to the remote gateway");
  info(renderArguments(command));
  info(`once open: http://127.0.0.1:${localPort}`);
  info(
    localPort === ctx.settings.gatewayPort
      ? `${commandLine("mcp-creds")} ${SAME_URL_NOTE} (${ctx.settings.serviceUrl}) — it becomes reachable the moment the tunnel is open.`
      : `${commandLine("mcp-creds")} prints ${ctx.settings.serviceUrl} (the remote port) — ${SUBSTITUTE_NOTE} ${localPort} for ${ctx.settings.gatewayPort} in that URL while this tunnel is open.`,
  );
  info(`the gateway ${TOKEN_UNCHANGED_NOTE} — the tunnel only changes how the URL is reached.`);

  if (!run) return;
  if (!shouldFollow()) {
    die(`--run opens a blocking tunnel and ${REAL_TERMINAL_NOTE} — run the printed command yourself, or omit --run to just see it.`);
  }
  log("opening the tunnel (Ctrl+C to stop)...");
  const result = await spawnLocal(command[0], command.slice(1), { stream: true, allowFailure: true });
  if (result.code !== 0) dieWithExitCode(`${TUNNEL_FAILED} (exit ${result.code})`, result.code);
}

/** The `expose ssh` action. */
export const EXPOSE_SSH = defineAction({
  summary: "Print the SSH tunnel to a loopback-bound remote gateway",
  arguments: EXPOSE_SSH_ARGUMENTS,
  run: runSsh,
});

/** Legacy (ctx, argv) entry: parse this action's slice and run on the given context — the
 *  same shape the pipeline's parse stage runs. Kept for importers outside this group. */
export async function exposeSsh(ctx: Context, args: string[]): Promise<void> {
  const values = bind(EXPOSE_SSH_ARGUMENTS, tokenize(EXPOSE_SSH_ARGUMENTS, args)) as Values<typeof EXPOSE_SSH_ARGUMENTS>;
  await runSsh(ctx, values);
}

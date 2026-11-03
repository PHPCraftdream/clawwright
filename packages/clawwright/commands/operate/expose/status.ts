// `clawwright expose status` — and the one-line summary `clawwright status` folds in.
//
// Prefers the PUBLISHED bind address/port read back from the running container
// (runningConnectionFacts(), extended in runtime.ts/runtime-docker.ts to also carry
// bindAddress off the same 18789/tcp entry port already reads) over the configured .env
// value, because .env can be stale the moment OC_BIND_ADDRESS is edited without a container
// recreate — the same class of drift recover-env/facts.ts already exists to catch for the
// other three connection facts (port, data dir, compose project, image). A caller asking "is
// this really loopback-only right now" must not be told so on the strength of a stale file.

import { log, info, warn } from "#src/core/io/log.ts";
import { commandLine } from "#src/core/io/invocation/render.ts";
import { emit, isCaptured } from "#src/core/io/output.ts";
import type { Context } from "#src/core/context.ts";
import { defineAction, type ArgumentSpec, type Values } from "#src/core/command/index.ts";
import { probeTailscale } from "./tailscale.ts";

/** The slice of `expose`'s declaration this action's own argv actually uses. */
export const EXPOSE_STATUS_ARGUMENTS = [
  { name: "json", description: "Exposure report as JSON", kind: "flag" },
] as const satisfies readonly ArgumentSpec[];

/** Fixed phrases of the exposure report, exported so checks assert the same text the
 *  product prints instead of restating it. */
export const CONTAINER_NOT_RUNNING = "container not running";
export const EVERY_INTERFACE_NOTE = "reachable from every interface";
export const NO_SERVE_CONFIG = "no tailscale serve configuration";
export function bindDriftNote(configured: string, running: string): string {
  return `note: the running container differs from configured OC_BIND_ADDRESS=${configured} — ` +
    `run ${commandLine("up")} to recreate the container with the .env value, or explicitly set ` +
    `OC_BIND_ADDRESS=${running} in .env to adopt the running one.`;
}

export interface ExposureSummary {
  readonly bindAddress: string;
  readonly port: string;
  /** False when the container is not running (or this runtime cannot introspect it) and the
   *  fields above fall back to the configured .env values instead. */
  readonly running: boolean;
  readonly loopback: boolean;
  /** 0.0.0.0 or :: — every interface on the host, not just loopback. */
  readonly wildcard: boolean;
}

const LOOPBACK = new Set(["127.0.0.1", "::1"]);
const WILDCARD = new Set(["0.0.0.0", "::"]);

/** `facts` is `runningConnectionFacts()`'s answer (or undefined when not running); the
 *  configured .env values are the fallback, never a guess about what is actually published. */
export function summarizeExposure(
  ctx: Context,
  facts: { bindAddress?: string; port?: string } | undefined,
): ExposureSummary {
  const bindAddress = facts?.bindAddress ?? ctx.settings.bindAddress;
  const port = facts?.port ?? ctx.settings.gatewayPort;
  return {
    bindAddress,
    port,
    running: facts !== undefined,
    loopback: LOOPBACK.has(bindAddress),
    wildcard: WILDCARD.has(bindAddress),
  };
}

/** The one line `clawwright status` folds this command's whole answer into. */
export function exposureOneLiner(summary: ExposureSummary): string {
  const scope = summary.wildcard
    ? `PUBLIC INTERFACE — see ${commandLine(["expose", "status"])}`
    : summary.loopback
      ? "loopback-only"
      : "non-loopback";
  const confirmed = summary.running ? "" : " (not running — configured .env, unconfirmed)";
  return `${summary.bindAddress}:${summary.port} (${scope})${confirmed}`;
}

async function runStatus(ctx: Context, values: Values<typeof EXPOSE_STATUS_ARGUMENTS>): Promise<void> {
  const jsonOnly = values.json === true;
  const facts = await ctx.runtime.runningConnectionFacts?.();
  const summary = summarizeExposure(ctx, facts);

  if (jsonOnly || isCaptured()) {
    await emitExposeStatusReport(ctx, summary, facts);
    return;
  }

  log("gateway exposure");
  info(`published        ${summary.bindAddress}:${summary.port}${summary.running ? "" : ` (${CONTAINER_NOT_RUNNING} — configured .env values, unconfirmed)`}`);
  info(`loopback-only    ${summary.loopback ? "yes" : "no"}`);
  if (summary.running && facts?.bindAddress !== undefined && facts.bindAddress !== ctx.settings.bindAddress) {
    info(bindDriftNote(ctx.settings.bindAddress, facts.bindAddress));
  }
  if (summary.wildcard) {
    warn(`the gateway is published on ${summary.bindAddress} — ${EVERY_INTERFACE_NOTE} on this host, not loopback-only.`);
    warn(
      "put a reverse proxy with TLS and authentication in front of it (see .env.example), or set " +
        `OC_BIND_ADDRESS back to 127.0.0.1, run ${commandLine("up")} to apply it, and use ` +
        `${commandLine(["expose", "ssh"])} or ${commandLine(["expose", "tailscale"])} instead.`,
    );
  } else if (!summary.loopback) {
    warn(`the gateway is published on ${summary.bindAddress}, not a recognized loopback address — confirm this is intentional.`);
  }

  log("tailscale");
  const probe = await probeTailscale(ctx);
  info(probe.detail);
  if (!probe.present) return;

  const serveStatus = await ctx.transport.exec("tailscale", ["serve", "status"], { allowFailure: true });
  if (serveStatus.code !== 0) {
    info(`tailscale serve status could not be read (exit ${serveStatus.code})`);
    return;
  }
  const text = serveStatus.stdout.trim();
  if (text === "") info(NO_SERVE_CONFIG);
  else for (const line of text.split("\n")) info(line);
}

/** The `expose status` action. */
export const EXPOSE_STATUS = defineAction({
  summary: "What is published right now, and whether it is loopback-only",
  arguments: EXPOSE_STATUS_ARGUMENTS,
  run: runStatus,
});

/** The machine-readable counterpart of the text path above, with the same facts. */
async function emitExposeStatusReport(
  ctx: Context,
  summary: ExposureSummary,
  facts: { bindAddress?: string; port?: string } | undefined,
): Promise<void> {
  const bindAddressDrift = summary.running && facts?.bindAddress !== undefined && facts.bindAddress !== ctx.settings.bindAddress;

  const probe = await probeTailscale(ctx);
  let serveStatus: string[] | null = null;
  let serveStatusError: string | null = null;
  if (probe.present) {
    const result = await ctx.transport.exec("tailscale", ["serve", "status"], { allowFailure: true });
    if (result.code !== 0) {
      serveStatusError = `exit ${result.code}`;
    } else {
      const text = result.stdout.trim();
      serveStatus = text === "" ? [] : text.split("\n");
    }
  }

  emit(
    `${JSON.stringify(
      {
        exposure: summary,
        configuredBindAddress: ctx.settings.bindAddress,
        bindAddressDrift,
        tailscale: {
          present: probe.present,
          loggedIn: probe.loggedIn,
          detail: probe.detail,
          serveStatus,
          serveStatusError,
        },
      },
      null,
      2,
    )}\n`,
  );
}

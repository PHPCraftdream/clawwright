// Transport: how the tooling reaches the machine the instance lives on.
//
// This is the abstraction that lets the same code run from Windows, from WSL, or against a
// server: "where our code executes" and "where the target lives" are different things (the
// Windows Node reaches a WSL target through wsl.exe), and nothing above this layer needs to
// know that.
//
// This file is the module's public entry point; the contract and every implementation
// (exec.ts, quoting.ts, local.ts, wsl.ts, remote/ssh.ts) are re-exported here, and this file
// assembles a Transport from a TransportConfig.
//
// Rule for everything built on top: never touch target files with node:fs directly. The
// target may not share a filesystem with us. Go through the transport.

import { die, UserError } from "../../core/io/log.ts";
import { manual } from "../../core/io/invocation/advice.ts";
import { DEFAULT_WSL_DISTRO } from "../../core/env.ts";
import type { Transport } from "./exec.ts";
import { LocalTransport } from "./local.ts";
import { WslTransport } from "./wsl.ts";
import { SshTransport } from "./remote/ssh.ts";
import { SsjackClient, ssjackBootstrap } from "./remote/ssjack-client.ts";
import { SsjackTransport } from "./remote/ssjack.ts";

export type { ExecOptions, ExecResult, CommandFailure, Transport } from "./exec.ts";
export { spawnLocal, TransportUnreachableError, isWrapperFailureCode, toSignedExitCode } from "./exec.ts";
export { tarLocalFlags, tarLocalPath, tarFlagRejected, TAR_REMOTE_HOST_NOISE } from "./exec.ts";
export { PRIVATE_STAGING_MARKER, PUBLISH_STAGING_MARKER, withEnvPrefix, existsVia } from "./quoting.ts";
export { LocalTransport } from "./local.ts";
export { WslTransport, stripWslNuls } from "./wsl.ts";
export { SshTransport } from "./remote/ssh.ts";
export { SsjackTransport } from "./remote/ssjack.ts";
export { listFilesVia } from "../../security/transport-listing.ts";
export type { TargetRead } from "./quoting.ts";
export { TargetReadUnknownError, listIfExists, probeExists, probeEntryExists, readIfExists } from "./quoting.ts";
export { describeInvocation } from "./spawn-failure.ts";

export interface TransportConfig {
  location?: string;
  wslDistro?: string;
  sshHost?: string;
  /** Host OS for the `local`/`auto` refusal; injectable for checks. A `string`, not
   *  `NodeJS.Platform`: this is public API and consumers may have no `@types/node`. */
  platform?: string;
}

/** The host OS createTransport judges by. Checks swap `current` to exercise the matrix, or to run
 *  fixtures that never touch a target through `local` on any host. */
export const hostPlatform: { current: string } = { current: process.platform };

/** A `local` target runs GNU/Linux-specific commands (`find -printf`, `stat -c`, `readlink -f`,
 *  `tar --numeric-owner`, `/proc`, `/srv`), so only a Linux host can be one. A UserError carrying
 *  the remedy as advice: the message is the headline, the arrow line is rendered per surface
 *  (formatError, the --json/MCP failure contract) — not baked into the message. */
export class LocalTargetUnsupportedError extends UserError {
  readonly nextAction: string;
  constructor(message: string, nextAction: string) {
    super(message, { advice: [manual(nextAction)] });
    this.name = "LocalTargetUnsupportedError";
    this.nextAction = nextAction;
  }
}

/** Refuses before any transport is built or anything runs on a target. */
function refuseLocalTarget(platform: string): never {
  const nextAction = platform === "win32"
    ? "set OC_TARGET_LOCATION=wsl (with OC_WSL_DISTRO naming a WSL2 distro), or OC_TARGET_LOCATION=ssh with OC_SSH_HOST=user@host"
    : "set OC_TARGET_LOCATION=ssh with OC_SSH_HOST=user@host";
  throw new LocalTargetUnsupportedError(
    `LOCAL_TARGET_UNSUPPORTED  this host is ${platform}, and a local target needs Linux ` +
    "(target commands are GNU/Linux-specific: find -printf, stat -c, readlink -f, sha256sum, " +
    `tar --numeric-owner, /proc, /srv)`,
    nextAction,
  );
}

/**
 * Pick a verified keeper for auto when its child context is supplied; otherwise keep
 * platform defaults. Explicit ssjack requires context, while explicit standalone targets
 * remain explicit. Invalid or disconnected supplied context never falls back to SSH.
 */
export async function createTransport(config: TransportConfig = {}): Promise<Transport> {
  const location = (config.location ?? "auto").toLowerCase();
  const distro = config.wslDistro ?? DEFAULT_WSL_DISTRO;
  const platform = config.platform ?? hostPlatform.current;

  if (location === "auto" || location === "ssjack") {
    const bootstrap = ssjackBootstrap();
    if (bootstrap !== undefined) {
      const client = new SsjackClient(bootstrap);
      const info = await client.info();
      return new SsjackTransport(client, info.profile);
    }
    if (location === "ssjack") throw new UserError("SSJACK_CONTEXT_REQUIRED");
  }

  switch (location) {
    case "local":
      if (platform !== "linux") refuseLocalTarget(platform);
      return new LocalTransport();
    case "wsl":
      return new WslTransport(distro);
    case "ssh": {
      const host = config.sshHost;
      if (host === undefined || host === "") {
        die("OC_TARGET_LOCATION=ssh requires OC_SSH_HOST (user@host)");
      }
      return new SshTransport(host);
    }
    case "auto":
      if (platform === "win32") return new WslTransport(distro);
      if (platform !== "linux") refuseLocalTarget(platform);
      return new LocalTransport();
    default:
      return die(`unknown target location: ${location} (expected local, wsl, ssh, ssjack or auto)`);
  }
}

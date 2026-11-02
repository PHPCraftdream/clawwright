// `clawwright expose` — reach a loopback-bound gateway from outside this host, choosing the
// narrowest sensible scope: an SSH tunnel (ssh targets), `tailscale serve` (tailnet-only,
// never `funnel`), or a status report of what is actually published right now.
//
// Lives in commands/operate/ with watch/, incident/, recover-env/: things an operator runs
// against an already-deployed instance. Wired into the group file the same as every other
// command — help grouping there is by operator intent, independent of this directory.

import { multiActionBody } from "#src/core/command/index.ts";
import { EXPOSE_SSH } from "./ssh.ts";
import { EXPOSE_TAILSCALE } from "./tailscale.ts";
import { EXPOSE_STATUS } from "./status.ts";

export { summarizeExposure, exposureOneLiner, EXPOSE_STATUS_ARGUMENTS, EXPOSE_STATUS } from "./status.ts";
export type { ExposureSummary } from "./status.ts";
export { EXPOSE_SSH_ARGUMENTS, EXPOSE_SSH } from "./ssh.ts";
export { EXPOSE_TAILSCALE_ARGUMENTS, EXPOSE_TAILSCALE } from "./tailscale.ts";

/** Only `tailscale --apply` mutates anything (runs `tailscale serve` on the target); ssh and
 *  status only read and print. The declaration carries that: the actions' base effect is
 *  read, and --apply's effect raises the call to destroy — confirmation and the lock follow
 *  from it instead of an argv predicate. */
export const EXPOSE = multiActionBody({
  effect: "read",
  action: { description: "ssh, tailscale or status" },
  actions: {
    ssh: EXPOSE_SSH,
    tailscale: EXPOSE_TAILSCALE,
    status: EXPOSE_STATUS,
  },
});

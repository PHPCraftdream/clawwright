// `clawwright watch` — health monitoring with a webhook alert on state change, so an operator
// learns the instance stopped doing its job without polling by hand.
//
// Lives in commands/operate/ with expose/, incident/ and recover-env/ — see expose/index.ts's
// own header for the grouping this and its siblings share.

import { multiActionBody } from "../../../core/command/index.ts";
import { WATCH_CHECK, WATCH_TEST } from "./check.ts";
import { WATCH_INSTALL, WATCH_UNINSTALL } from "./install.ts";
import { WATCH_STATUS } from "./status.ts";

export { watchLevel, runWatchCycle, resolveWatchOutcome, WATCH_CHECK, WATCH_TEST } from "./check.ts";
export type { WatchLevel, WatchReason, WatchState } from "./state.ts";
export { WATCH_INSTALL, WATCH_UNINSTALL } from "./install.ts";
export { WATCH_STATUS } from "./status.ts";

/** Only install/uninstall --apply mutate the target (a crontab entry); check, status and test
 *  only read the instance and this deployment's own state file — test reaches an external
 *  webhook/heartbeat URL, never the target itself. The declaration carries that: those two
 *  actions' --apply flag has effect destroy, everything else stays at the body's read. */
export const WATCH = multiActionBody({
  effect: "read",
  action: { description: "check, install, uninstall, status or test" },
  actions: {
    check: WATCH_CHECK,
    install: WATCH_INSTALL,
    uninstall: WATCH_UNINSTALL,
    status: WATCH_STATUS,
    test: WATCH_TEST,
  },
});

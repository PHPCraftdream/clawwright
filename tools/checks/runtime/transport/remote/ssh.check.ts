// check:requires ssh-loopback
// The shared transport contract against a real SshTransport to OC_CHECK_SSH_HOST (default
// localhost) — the loopback sshd the CI job provisions (key-based, non-interactive: `ssh -o
// BatchMode=yes -o ConnectTimeout=5 <host> true`, the exact probe behind the ssh-loopback
// capability). Every command the shared suite runs is POSIX-sh only, so any Linux/macOS sshd
// with a GNU userland works here too, not only the CI one.

import { SshTransport } from "#framework/runtime/transport/transport.ts";
import { runTransportScenarios } from "../scenarios/contract.ts";
import { finish } from "#checks/kit/harness.ts";

const host = process.env.OC_CHECK_SSH_HOST ?? "localhost";

await runTransportScenarios("ssh", () => new SshTransport(host), {
  // ssh(1) accepts an ssh:// URI as its destination, port included, so an unreachable target
  // needs no change to SshTransport's single-string host — a closed loopback port refuses the
  // connection immediately instead of timing out.
  makeUnreachableTransport: () => new SshTransport("ssh://127.0.0.1:1"),
});

finish("transport contract: ssh");

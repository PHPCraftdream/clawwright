// Where the data directory appears inside the OpenClaw container.
//
// Application data, not framework knowledge: which host directory shows up at which path
// inside the container is a property of the image being run. These values mirror
// docker-compose.yml (OPENCLAW_STATE_DIR and friends) and are constants of the image.

import type { MountPoint } from "../core/paths.ts";

export const containerPaths = {
  home: "/home/node",
  state: "/home/node/.openclaw",
  workspace: "/home/node/.openclaw/workspace",
  authSecrets: "/home/node/.config/openclaw",
} as const;

/** The bind mounts, derived from the data directory.
 *
 *  Nesting is deliberate and matters: workspace lives inside the state mount, so path
 *  translation has to prefer the longest match. */
export function mountPoints(dataDir: string): MountPoint[] {
  const root = dataDir.replace(/\/+$/, "");
  return [
    { target: `${root}/config`, container: containerPaths.state },
    { target: `${root}/workspace`, container: containerPaths.workspace },
    { target: `${root}/auth-secrets`, container: containerPaths.authSecrets },
  ];
}

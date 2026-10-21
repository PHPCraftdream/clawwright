// Pre-mutation evidence for the `incident` command's "preserve" phase.

import type { Transport } from "../transport/transport.ts";
import { formatLogRecords, mergeLogStreams } from "./compose-operations.ts";

/** `docker inspect` output with every Config.Env value replaced: the container environment
 *  carries the gateway token and provider keys, and evidence must name them, not hold them.
 *  Unparseable output is withheld entirely rather than written raw. */
export function redactInspectEnv(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "(docker inspect output withheld: not parseable, so its environment could not be redacted)";
  }
  for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
    const config = (entry as { Config?: { Env?: unknown } } | null)?.Config;
    if (config !== undefined && Array.isArray(config.Env)) {
      config.Env = config.Env.map((line) => (typeof line === "string" ? `${line.split("=")[0]}=<redacted>` : line));
    }
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

/** A log tail plus the redacted `docker inspect` record for `containerId`, read before a
 *  recreate removes the container and its log. Undefined when there is no container; a half
 *  that failed is reported inline instead of losing the half that worked. */
export async function captureIncidentSnapshot(
  transport: Transport,
  containerId: string | undefined,
  tail: string,
): Promise<{ logs: string; inspect: string } | undefined> {
  if (containerId === undefined) return undefined;
  const [logs, inspect] = await Promise.all([
    transport.exec("docker", ["logs", "--timestamps", "--tail", tail, containerId], { allowFailure: true }),
    transport.exec("docker", ["inspect", containerId], { allowFailure: true }),
  ]);
  if (logs.code !== 0 && inspect.code !== 0) return undefined;
  return {
    logs: logs.code === 0 ? formatLogRecords(mergeLogStreams(logs.stdout, logs.stderr, Number(tail))) : `(could not read logs: exit ${logs.code})`,
    inspect: inspect.code === 0 ? redactInspectEnv(inspect.stdout) : `(could not inspect: exit ${inspect.code})`,
  };
}

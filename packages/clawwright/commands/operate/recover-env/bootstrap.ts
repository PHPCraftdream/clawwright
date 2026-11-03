// Recovery's own bootstrap: the running container's connection facts, read with nothing
// but a transport and the project identity.
//
// The normal dispatch builds a full Context validated from .env, OC_DATA_DIR above all —
// but recovery exists to repair exactly that file, so when a fact is missing, the Context
// the dispatcher demands cannot be built. This path needs none of what failed: the container
// is found by the compose labels Docker wrote on it at creation (project and service), with
// no compose invocation, no env file written, no path bridge, no data directory in the read.
// The transport still comes from .env's location settings — reaching the target at all
// requires them.

import type { Env } from "#src/core/env.ts";
import { composeProjectName, useComposeProjectOverride } from "#src/runtime/deployment.ts";
import { UserError } from "#src/core/io/log.ts";
import { TargetReadUnknownError, TransportUnreachableError, type Transport } from "#src/runtime/transport/transport.ts";
import { command } from "#src/core/io/invocation/advice.ts";
import { connectionFactsFromInspect, type ConnectionFacts } from "./facts.ts";

// Retry the recovery read without demanding the connection facts it exists to repair.
class RecoveryReadUnknownError extends TargetReadUnknownError {
  override readonly advice = [command(["recover-env", "--dry-run"])];
}

// The two labels compose writes on every container it creates. `compose ps` filters by
// the same pair; asking Docker directly is what lets the lookup run without compose —
// and without the env file and project directory a compose invocation would demand.
const PROJECT_LABEL = "com.docker.compose.project";
const SERVICE_LABEL = "com.docker.compose.service";

/** Reads the running container's connection facts without a Context. Undefined means
 *  definite absence: no matching containers, or valid inspected containers are stopped.
 *  Unknown listing/inspection answers throw with advice, unless a later match supplies
 *  facts. Unreachable targets and advised refusals propagate unchanged. */
export async function runningConnectionFactsWithoutContext(options: {
  /** The parsed .env — read for the compose project override and nothing else. */
  env: Env;
  transport: Transport;
  /** The compose service the deployment operates (the context defaults an application's
   *  unnamed service to "app"; so does this). */
  service: string;
}): Promise<ConnectionFacts | undefined> {
  // The same override rule the context applies when it is built: an instance managed
  // under a compose project name the deployment directory itself cannot have keeps its
  // real name instead of being forced to rename.
  useComposeProjectOverride(options.env.OC_COMPOSE_PROJECT === "" ? undefined : options.env.OC_COMPOSE_PROJECT);

  let listed: { code: number; stdout: string };
  try {
    listed = await options.transport.exec("docker", [
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `label=${PROJECT_LABEL}=${composeProjectName()}`,
      "--filter",
      `label=${SERVICE_LABEL}=${options.service}`,
    ]);
  } catch (error) {
    // An unreachable target is not a docker-not-running answer: the transport's typed
    // refusal carries the real next step (rf6-fix30) and reaches the caller as itself.
    if (error instanceof TransportUnreachableError || (error instanceof UserError && error.advice.length > 0)) throw error;
    throw new RecoveryReadUnknownError(`could not list recovery containers on the target: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (listed.code !== 0) throw new RecoveryReadUnknownError(`could not list recovery containers on the target: docker ps exited with code ${listed.code}`);
  const containerIds = listed.stdout.split(/\r?\n/).map((id) => id.trim()).filter((id) => id !== "");

  // `docker ps --all` puts stopped instances in this result too. A stale stopped
  // container can precede the current one, so inspect every match until a running
  // container supplies the facts; an inspect failure for one old ID does not hide it.
  let unknown: TargetReadUnknownError | undefined;
  for (const containerId of containerIds) {
    let inspected: { code: number; stdout: string };
    try {
      inspected = await options.transport.exec(
        "docker",
        ["inspect", "--format", "{{json .}}", containerId],
        { allowFailure: true },
      );
    } catch (error) {
      if (error instanceof TransportUnreachableError || (error instanceof UserError && error.advice.length > 0)) throw error;
      unknown ??= new RecoveryReadUnknownError(`could not inspect recovery container ${containerId} on the target: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      continue;
    }
    if (inspected.code !== 0) {
      unknown ??= new RecoveryReadUnknownError(`could not inspect recovery container ${containerId} on the target: docker inspect exited with code ${inspected.code}`);
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(inspected.stdout);
      // The facts parser returns undefined for both stopped containers and invalid State.
      // Only an explicit boolean Running is a definite answer; optional facts stay optional.
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) ||
        typeof (parsed as { State?: { Running?: unknown } }).State?.Running !== "boolean") {
        throw new Error("malformed recovery container inspection: expected State.Running boolean");
      }
      const facts = connectionFactsFromInspect(parsed);
      if (facts !== undefined) return facts;
    } catch (error) {
      if (error instanceof TransportUnreachableError || (error instanceof UserError && error.advice.length > 0)) throw error;
      // Preserve the first unknown answer while still trying remaining candidates.
      unknown ??= new RecoveryReadUnknownError(`could not inspect recovery container ${containerId} on the target: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  if (unknown !== undefined) throw unknown;
  return undefined;
}

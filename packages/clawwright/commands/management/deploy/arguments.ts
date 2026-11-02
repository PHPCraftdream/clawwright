// Resolves what deploy() needs to know before anything remote runs: the source tree, the
// parsed --target/--path/--adopt/--no-bootstrap, and the two remote paths derived from them.

import { die } from "#src/core/io/log.ts";
import { renderAdvice } from "#src/core/io/invocation/render.ts";
import { targetFrame } from "#src/core/io/invocation/frame.ts";
import { command, shellLine } from "#src/core/io/invocation/advice.ts";
import { monorepoRoot, isMonorepoCheckout, DEFAULT_REMOTE_PATH } from "#src/core/env.ts";
import { deploymentDir, recipesDir, applicationRecipesSetting } from "#src/runtime/deployment.ts";
import { validatedRemoteRoot } from "#src/security/privacy/deploy-boundary.ts";
import type { Context } from "#src/core/context.ts";
import { isAbsolute, relative, sep, win32 } from "node:path";
import type { ArgumentSpec, Values, LocalScope } from "#src/core/command/index.ts";
import * as kinds from "#src/core/values/kinds.ts";

export const DEPLOY_ARGUMENTS = [
  { name: "target", description: "user@host", kind: "positional", required: true, value: kinds.sshDestination() },
  {
    name: "path",
    summary: "Remote install directory",
    description: "Remote install directory (default: OC_REMOTE_PATH)",
    kind: "option",
    valueName: "path",
    value: kinds.absolutePath(),
  },
  { name: "no-bootstrap", description: "Copy files without starting", kind: "flag" },
  {
    name: "adopt",
    summary: "Adopt an unmarked remote root",
    description:
      "Take over an existing, unmarked, non-empty remote root: lists what --delete would " +
      "replace there before marking it as this deployment's",
    kind: "flag",
  },
  { name: "dry-run", description: "What would happen", kind: "flag", effect: "read" },
  { name: "json", description: "Outcome as JSON", kind: "flag" },
] as const satisfies readonly ArgumentSpec[];

/** The tree this command mirrors, refusing rather than guessing when there is none.
 *
 *  Exported with the root as a parameter so both branches can be checked against real
 *  directories, not just the one this checkout happens to be in. */
export const INSTALLED_PACKAGE_MODE = "the framework is running from an installed package";

export async function frameworkSourceRoot(root: string = monorepoRoot): Promise<string> {
  // Check-only seam (stage 7 S0.4): a check process sets CLAWWRIGHT_CHECKS_SOURCE_ROOT so
  // the deploy preflight scans a temp source tree; nothing user-facing sets it, so unset
  // means the checkout itself.
  const override = process.env["CLAWWRIGHT_CHECKS_SOURCE_ROOT"];
  if (override !== undefined && override !== "") root = override;
  if (!(await isMonorepoCheckout(root))) {
    // The bootstrap line runs on the SERVER, so it is spelled for that host, not for
    // wherever this run stands (rf6-fix33): the shim's own spelling — under a Windows
    // local-package copy this run's program names a node_modules wrapper the server has
    // none of. A shell row, so no surface re-spells it for the local invocation.
    die(
      "deploy mirrors a Clawwright checkout to the server with rsync, and there is no " +
        `checkout here — ${INSTALLED_PACKAGE_MODE}\n` +
        "Deploying in this mode means installing @phpcraftdream/clawwright on the server and " +
        "sending only this deployment's own files, which is a different command and does " +
        "not exist yet. Deploy from a checkout, or copy this deployment's directory across " +
        "and run the bootstrap there:",
      // The bootstrap runs on the SERVER: spelled by the remote checkout's own frame
      // (S1.5b), never by this run's launch (R19-10).
      shellLine("posix", renderAdvice(command("bootstrap"), targetFrame({ kind: "checkout-shim", root: "" }, "posix"))),
    );
  }
  return root;
}

/** Maps the local recipe root to the remote deployment without escaping its directory:
 *  the remote-relative part only — the caller joins it under its own remote app path.
 *  The refusals are local facts, so the prepare stage raises them (stage 7 S2.5). */
export function recipesRelocation(): string {
  const setting = applicationRecipesSetting();
  if (setting === undefined) return "recipes";

  if (isAbsolute(setting) || win32.isAbsolute(setting)) {
    die(
      `deploy cannot send an absolute recipesDir (${setting}) safely: it is local to this machine. ` +
        "Use a path relative to the deployment, or copy the recipes into that deployment first.",
    );
  }

  const local = recipesDir();
  const fromDeployment = relative(deploymentDir(), local);
  if (
    fromDeployment === "" ||
    fromDeployment === ".." ||
    fromDeployment.startsWith(`..${sep}`) ||
    fromDeployment.startsWith(`..${win32.sep}`) ||
    isAbsolute(fromDeployment) ||
    win32.isAbsolute(fromDeployment)
  ) {
    die(
      `deploy cannot send recipesDir (${setting}) because it resolves outside the deployment. ` +
        "Use a path inside the deployment, or copy the recipes into that deployment first.",
    );
  }

  const remoteRelative = fromDeployment.replaceAll("\\", "/");
  const [root] = remoteRelative.toLowerCase().split("/");
  if (["secrets", "data", "backups", "snapshots", ".env"].includes(root ?? "")) {
    die(
      `deploy cannot send recipesDir (${setting}) from a private deployment root. ` +
        "Keep recipes outside secrets/, data/, backups/, snapshots/ and .env.",
    );
  }
  return remoteRelative;
}

/** Everything deploy() derives from the bound arguments before any tool check, connection
 *  or scan. The parser has already refused a missing target; what stays here needs the
 *  Context's settings (the default remote path) and the local deployment layout. */
export interface DeployPlan {
  target: string;
  remotePath: string;
  remotePathNote: string | undefined;
  runBootstrap: boolean;
  adopt: boolean;
  dryRun: boolean;
  jsonOnly: boolean;
  name: string;
  remoteApp: string;
  remoteRecipes: string;
}

export function resolveDeployArguments(ctx: Context, prepared: DeployPrepared): DeployPlan {
  const { target, sourceRoot: _sourceRoot, name: _name, recipesRelative: _recipesRelative, ...values } = prepared;
  const requestedPath = values.path;
  // The path the run actually uses is the layered one: --path over ctx.settings.remotePath
  // (app settings layered under .env in buildSettings). Prepare validated the .env default
  // and carries its normalized result; when the layered value is those same bytes the
  // prepared value is reused, and only a different layered value is validated here — the
  // kind and the two validations between them judge every distinct path exactly once
  // (stage 7 S2.5).
  const requested = requestedPath ?? ctx.settings.remotePath;
  const remotePath = requested === prepared.remotePathValidated
    ? prepared.remotePathValidated
    : validatedRemoteRoot(requested);
  const runBootstrap = values["no-bootstrap"] !== true;
  const adopt = values.adopt === true;
  const dryRun = values["dry-run"] === true;
  const jsonOnly = values.json === true;

  // Later commands (watch install) read OC_REMOTE_PATH, not --path.
  const remotePathNote = requestedPath !== undefined && requestedPath !== ctx.settings.remotePath
    ? `--path ${remotePath} differs from OC_REMOTE_PATH (${ctx.settings.remotePath}) in this deployment's ` +
      `.env — set OC_REMOTE_PATH=${remotePath} there, since watch install and other remote-side commands ` +
      "read it, not --path."
    : undefined;

  const name = prepared.name;
  const remoteApp = `${remotePath}/apps/${name}`;
  // Derived at the prepare stage, where its refusals are local facts.
  const remoteRecipes = `${remoteApp}/${prepared.recipesRelative}`;

  return { target, remotePath, remotePathNote, runBootstrap, adopt, dryRun, jsonOnly, name, remoteApp, remoteRecipes };
}

/** The local facts the prepare stage derives and the plan carries into run (stage 7 S2.5):
 *  the mirrored checkout, this deployment's name, and where its recipes relocate remotely.
 *  Each can refuse — the checkout sentence, the remote-root sentence, the recipesDir
 *  sentences — and every one of those refusals is a local fact, so they are raised in
 *  prepare, before any Context, environment preparation or target contact. */
export interface DeployLocalFacts {
  sourceRoot: string;
  name: string;
  recipesRelative: string;
  /** The .env-default side of the remote path, as validatedRemoteRoot normalized it. When
   *  the run path's layered value (--path or ctx.settings.remotePath) is these same bytes,
   *  run reuses this value instead of validating again. */
  remotePathValidated: string;
}

/** Derives the local facts, in the run path's former order so a refusal arrives exactly as
 *  it did — only one stage earlier. The remote-root sentence is judged against the .env
 *  default when no --path was given (the kind refuses a given --path at parse), so a bad
 *  OC_REMOTE_PATH in .env is still refused, now at prepare; the normalized result is
 *  carried so run only re-validates a layered path that differs from it. The plan is
 *  the bound values plus the derived facts. */
export type DeployPrepared = Values<typeof DEPLOY_ARGUMENTS> & DeployLocalFacts;

export async function deriveDeployLocalFacts(values: Values<typeof DEPLOY_ARGUMENTS>, local: LocalScope): Promise<DeployPrepared> {
  const env = await local.env();
  const sourceRoot = await frameworkSourceRoot();
  const remotePathValidated = validatedRemoteRoot(values.path ?? env?.["OC_REMOTE_PATH"] ?? DEFAULT_REMOTE_PATH);
  const name = local.deployment().name;
  const recipesRelative = recipesRelocation();
  return { ...values, sourceRoot, name, recipesRelative, remotePathValidated };
}

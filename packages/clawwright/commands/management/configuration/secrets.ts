// `clawwright secrets` — which secrets this instance needs and whether they are in place.
//
// Answers the question that otherwise only surfaces as a crash-loop: the gateway refuses to
// start when a referenced variable is missing, and the reason is buried in its log as
// SecretRefResolutionError.

import { writeFile, readFile, access } from "node:fs/promises";
import { log, info, warn, die } from "#src/core/io/log.ts";
import { commandLine } from "#src/core/io/invocation/render.ts";
import { emit, emitRaw, isCaptured } from "#src/core/io/output.ts";
import { parseEnv, serializeEnvLine, readEnvFileText } from "#src/core/env.ts";
import * as kinds from "#src/core/values/kinds.ts";
import { createName, readName } from "#src/core/values/names.ts";
import { envFile, secretsTemplateFile, secretStoreFile, secretsDir } from "#src/runtime/deployment.ts";
import type { Context } from "#src/core/context.ts";
import { missing, requirements, requirementsForConfig, status, template } from "#src/service/secrets.ts";
import type { SecretLocation, SecretRequirement } from "#src/service/secrets.ts";
import { loadSecrets, dumpSecrets } from "#src/commands/lifecycle/state.ts";
import { secretsFileOnTarget } from "#src/runtime/files/datadir.ts";
import { createPrivateFile, protectPrivateDirectory, protectPrivateFile, replacePrivateFile, unprotectedPrivateFile } from "#src/security/privacy/private-file.ts";
import { upsertEnvValue } from "#src/security/privacy/private-config.ts";
import { guardedWith } from "#src/runtime/lock/instance-lock.ts";
import { requireBootstrapped } from "#src/runtime/runtime.ts";
import { commandBody, runOnContext } from "#src/core/command/index.ts";
import type { ArgumentSpec, Values } from "#src/core/command/index.ts";
import { BREAK_FOREIGN_LOCK_ARGUMENT } from "#src/commands/interface/groups/shared-arguments.ts";
import { prospectiveConfig, readLiveConfigOrThrow, readDeclaredConfig } from "#src/commands/orchestration/inspect/helpers.ts";

export const SECRETS_ARGUMENTS = [
  { name: "template", description: "Write template into config/", kind: "flag", effect: "change" },
  { name: "print-template", description: "Template only", kind: "flag", effect: "read" },
  { name: "init-store", description: "Create an empty store", kind: "flag", effect: "destroy" },
  { name: "apply", description: "Fill the target from a store", kind: "flag", effect: "destroy" },
  { name: "dump", description: "Save target values to a store", kind: "flag", effect: "destroy" },
  { name: "store", description: "Store name, e.g. local or prod", kind: "option", valueName: "name", value: kinds.name("store", "read") },
  {
    name: "force",
    summary: "Replace an existing store",
    description: "Replace an existing store (with --init-store or --dump)",
    kind: "flag",
  },
  // Only --apply takes the lock; --break-lock stays unsupported, but an orphaned lock from
  // another machine still needs a way out.
  BREAK_FOREIGN_LOCK_ARGUMENT,
  {
    name: "json",
    summary: "Emit the default read-only report as JSON",
    description: "Emit the default read-only report as JSON (names/state/where-found only, never values) — refused with --template/--print-template/--init-store/--apply/--dump",
    kind: "flag",
  },
] as const satisfies readonly ArgumentSpec[];

/** The store `secrets` commands write and read when no --store is given — and the one
 *  store inspect's STORE_INCOMPLETE finding watches, since inspect takes no store name. */
export const DEFAULT_SECRET_STORE = "local";

/** Fixed phrases of the secrets report, exported so checks assert the same text the product
 *  prints instead of restating it. */
export const NOT_OWNER_ONLY = "is not owner-only";
export const HAS_NOT_READ = "has not read";
export const INSTANCE_STOPPED_NOTE = "the instance is stopped";
export const INSTANCE_NOT_RUNNING_NOTE = "the instance is not running";
export const RECREATE_NOTE = "recreate the container";
export const REPLACED_NOTE = "replaced, not merely signalled";
export const DOES_NOT_HOLD = "does not hold";
export const CANNOT_READ_RUNNING_ENV = "cannot read a running container's own environment";

/** Reads a local store file, dying with the store's own fix-it message — usable before any
 *  lock or transport call, so a typo in --store refuses locally. */
async function readStoreOrDie(storeName: string): Promise<string> {
  const path = secretStoreFile(readName("store", storeName));

  try {
    return await readFile(path, "utf8");
  } catch {
    die(
      `${path} not found — create it with ${commandLine(["secrets", "--init-store", "--store", storeName])}, ` +
        "or pass a different --store <name>",
    );
  }
}

/** Delivers a local store to each declared secret location, refusing incomplete input. */
async function applyStore(ctx: Context, storeName: string): Promise<void> {
  const path = secretStoreFile(readName("store", storeName));
  const raw = await readStoreOrDie(storeName);

  // Reported, not refused: reading a store neither causes nor deepens an exposure, and
  // refusing would leave the keys uninstallable while the fix stays a manual step anyway.
  const exposure = await unprotectedPrivateFile(path);
  if (exposure !== undefined) {
    warn(`${path} ${NOT_OWNER_ONLY} (${exposure}) — anyone this machine's ACLs allow can read the keys in it`);
  }

  const values = parseEnv(raw, path);
  // Asked of the PROSPECTIVE config (live + declared overlay), not live alone: a secret a
  // not-yet-applied desired-state.json is about to need is a real requirement here too —
  // otherwise a newly declared provider key computed an empty `needed` and loadSecrets()
  // refused with "empty secrets file" despite the value sitting in the store.
  //
  // readLiveConfigOrThrow(), not readLiveConfigForProspective(): about to WRITE config/.env
  // from `needed`, so a transient read failure must abort rather than silently degrade to
  // an empty base, which would compute an incomplete list and delete secrets on write.
  const prospective = prospectiveConfig(await readLiveConfigOrThrow(ctx), await readDeclaredConfig());
  const needed = await requirementsForConfig(ctx, prospective);

  const absent = needed.filter((entry) => {
    if (!entry.required) return false;
    const value = values[entry.name];
    return value === undefined || value.trim() === "";
  });
  if (absent.length > 0) {
    for (const entry of absent) warn(`${path} has no value for ${entry.name} (${entry.usedBy})`);
    die(`${absent.length} value(s) missing in ${path}`);
  }

  const supplied = needed.filter((entry) => {
    const value = values[entry.name];
    return value !== undefined && value.trim() !== "";
  });
  const targetSupplied = supplied.filter((entry) => entry.location === "target-env");
  const repoSupplied = supplied.filter((entry) => entry.location === "repo-env");
  if (targetSupplied.length === 0 && repoSupplied.length === 0) {
    log(`no target secrets to apply from ${path}`);
    return;
  }

  // config/.env is REPLACED, not merged: the required list becomes the whole file. Anything
  // put there by hand and not part of the requirements disappears, so removed names are
  // warned about below — a variable that vanishes silently is one nobody puts back.
  const current = targetSupplied.length > 0 ? await dumpSecrets(ctx) : undefined;
  if (current !== undefined) {
    const keep = new Set(targetSupplied.map((entry) => entry.name));
    const dropped = Object.keys(parseEnv(current, secretsFileOnTarget(ctx))).filter((name) => !keep.has(name));
    if (dropped.length > 0) {
      warn(`${secretsFileOnTarget(ctx)} also holds ${dropped.length} variable(s) not supplied by ${path}, which this replaces:`);
      for (const name of dropped) info(name);
      info(`add them to ${path} if the instance needs them`);
    }
  }

  if (targetSupplied.length > 0) {
    const content = targetSupplied.map((entry) => serializeEnvLine(entry.name, values[entry.name] ?? "")).join("\n");
    await loadSecrets(ctx, `${content}\n`);
    log(`applied ${targetSupplied.length} target value(s) from ${path}`);
    // Written to disk but not READ yet: config/.env is a bind-mounted file, not an
    // env_file declaration, so `up` converges on the already-running container instead of
    // picking it up.
    const target = secretsFileOnTarget(ctx);
    if (await ctx.runtime.isRunning()) {
      info(`${target} holds the new values, but the running instance ${HAS_NOT_READ} them — restart to pick them up: ${commandLine("restart")}`);
    } else {
      info(`${target} holds the new values, and ${INSTANCE_STOPPED_NOTE} — the next start reads them: ${commandLine("up")}`);
    }
  }

  if (repoSupplied.length > 0) {
    let content = await readEnvFileText();
    for (const entry of repoSupplied) {
      content = upsertEnvValue(content, entry.name, values[entry.name] ?? "");
    }
    await replacePrivateFile(envFile(), content);
    log(`applied ${repoSupplied.length} repository value(s) from ${path}`);
    await deliverRepositoryValues(ctx, repoSupplied, values);
  }
}

// Repo-env values differ from target values: compose interpolates them into the service
// definition and fixes them in the container's environment at creation, so `restart` keeps
// the old value while reporting success. The honest verb is the recreate `up` performs —
// real cost, container replaced, connections drop. Must go through reconcile(): settings.env
// is the process-start .env snapshot, and applyStore just rewrote that file in this process.

/** Puts rotated repo-env values in force, and says what was done either way. */
async function deliverRepositoryValues(ctx: Context, entries: SecretRequirement[], values: Record<string, string | undefined>): Promise<void> {
  if (!(await ctx.runtime.isRunning())) {
    info(`${envFile()} holds the new values, and ${INSTANCE_STOPPED_NOTE} — the next start creates the container with them: ${commandLine("up")}`);
    return;
  }
  // A runtime that cannot recreate gets the correct instruction, not the old lie.
  if (typeof ctx.runtime.reconcile !== "function") {
    info(`${envFile()} holds the new values, but the running container keeps the environment it was created with — a restart does not apply them`);
    info(`${RECREATE_NOTE} so compose interpolates the new values: ${commandLine("up")}`);
    return;
  }
  info(`recreating the container so compose interpolates the new values — it is ${REPLACED_NOTE}: connections drop and the service starts fresh`);
  await ctx.runtime.reconcile();
  log(`waiting for the gateway at ${ctx.settings.serviceUrl}`);
  await ctx.runtime.waitForHealth();
  log("gateway is healthy");
  await confirmRepositoryValues(ctx, entries, values);
}

/** Compares what the recreated container actually holds against what was written — without
 *  printing either. */
async function confirmRepositoryValues(ctx: Context, entries: SecretRequirement[], values: Record<string, string | undefined>): Promise<void> {
  if (typeof ctx.runtime.runningEnvironment !== "function") {
    info(`${ctx.runtime.description} cannot read the running container's environment, so the new values are in force but unconfirmed here`);
    return;
  }
  const environment = await ctx.runtime.runningEnvironment();
  if (environment === undefined) {
    warn(`could not read the running container's environment to confirm the new values — ${commandLine("status")} or ${commandLine("inspect")} says whether the instance is serving`);
    return;
  }
  const stale = entries.filter((entry) => environment[entry.name] !== values[entry.name]).map((entry) => entry.name);
  if (stale.length > 0) {
    warn(`the running container ${DOES_NOT_HOLD} the new value(s) for ${stale.join(", ")} — recreate with ${commandLine("up")}`);
    return;
  }
  log(entries.length === 1
    ? `confirmed: the running container holds the new value for ${entries[0].name}`
    : `confirmed: the running container holds the new values for all ${entries.length} repo-env variables`);
}

/** Renders a store file with recovered values filled in where known, in the same
 *  section/comment shape template() writes — an unrecovered name looks like an unfilled
 *  template entry, not different from one. */
function renderRecoveredStore(entries: SecretRequirement[], values: Record<string, string | undefined>): string {
  const lines = [
    "# Secrets recovered from the running instance.",
    "# A blank value means recovery could not reach it — fill it in by hand.",
    "",
  ];
  for (const location of ["repo-env", "target-env"] as SecretLocation[]) {
    const group = entries.filter((entry) => entry.location === location);
    if (group.length === 0) continue;
    lines.push(`# --- ${location} ---`);
    for (const entry of group) {
      lines.push(`# used by: ${entry.usedBy}`);
      lines.push(serializeEnvLine(entry.name, values[entry.name] ?? ""));
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** The reverse of --apply: recovers what a reachable, running instance holds into a local
 *  store, for when the operator side's own copy was lost. target-env values are read from
 *  the target's config/.env; repo-env values (the gateway token) aren't stored on the
 *  target's filesystem at all, so they're read from the running container's own environment
 *  instead. Unrecoverable names are left blank and named in the report; never refuses on
 *  partial recovery, since a partial store beats none. */
export function storeExistsRefusal(path: string): string {
  return `${path} already exists — pass --force to overwrite it with recovered values`;
}

async function dumpToStore(ctx: Context, storeName: string, force: boolean): Promise<void> {
  // The store file name is minted here; readers keep safeName so a store named before the device rule stays readable.
  createName("store", storeName);
  const path = secretStoreFile(readName("store", storeName));

  const exists = await access(path).then(
    () => true,
    () => false,
  );
  if (exists && !force) {
    die(storeExistsRefusal(path));
  }

  const needed = await requirements(ctx);
  const targetEntries = needed.filter((entry) => entry.location === "target-env");
  const repoEntries = needed.filter((entry) => entry.location === "repo-env");

  const targetRaw = targetEntries.length > 0 ? await dumpSecrets(ctx) : undefined;
  const targetValues = targetRaw !== undefined ? parseEnv(targetRaw, secretsFileOnTarget(ctx)) : {};

  const runningEnvironmentMethod = ctx.runtime.runningEnvironment?.bind(ctx.runtime);
  const canReadRunningEnvironment = runningEnvironmentMethod !== undefined;
  const runningEnvironment = repoEntries.length > 0 && runningEnvironmentMethod !== undefined
    ? await runningEnvironmentMethod()
    : undefined;

  const values: Record<string, string | undefined> = {};
  const unrecovered: string[] = [];
  for (const entry of needed) {
    const value = entry.location === "target-env" ? targetValues[entry.name] : runningEnvironment?.[entry.name];
    if (value === undefined || value === "") unrecovered.push(entry.name);
    else values[entry.name] = value;
  }

  await protectPrivateDirectory(secretsDir());
  const content = renderRecoveredStore(needed, values);
  if (exists) {
    await replacePrivateFile(path, content);
  } else {
    try {
      await createPrivateFile(path, content);
    } catch (error) {
      // Lost a creation race with a concurrent --dump/--init-store: protect what appeared.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await protectPrivateFile(path);
    }
  }

  log(`recovered ${needed.length - unrecovered.length} of ${needed.length} value(s) into ${path}`);
  if (unrecovered.length > 0) {
    warn(`could not recover ${unrecovered.length} value(s) — left blank in ${path}, fill in by hand:`);
    for (const name of unrecovered) info(name);
    if (repoEntries.length > 0 && !canReadRunningEnvironment) {
      info(`${ctx.runtime.description} ${CANNOT_READ_RUNNING_ENV}, so repo-env values were not attempted`);
    } else if (repoEntries.length > 0 && runningEnvironment === undefined) {
      info(`${INSTANCE_NOT_RUNNING_NOTE} (or could not be inspected) — repo-env values cannot be recovered while it is stopped`);
    }
  }
}

/** --dump: read-only against the target and the running container, no instance lock —
 *  nothing here mutates the instance, so there is nothing for the lock to serialize. */
async function runDumpAction(ctx: Context, store: string, force: boolean): Promise<void> {
  await dumpToStore(ctx, store, force);
}

/** --apply: writes config/.env on the target, same class of mutation apply/restore/rollback
 *  guard against, so it takes the same lock. No --break-lock support: breakLockSupported:
 *  false keeps a refusal from offering a flag it can't accept. */
async function runApplyAction(ctx: Context, store: string, breakForeignLockHost: string | undefined): Promise<void> {
  // Local first: an invalid or missing store name must not cost a lock on the target.
  await readStoreOrDie(store);
  await requireBootstrapped(ctx);
  await guardedWith(ctx, "secrets", { breakLock: false, breakForeignLockHost }, () => applyStore(ctx, store), { breakLockSupported: false });
}

/** --init-store: creates an empty store locally, refusing to overwrite a filled one. */
async function runInitStoreAction(ctx: Context, store: string, force: boolean): Promise<void> {
  // The store file name is minted here; readers keep safeName so a store named before the device rule stays readable.
  createName("store", store);
  const path = secretStoreFile(readName("store", store));

  // An existing store holds filled-in keys, unrecoverable elsewhere if overwritten silently.
  const exists = await access(path).then(
    () => true,
    () => false,
  );
  if (exists && !force) {
    die(`${path} already exists — pass --force to replace it with an empty template`);
  }

  // secrets/ needs protecting too: an atomic-save editor's temp file in this directory
  // inherits the DIRECTORY's access before renaming over the store.
  await protectPrivateDirectory(secretsDir());
  const needed = await requirements(ctx);
  if (exists) {
    // Atomic replacement: the old store stays whole and owner-only until the rename.
    await replacePrivateFile(path, template(needed));
  } else {
    try {
      await createPrivateFile(path, template(needed));
    } catch (error) {
      // Lost a creation race with a concurrent --init-store: protect what appeared.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await protectPrivateFile(path);
    }
  }
  log(`wrote ${path}`);
  info(`fill in the values, then: ${commandLine(["secrets", "--apply", "--store", store])}`);
}

/** The default read-only report: every declared secret's presence, or the JSON mirror of
 *  the same. */
async function runStatusReport(ctx: Context, jsonOnly: boolean): Promise<void> {
  const entries = await status(ctx);
  const emitJson = jsonOnly || isCaptured();

  if (entries.length === 0) {
    if (emitJson) {
      emit(`${JSON.stringify({ secrets: [], missing: [] }, null, 2)}\n`);
      return;
    }
    info(`no configuration on the target yet — run ${commandLine("bootstrap")} first`);
    return;
  }

  if (emitJson) {
    // Names/state/where-found only — SecretStatus never carries a value.
    const absent = missing(entries);
    // A fact, not the sentence built from it, so a caller doesn't string-match "then restart".
    const running = absent.length > 0 ? await ctx.runtime.isRunning() : null;
    emit(
      `${JSON.stringify(
        {
          secrets: entries.map((entry) => ({
            name: entry.name,
            location: entry.location,
            usedBy: entry.usedBy,
            required: entry.required,
            present: entry.present,
          })),
          missing: absent.map((entry) => entry.name),
          running,
        },
        null,
        2,
      )}\n`,
    );
    if (absent.length > 0) throw new Error(`missing: ${absent.map((entry) => entry.name).join(", ")}`);
    return;
  }

  log("required secrets");
  for (const entry of entries) {
    const mark = entry.present ? "ok     " : entry.required ? "MISSING" : "optional";
    info(`${mark} ${entry.name.padEnd(24)} ${entry.location.padEnd(11)} ${entry.usedBy}`);
  }

  const absent = missing(entries);
  if (absent.length > 0) {
    warn(`${absent.length} secret(s) missing — the gateway will refuse to start`);
    info("repo-env   → add to .env next to the repository");
    // The same contract as --apply's hint: which command applies the change depends on
    // whether an instance is there to restart.
    info(
      `target-env → add to <data>/config/.env on the target, then ${
        (await ctx.runtime.isRunning()) ? commandLine("restart") : commandLine("up")
      }`,
    );
    throw new Error(`missing: ${absent.map((entry) => entry.name).join(", ")}`);
  }

  log("all required secrets are present");
}

type SecretsAction = "report" | "template" | "print-template" | "init-store" | "apply" | "dump";

interface SecretsPlan {
  action: SecretsAction;
  store: string;
  force: boolean;
  breakForeignLockHost: string | undefined;
  jsonOnly: boolean;
}

/** Which single action the flags select: depends only on the arguments, so it runs in the
 *  prepare stage — before any contact, lock or .env write on every host. The cross-flag
 *  refusals are declared rules, refused at parse. */
function secretsPlan(values: Values<typeof SECRETS_ARGUMENTS>): SecretsPlan {
  const action: SecretsAction = values["init-store"] === true ? "init-store"
    : values.dump === true ? "dump"
    : values.apply === true ? "apply"
    : values["print-template"] === true ? "print-template"
    : values.template === true ? "template"
    : "report";
  const breakForeignLockHost = values["break-foreign-lock"];
  return { action, store: values.store ?? DEFAULT_SECRET_STORE, force: values.force === true, breakForeignLockHost, jsonOnly: values.json === true };
}

/** The command body; secrets(ctx, args) stays for callers that already hold a Context. */
export const SECRETS = commandBody({
  effect: "read",
  arguments: SECRETS_ARGUMENTS,
  rules: [
    { rule: "requires", name: "break-foreign-lock", with: ["apply"], reason: "no other action takes the instance lock" },
    // --store and --force used to be silently ignored by the actions they do not serve;
    // the any-of requires rule (R18) refuses them at parse instead.
    { rule: "requires", name: "store", any: true, with: ["init-store", "apply", "dump"], reason: "the report and the template actions use no store" },
    { rule: "requires", name: "force", any: true, with: ["init-store", "dump"], reason: "only an action that creates or overwrites a store can replace one" },
    { rule: "conflicts", name: "print-template", with: ["template", "init-store", "apply", "dump"], reason: "printing is read-only: it cannot be combined with an action that writes" },
    { rule: "conflicts", name: "json", with: ["template", "print-template", "init-store", "apply", "dump"], reason: "only the default report is structured" },
  ],
  prepare(call) {
    return secretsPlan(call.values as Values<typeof SECRETS_ARGUMENTS>);
  },
  async run(ctx, plan) {
    const { action, store, force, breakForeignLockHost, jsonOnly } = plan as SecretsPlan;
    if (action === "init-store") {
      await runInitStoreAction(ctx, store, force);
      return;
    }
    if (action === "dump") {
      await runDumpAction(ctx, store, force);
      return;
    }
    if (action === "apply") {
      await runApplyAction(ctx, store, breakForeignLockHost);
      return;
    }
    if (action === "template" || action === "print-template") {
      const content = template(await requirements(ctx));
      if (action === "print-template") {
        emitRaw(content);
        return;
      }
      await writeFile(secretsTemplateFile(), content, "utf8");
      log(`wrote ${secretsTemplateFile()}`);
      info("values are absent by design — the template is safe to commit");
      return;
    }
    return runStatusReport(ctx, jsonOnly);
  },
});

export async function secrets(ctx: Context, args: string[]): Promise<void> {
  await runOnContext(SECRETS, ctx, args);
}

/** Thrown by preflightSecrets specifically for missing secrets — the one case callers like
 *  restore/push handle gracefully. A distinct type so that handling doesn't also swallow a
 *  genuine failure (corrupted config, read error) underneath it. */
export class MissingSecretsError extends Error {
  constructor(count: number) {
    super(`cannot start: ${count} required secret(s) missing — run ${commandLine("secrets")} for details`);
    this.name = "MissingSecretsError";
  }
}

/** Used by other commands before starting the gateway: fail early with a readable list
 *  instead of letting the gateway crash-loop. */
export async function preflightSecrets(ctx: Context): Promise<void> {
  const absent = missing(await status(ctx));
  if (absent.length === 0) return;

  for (const entry of absent) {
    warn(`missing ${entry.name} (${entry.location}) — needed by ${entry.usedBy}`);
  }
  throw new MissingSecretsError(absent.length);
}

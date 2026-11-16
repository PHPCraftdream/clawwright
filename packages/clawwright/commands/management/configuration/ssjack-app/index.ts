// ssjack-descriptor: writes ssjack-app.json into the deployment directory, so ssjack can
// register this deployment with `--app <directory>` instead of knowing anything about
// Clawwright. Repository-side only (needs "local"): no .env read, no target contact.
//
// The file is published atomically (temporary file, then rename). A descriptor already there
// is kept when identical and refused when different unless --force says it may be replaced.

import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { commandBody } from "#src/core/command/index.ts";
import type { ArgumentSpec } from "#src/core/command/index.ts";
import { die, info, log } from "#src/core/io/log.ts";
import { frameFacts } from "#src/core/io/invocation/index.ts";
import type { HostPlatform } from "#src/core/io/invocation/frame.ts";
import { renameOverPrivateFile } from "#src/security/privacy/private-file.ts";
import { commandsOf } from "#src/commands/management/configuration/ssjack-app/classification.ts";
import { buildDescriptor, serializeDescriptor, SSJACK_APP_FILE } from "#src/commands/management/configuration/ssjack-app/descriptor.ts";
import type { SsjackAppDescriptor } from "#src/commands/management/configuration/ssjack-app/descriptor.ts";
import { resolveCliEntry } from "#src/commands/management/configuration/ssjack-app/launch.ts";
import type { EntryFacts } from "#src/commands/management/configuration/ssjack-app/launch.ts";

export const SSJACK_DESCRIPTOR_ARGUMENTS = [
  { name: "force", description: "Replace a different existing ssjack-app.json", kind: "flag", effect: "destroy" },
] as const satisfies readonly ArgumentSpec[];

export type DescriptorState = "created" | "replaced" | "current";

export interface DescriptorOutcome {
  readonly state: DescriptorState;
  readonly path: string;
  readonly text: string;
  readonly descriptor: SsjackAppDescriptor;
}

export interface DescriptorOptions {
  readonly force: boolean;
  /** Seams for checks; production reads the running process. */
  readonly host?: HostPlatform;
  readonly node?: string;
  readonly facts?: EntryFacts;
}

/** The file's text, undefined when absent. A link is never followed: the descriptor decides
 *  what ssjack launches, so it must not be redirected through a link. */
async function existingText(path: string): Promise<string | undefined> {
  try {
    if ((await lstat(path)).isSymbolicLink()) die(`refusing to replace a linked file: ${path}`);
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Atomic publish: the content lands under a temporary name and is renamed over the target.
 *  What was read earlier (`previous`) must still be there, so nothing unseen is replaced. */
async function publish(path: string, text: string, previous: string | undefined): Promise<void> {
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
    if ((await existingText(path)) !== previous) die(`${path} changed while it was being written — nothing was replaced`);
    await renameOverPrivateFile(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** The descriptor carries this machine's absolute paths, so it stays out of version control. */
async function ignoreInGit(directory: string): Promise<void> {
  const path = resolve(directory, ".gitignore");
  const previous = await existingText(path);
  const entry = `/${SSJACK_APP_FILE}`;
  const lines = (previous ?? "").split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(entry) || lines.includes(SSJACK_APP_FILE)) return;
  const separator = previous === undefined || previous === "" || previous.endsWith("\n") ? "" : "\n";
  await publish(path, `${previous ?? ""}${separator}${entry}\n`, previous);
}

export async function writeSsjackDescriptor(deployment: { readonly name: string; readonly dir: string }, options: DescriptorOptions): Promise<DescriptorOutcome> {
  const host = options.host ?? frameFacts().host;
  const entry = await resolveCliEntry(deployment, options.facts);
  const descriptor = buildDescriptor({
    host,
    node: options.node ?? process.execPath,
    entry: entry.path,
    entryArgs: entry.args,
    observational: commandsOf("observational"),
    refused: commandsOf("refused"),
  });
  const text = serializeDescriptor(descriptor, host);
  const path = resolve(deployment.dir, SSJACK_APP_FILE);

  const previous = await existingText(path);
  let state: DescriptorState = "current";
  if (previous !== text) {
    if (previous !== undefined && !options.force) {
      die(`${path} already exists and differs from the generated descriptor — pass --force to replace it`);
    }
    await publish(path, text, previous);
    state = previous === undefined ? "created" : "replaced";
  }
  await ignoreInGit(deployment.dir);
  return { state, path, text, descriptor };
}

export const SSJACK_DESCRIPTOR = commandBody({
  effect: "change",
  needs: "local",
  arguments: SSJACK_DESCRIPTOR_ARGUMENTS,
  async run(on, values) {
    const outcome = await writeSsjackDescriptor(on.deployment(), { force: values.force });
    log(outcome.state === "current" ? `ssjack descriptor is already current: ${outcome.path}` : `ssjack descriptor ${outcome.state}: ${outcome.path}`);
    info("start ssjack with --app pointing at this deployment directory");
  },
});

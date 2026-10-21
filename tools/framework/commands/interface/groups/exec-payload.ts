// Payload plumbing shared by `clawwright cli` and `clawwright exec`: --stdin reads this
// process's standard input, --file stages a local file into the target data directory so
// the container command can read it. Both live beside the commands they serve; groups/
// already carries their shared argument material (shared-arguments.ts).

import type { Context } from "#src/core/context.ts";
import { lstat, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { publishPrivateTargetFile } from "#src/security/privacy/private-target-file.ts";
import { renderArguments } from "#src/core/io/invocation/render.ts";

/** The hard bound on --stdin and --file: an unbounded pipe or an accidentally named
 *  multi-gigabyte file must refuse, not stream into a container's stdin forever. */
export const PAYLOAD_LIMIT_BYTES = 8 * 1024 * 1024;

/** The three prepare refusals both commands hand out verbatim: cli.ts/exec.ts refuse with
 *  these, and the check compares against these symbols — it proves the commands use the shared
 *  message, not that its wording stays fixed. */
export const ttyStdinRefusalMessage =
  "--stdin reads this process's standard input, which is a terminal — pipe the data in instead";
export const capturedStdinRefusalMessage =
  "--stdin cannot read standard input here: it carries the MCP protocol, not payload — pass --file instead";
export const noFileTokenRefusalMessage =
  "--file stages the file for the command, but no argument contains the @file token — put @file where the container path should go";

export const limitMessage = (what: string, bytes: number): string =>
  `${what} exceeds the ${PAYLOAD_LIMIT_BYTES / (1024 * 1024)} MiB payload limit (${bytes} bytes read)`;

/** The failure headlines cli.ts/exec.ts die with; the check compares against these symbols. */
export const cliFailureHeadline = (args: readonly string[], code: number): string =>
  `openclaw ${renderArguments(args)} failed (exit ${code})`;
export const execFailureHeadline = (args: readonly string[], code: number): string =>
  `exec ${renderArguments(args)} failed (exit ${code})`;

/** Reads this process's stdin to EOF, refusing past the payload limit as soon as the excess
 *  byte arrives (the stream is destroyed, so a bottomless producer cannot keep feeding).
 *  Delivered as UTF-8 text: the exec layer's `input` option is text, and the container
 *  command's stdin is read as text by everything OpenClaw's CLI accepts. */
export function readStdinBounded(limit: number = PAYLOAD_LIMIT_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const refuse = (error: Error): void => {
      if (settled) return;
      settled = true;
      process.stdin.destroy();
      reject(error);
    };
    process.stdin.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) refuse(new Error(limitMessage("standard input", total)));
      else chunks.push(chunk);
    });
    process.stdin.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    process.stdin.on("error", (error: Error) => {
      refuse(new Error(`could not read standard input: ${error.message}`));
    });
  });
}

export interface StagedFile {
  /** The staged copy's path on the target (host-side naming). */
  readonly stagedTargetPath: string;
  /** The same file as the container command sees it — the value that replaces @file. */
  readonly containerPath: string;
  /** Removes the staged copy; best-effort, so cleanup after a failed run cannot mask it. */
  readonly remove: () => Promise<void>;
}

/** Reads and fully validates a --file payload. Every refusal here happens before any
 *  target contact: the caller's prepare runs this before the pipeline builds any context.
 *  Plain Errors: the command layer's prepare maps each message into call.refuse, so the
 *  ArgumentError minting stays in the binder (checks drive these readers directly). */
export async function readPayloadFile(localPath: string): Promise<Buffer> {
  // lstat, not stat: a symlink would smuggle in whatever it points at — only a plain file
  // the operator named is staged.
  const info = await lstat(localPath).catch(() => undefined);
  if (info === undefined) throw new Error(`${localPath} does not exist`);
  if (info.isSymbolicLink()) throw new Error(`${localPath} is a symbolic link — only a regular file can be staged`);
  if (!info.isFile()) throw new Error(`${localPath} is not a regular file`);
  if (info.size > PAYLOAD_LIMIT_BYTES) {
    throw new Error(limitMessage(localPath, info.size));
  }
  return readFile(localPath).catch((error: Error) => {
    throw new Error(`${localPath} could not be read: ${error.message}`);
  });
}

/** The prepared plan both payload commands share: everything `run` needs, with every
 *  refusal already settled at prepare — run only stages, execs and cleans up. */
export interface ExecPlan {
  readonly args: string[];
  readonly stdin?: string;
  readonly payload?: Buffer;
}

/** Stages an already-validated payload into the data directory under a unique name and
 *  reports the path the container command reads it at.
 *
 *  publishPrivateTargetFile owns the whole hand: owner-only staging, chown to the runtime
 *  owner (the container runs as 1000:1000 and could not read a root-owned 600 file) and an
 *  atomic rename. Its staging sibling carries PRIVATE_STAGING_MARKER, so the snapshot
 *  policy recognizes an interrupted write; the final name carries the cli-input family,
 *  which archive/baseExcludes excludes directly. */
export async function stagePayload(ctx: Context, content: Buffer): Promise<StagedFile> {
  // config/ is where the existing staged-payload precedent (apply-config's patch file)
  // lives; the directory exists on every bootstrapped deployment.
  const stagedTargetPath =
    `${ctx.settings.dataDir}/config/clawwright-cli-input-${randomBytes(8).toString("hex")}`;
  await publishPrivateTargetFile(ctx, stagedTargetPath, content);
  return {
    stagedTargetPath,
    containerPath: ctx.paths.toContainer(stagedTargetPath),
    remove: () => ctx.transport.remove(stagedTargetPath).catch(() => {}),
  };
}

/** Replaces every exact @file token in the verbatim tail with the staged file's container
 *  path. Tokens merely CONTAINING @file are left alone, and so is @file without --file: it
 *  can be legitimate OpenClaw syntax, and staging nothing replaces nothing. */
export function replaceFileTokens(args: string[], containerPath: string): string[] {
  return args.map((token) => (token === "@file" ? containerPath : token));
}

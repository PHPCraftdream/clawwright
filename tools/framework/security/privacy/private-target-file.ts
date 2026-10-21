import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import type { Context } from "../../core/context.ts";
import { OWNER, needsOwnerEscalation, runMaybePrivileged, sudoFor } from "../../runtime/files/datadir.ts";
import { PRIVATE_STAGING_MARKER, privateWriteCommand } from "../../runtime/transport/quoting.ts";

/** Publishes private target content atomically, with its runtime owner set before rename.
 *  Content may be bytes: the private-write path feeds it to the transport exec's `input`,
 *  which is byte-faithful (`string | Uint8Array`). */
export async function publishPrivateTargetFile(ctx: Context, path: string, content: string | Uint8Array): Promise<void> {
  const staging = `${path}${PRIVATE_STAGING_MARKER}${randomBytes(8).toString("hex")}`;
  let created = false;
  // Staging, rename and cleanup all write the directory, never the file: escalation is decided
  // there once. Re-asking per step lets a staging file chowned to this user skip sudo for mv/rm.
  const prefix = await sudoFor(ctx, posix.dirname(path));
  const inDirectory = (command: string, args: string[], input?: string | Uint8Array) => {
    const [head, ...rest] = [...prefix, command, ...args];
    return ctx.transport.exec(head, rest, input === undefined ? {} : { input });
  };
  try {
    if (prefix.length === 0 && typeof ctx.transport.writePrivateFile === "function") {
      await ctx.transport.writePrivateFile(staging, content);
    } else {
      const [command, args] = privateWriteCommand(staging);
      await inDirectory(command, args, content);
    }
    created = true;
    // A root-staged file needs root to change hands, whoever the runtime owner is.
    const force = prefix.length > 0 || (await needsOwnerEscalation(ctx, OWNER));
    await runMaybePrivileged(ctx, staging, "chown", [OWNER, staging], { force });
    await inDirectory("mv", ["-fT", "--", staging, path]);
  } catch (error) {
    if (created) await inDirectory("rm", ["-f", "--", staging]).catch(() => {});
    throw error;
  }
}

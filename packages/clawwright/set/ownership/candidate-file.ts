// A "does this control file exist, and what does it hold" read shared by the ownership
// ledger and the installed-set marker — same transport, same tolerant shape, one place.

import type { Context } from "#src/core/context.ts";

export interface FileCandidate {
  readonly present: boolean;
  readonly text?: string;
}

/** exists() and readFile() are two separate transport round trips, never atomic: a write
 *  landing between them can make exists() answer false a moment before readFile() would have
 *  succeeded. A false negative is confirmed with one direct readFile() attempt before being
 *  trusted — real transports need this, not only test doubles. */
export async function readFileCandidate(ctx: Context, path: string): Promise<FileCandidate> {
  let present: boolean;
  try {
    present = await ctx.transport.exists(path);
  } catch {
    return { present: true };
  }
  if (!present) {
    try {
      return { present: true, text: await ctx.transport.readFile(path) };
    } catch {
      return { present: false };
    }
  }
  try {
    return { present: true, text: await ctx.transport.readFile(path) };
  } catch {
    return { present: true };
  }
}

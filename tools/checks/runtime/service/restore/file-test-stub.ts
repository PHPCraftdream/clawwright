// The product asks file-test probes through the shell builtin (runtime/files/file-test.ts).
// A stub transport whose rules key on `test <flag> <path>` reads them back through this.

import { FILE_TEST_SCRIPTS } from "#framework/runtime/files/file-test.ts";

export interface Call {
  readonly command: string;
  args: string[];
}

/** `sh -c <test script> sh <path>` as the `test <flag> <path>` it stands for; any other call
 *  comes back unchanged. */
export function asDirectTest(command: string, args: readonly string[]): Call {
  if (command !== "sh" || args.length !== 4 || args[0] !== "-c" || args[2] !== "sh") return { command, args: [...args] };
  for (const [flag, script] of Object.entries(FILE_TEST_SCRIPTS)) {
    if (args[1] === script) return { command: "test", args: [flag, args[3]] };
  }
  return { command, args: [...args] };
}

// The ssjack application descriptor (format ssjack-app-v1): the file ssjack reads to register
// an application. Pure — building the document and checking it against the limits ssjack
// itself enforces, so a descriptor ssjack would refuse is never written.

import { posix, win32 } from "node:path";
import type { HostPlatform } from "#src/core/io/invocation/frame.ts";
import { die } from "#src/core/io/log.ts";

export const SSJACK_APP_FORMAT = "ssjack-app-v1";
export const SSJACK_APP_FILE = "ssjack-app.json";
export const SSJACK_APP_NAME = "clawwright";

export const MAX_DESCRIPTOR_BYTES = 16 * 1024;
export const MAX_COMMANDS_PER_LIST = 64;
export const MAX_LAUNCH_ARGS = 16;
export const MAX_LAUNCH_ARG_BYTES = 1024;
export const MAX_LAUNCH_ARGS_TOTAL_BYTES = 4096;

const NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const COMMAND_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export interface SsjackAppDescriptor {
  readonly format: typeof SSJACK_APP_FORMAT;
  readonly name: string;
  readonly launch: { readonly executable: string; readonly args: readonly string[] };
  readonly workdir: string;
  readonly commands: { readonly observational: readonly string[]; readonly refused: readonly string[] };
}

/** What the descriptor is derived from: the host's executable and entry, and the two command lists. */
export interface DescriptorSource {
  readonly host: HostPlatform;
  /** Absolute path of the Node executable. */
  readonly node: string;
  /** Absolute path of the Clawwright entry file Node runs. */
  readonly entry: string;
  /** Fixed arguments between the entry and the command name (the checkout gate's --app). */
  readonly entryArgs: readonly string[];
  readonly observational: readonly string[];
  readonly refused: readonly string[];
}

export function buildDescriptor(source: DescriptorSource): SsjackAppDescriptor {
  return {
    format: SSJACK_APP_FORMAT,
    name: SSJACK_APP_NAME,
    launch: { executable: source.node, args: ["--experimental-strip-types", source.entry, ...source.entryArgs] },
    workdir: ".",
    commands: { observational: [...source.observational], refused: [...source.refused] },
  };
}

/** ssjack refuses any control character; this is Go's unicode.IsControl. */
function hasControl(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function commandListProblems(label: string, names: readonly string[]): string[] {
  const problems: string[] = [];
  if (names.length > MAX_COMMANDS_PER_LIST) problems.push(`${label} has ${names.length} entries, at most ${MAX_COMMANDS_PER_LIST}`);
  const seen = new Set<string>();
  for (const name of names) {
    if (!COMMAND_PATTERN.test(name)) problems.push(`${label} entry "${name}" must match ${COMMAND_PATTERN.source}`);
    if (seen.has(name)) problems.push(`${label} lists "${name}" twice`);
    seen.add(name);
  }
  return problems;
}

/** Every way the descriptor breaks the contract, empty when ssjack would accept it. `host` is
 *  the platform that will launch it: it decides what an executable must look like. */
export function descriptorProblems(descriptor: SsjackAppDescriptor, host: HostPlatform): string[] {
  const problems: string[] = [];
  if (descriptor.format !== SSJACK_APP_FORMAT) problems.push(`format must be ${SSJACK_APP_FORMAT}`);
  if (!NAME_PATTERN.test(descriptor.name)) problems.push(`name "${descriptor.name}" must match ${NAME_PATTERN.source}`);

  const { executable, args } = descriptor.launch;
  const hostPath = host === "win32" ? win32 : posix;
  if (executable === "" || hasControl(executable)) problems.push("launch.executable must be a non-empty path without control characters");
  else if (!hostPath.isAbsolute(executable)) problems.push("launch.executable must be an absolute path");
  else if (host === "win32" && !/\.exe$/i.test(executable)) problems.push("launch.executable must be a native .exe on Windows, never a .cmd or .bat shim");

  if (args.length > MAX_LAUNCH_ARGS) problems.push(`launch.args has ${args.length} entries, at most ${MAX_LAUNCH_ARGS}`);
  let total = 0;
  for (const arg of args) {
    const bytes = Buffer.byteLength(arg, "utf8");
    total += bytes;
    if (bytes > MAX_LAUNCH_ARG_BYTES) problems.push(`a launch.args entry is ${bytes} bytes, at most ${MAX_LAUNCH_ARG_BYTES}`);
    if (hasControl(arg)) problems.push("launch.args must not contain control characters");
  }
  if (total > MAX_LAUNCH_ARGS_TOTAL_BYTES) problems.push(`launch.args total ${total} bytes, at most ${MAX_LAUNCH_ARGS_TOTAL_BYTES}`);

  const climbs = descriptor.workdir.split(/[\\/]+/).includes("..");
  if (descriptor.workdir === "" || hasControl(descriptor.workdir) || posix.isAbsolute(descriptor.workdir) || win32.isAbsolute(descriptor.workdir) || climbs) {
    problems.push("workdir must be a relative path inside the application directory");
  }

  const { observational, refused } = descriptor.commands;
  problems.push(...commandListProblems("commands.observational", observational), ...commandListProblems("commands.refused", refused));
  for (const name of observational) {
    if (refused.includes(name)) problems.push(`command "${name}" is in both commands.observational and commands.refused`);
  }
  return problems;
}

/** The exact file text ssjack reads: one compact JSON object. Refuses a descriptor that
 *  breaks the contract or exceeds the size limit, before anything is written. */
export function serializeDescriptor(descriptor: SsjackAppDescriptor, host: HostPlatform): string {
  const problems = descriptorProblems(descriptor, host);
  const text = JSON.stringify(descriptor);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_DESCRIPTOR_BYTES) problems.push(`the descriptor is ${bytes} bytes, at most ${MAX_DESCRIPTOR_BYTES}`);
  if (Buffer.from(text, "utf8").toString("utf8") !== text) problems.push("the descriptor is not valid UTF-8");
  if (problems.length > 0) die(`the ssjack descriptor would break the ${SSJACK_APP_FORMAT} contract: ${problems.join("; ")}`);
  return text;
}

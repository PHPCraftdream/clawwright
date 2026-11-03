import { maskSecrets } from "../core/io/log.ts";
import { bytes, cap, deadline, limit, requestValue } from "./safety.ts";
import { DEFAULT_OUTPUT_BYTES_MAX, DEFAULT_TIMEOUT_MS, RecipeKitRefusal, REQUEST_BYTES_MAX } from "./types.ts";
import type { AppCliOptions, AppCliJsonOptions, AppCliJsonResult, CommandResult, ConfigPatchOptions, RecipeContext } from "./types.ts";

/** Runs bounded application CLI output; a deadline does not cancel the underlying process. */
export function appCli<T>(ctx: RecipeContext, args: readonly string[], options: AppCliJsonOptions<T>): Promise<AppCliJsonResult<T>>;
/** Runs the CLI with sanitized, byte-bounded stdout and stderr. */
export function appCli(ctx: RecipeContext, args: readonly string[], options?: AppCliOptions): Promise<CommandResult>;
export async function appCli<T>(ctx: RecipeContext, args: readonly string[], options: AppCliOptions | AppCliJsonOptions<T> = {}): Promise<CommandResult | AppCliJsonResult<T>> {
  const timeoutMs = limit(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const max = limit(options.outputBytesMax, DEFAULT_OUTPUT_BYTES_MAX);
  for (const arg of args) {
    requestValue(arg);
    if (maskSecrets(arg) !== arg) throw new RecipeKitRefusal("secret-argv");
  }
  if (bytes(args.join("\n")) > REQUEST_BYTES_MAX) throw new RecipeKitRefusal("invalid-request");
  const input = options.input ?? "";
  requestValue(input);
  if (options.json === true && typeof options.guard !== "function") throw new RecipeKitRefusal("guard");
  const raw = await deadline(() => ctx.runtime.runOneOff("cli", [...args], {
    profile: "cli", noDeps: true, input, allowFailure: true, timeoutMs,
  }), timeoutMs);
  if (raw.code !== 0) throw new RecipeKitRefusal("exit");
  const stdout = maskSecrets(raw.stdout);
  const stderr = maskSecrets(raw.stderr);
  const result = { code: raw.code, stdout: cap(stdout, max), stderr: cap(stderr, max) };
  if (options.json !== true) return result;
  if (bytes(stdout) > max) throw new RecipeKitRefusal("json");
  let data: unknown;
  try { data = JSON.parse(stdout); } catch { throw new RecipeKitRefusal("json"); }
  try {
    if (!options.guard(data)) throw new RecipeKitRefusal("guard");
  } catch { throw new RecipeKitRefusal("guard"); }
  return { ...result, data, redacted: stdout !== raw.stdout };
}

/** Sends a config-shaped JSON object on stdin; previews invoke the CLI with --dry-run. */
export async function appConfigPatch(ctx: RecipeContext, patch: Readonly<Record<string, unknown>>, options: ConfigPatchOptions = {}): Promise<CommandResult> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new RecipeKitRefusal("invalid-request");
  let input: string;
  try {
    input = JSON.stringify(patch);
    const parsed: unknown = JSON.parse(input);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new RecipeKitRefusal("invalid-request");
  } catch { throw new RecipeKitRefusal("invalid-request"); }
  requestValue(input);
  const args = ["config", "patch", "--stdin"];
  if (ctx.dryRun || options.dryRun) args.push("--dry-run");
  return appCli(ctx, args, { ...options, input });
}

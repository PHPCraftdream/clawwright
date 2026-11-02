/** Output-free refusal from a recipe helper; never carries transport causes. The optional
 *  detail is caller-sanitized and content-free (counts only), e.g. large-removal refusals. */
export class RecipeKitRefusal extends Error {
  readonly reason: RecipeKitReason;
  /** Content-free detail echoed by callers that need it; compare this field, not the message. */
  readonly detail?: string;
  /** Structured counts (e.g. removal bounds); never member keys or values. */
  readonly info?: Readonly<Record<string, number>>;
  constructor(reason: RecipeKitReason, detail?: string, info?: Readonly<Record<string, number>>) {
    super(`recipe-kit refused: ${reason}${detail === undefined ? "" : ` (${detail})`}`);
    this.reason = reason;
    this.detail = detail;
    this.info = info;
    this.name = "RecipeKitRefusal";
  }
}
/** Stable refusal categories. */
export type RecipeKitReason = "invalid-request" | "secret-argv" | "transport" | "timeout" | "exit" | "json" | "guard" | "response";
/** Default whole-helper wait budget in milliseconds (not process cancellation). */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Default retained UTF-8 output/body bytes. */
export const DEFAULT_OUTPUT_BYTES_MAX = 65_536;
/** Maximum total UTF-8 request/config bytes and individual values. */
export const REQUEST_BYTES_MAX = 262_144;
/** Captured command result, structurally compatible with Runtime. */
export interface CommandResult { code: number; stdout: string; stderr: string }
/** Extended options: runOneOff may ignore timeoutMs; the helper also bounds its promise. */
export interface RecipeRunOptions {
  profile?: string;
  noDeps?: boolean;
  entrypoint?: string;
  input?: string;
  allowFailure?: boolean;
  timeoutMs?: number;
}
/** Minimal runtime boundary, without Node declaration dependencies. */
export interface RecipeRuntime {
  runOneOff(service: string, args: string[], options?: RecipeRunOptions): Promise<CommandResult>;
  execCommand?(service: string, command: string, args: string[], options?: RecipeRunOptions): Promise<CommandResult>;
}
/** Minimal hook context; real framework contexts satisfy this structurally. */
export interface RecipeContext { runtime: RecipeRuntime; dryRun?: boolean }
/** Bounded CLI invocation options; secrets belong in stdin. */
export interface AppCliOptions {
  input?: string;
  timeoutMs?: number;
  outputBytesMax?: number;
  json?: false;
}
/** JSON is parsed and guarded only after redaction, without truncation. */
export interface AppCliJsonOptions<T> extends Omit<AppCliOptions, "json"> {
  json: true;
  guard: (value: unknown) => value is T;
}
/** Guarded machine output plus bounded sanitized diagnostic streams; `redacted` is true when
 *  a registered secret was masked in stdout, so `data` is not the application's real value. */
export interface AppCliJsonResult<T> extends CommandResult { data: T; redacted: boolean }
/** Config patch preview invokes the application CLI with --dry-run. */
export interface ConfigPatchOptions extends AppCliOptions { dryRun?: boolean }
/** Stdin-only HTTP request from the gateway's route. */
export interface ConsumerRequest {
  service?: "gateway";
  url: string;
  method?: string;
  headers?: Readonly<Record<string, string>>;
  body?: string;
  proxy?: string;
  basicAuth?: { username: string; password: string };
  secrets?: readonly string[];
  responseHeaders?: readonly string[];
  /** Retained redacted body bytes and, separately, aggregate selected header-value bytes. */
  bodyBytesMax?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}
/** Final HTTP status, selected lowercase headers and bounded redacted UTF-8 body.
 * truncated describes only the body: redacted full body bytes exceed bodyBytesMax.
 * Selected header values share a separate bodyBytesMax budget; their clipping does not set this flag.
 */
export interface ConsumerResponse { status: number; headers: Record<string, string>; body: string; truncated: boolean }

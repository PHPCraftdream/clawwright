export const MAX_MODEL_BYTES = 64 * 1024 ** 3;
export const MODEL_REDIRECT_HOSTS = Object.freeze([
  "huggingface.co", "cas-bridge.xethub.hf.co", "cdn-lfs.huggingface.co", "cdn-lfs.hf.co",
]);
export interface ModelApproval {
  readonly source: string;
  readonly modelVersion: string;
  readonly checksum: string;
  readonly pluginVersion: string;
  readonly maxBytes: number;
}

export function approveModel(input: unknown): Readonly<ModelApproval> {
  const fail = (): never => { throw new Error("MODEL_APPROVAL"); };
  if (input === null || typeof input !== "object" || Array.isArray(input)) return fail();
  const v = input as Record<string, unknown>;
  if (Object.keys(v).some((key) => !["source", "modelVersion", "checksum", "pluginVersion", "maxBytes"].includes(key))) return fail();
  if (typeof v.source !== "string" || v.source.length > 2048 || /\s/.test(v.source)) return fail();
  const match = /^https:\/\/huggingface\.co(?::443)?\/([A-Za-z0-9][A-Za-z0-9_-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)\/resolve\/([0-9a-f]{40})\/([A-Za-z0-9][A-Za-z0-9._-]*\.gguf)$/.exec(v.source);
  if (!match || match[2].includes("..") || match[4].includes("..") || v.modelVersion !== match[3]) return fail();
  const url = new URL(v.source);
  if (url.protocol !== "https:" || url.hostname !== "huggingface.co" || url.username || url.password || url.port || url.search || url.hash) return fail();
  if (typeof v.checksum !== "string" || v.checksum.length !== 64 || !/^[0-9a-f]{64}$/.test(v.checksum)) return fail();
  const numeric = "(?:0|[1-9][0-9]*)";
  const identifier = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
  const semver = new RegExp(`^${numeric}\\.${numeric}\\.${numeric}(?:-${identifier}(?:\\.${identifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
  if (typeof v.pluginVersion !== "string" || v.pluginVersion.length > 128 || /\s/.test(v.pluginVersion) || !semver.test(v.pluginVersion)) return fail();
  if (typeof v.maxBytes !== "number" || !Number.isSafeInteger(v.maxBytes) || v.maxBytes <= 0 || v.maxBytes > 64 * 1024 ** 3) return fail();
  return Object.freeze({ source: url.href, modelVersion: v.modelVersion as string, checksum: v.checksum, pluginVersion: v.pluginVersion, maxBytes: v.maxBytes });
}

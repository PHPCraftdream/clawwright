export const CHECKSUM_TIMEOUT_MS = 8_000;
export const CHECKSUM_BYTE_LIMIT = 64 * 1024;
export const CHECKSUM_MAX_REDIRECTS = 5;
export const CHECKSUM_ALLOWED_HOSTS = ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"] as const;

export type ChecksumErrorCode = "url" | "redirect" | "http" | "timeout" | "size" | "body" | "parse" | "missing";
export class ChecksumError extends Error {
  readonly code: ChecksumErrorCode;
  constructor(code: ChecksumErrorCode, message: string = code) { super(message); this.code = code; this.name = "ChecksumError"; }
}
export type FetchSeam = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type ParsedChecksum = { digest: string; filename: string };

export function parseChecksum(text: string, expectedFilename: string, mode: "primary" | "sum" = "sum"): ParsedChecksum {
  if (!expectedFilename || /[/\\\r\n]/.test(expectedFilename)) throw new ChecksumError("parse", "expected checksum filename is invalid");
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) throw new ChecksumError("parse", "checksum file is empty");
  const matches: ParsedChecksum[] = [];
  for (const line of lines) {
    const match = /^([a-fA-F0-9]{64})[ \t]+(?:\*?)([^\r\n]+)$/.exec(line);
    if (!match || match[2].trim() !== match[2] || /[/\\]/.test(match[2])) throw new ChecksumError("parse", "checksum file contains a malformed entry");
    if (match[2] === expectedFilename) matches.push({ digest: match[1].toLowerCase(), filename: match[2] });
  }
  if (mode === "primary" && (lines.length !== 1 || matches.length !== 1)) throw new ChecksumError("parse", matches.length === 0 ? "checksum filename mismatch" : "primary checksum must contain exactly one entry");
  if (matches.length !== 1) throw new ChecksumError(matches.length ? "parse" : "missing", matches.length ? "duplicate matching checksum entries" : "expected filename not found in checksum list");
  return matches[0];
}

function validateUrl(raw: string | URL, allowQuery = false): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new ChecksumError("url", "invalid checksum URL"); }
  if (url.protocol !== "https:" || !CHECKSUM_ALLOWED_HOSTS.includes(url.hostname as typeof CHECKSUM_ALLOWED_HOSTS[number]) || url.username || url.password || (url.port && url.port !== "443") || (!allowQuery && url.search) || url.hash) throw new ChecksumError("url", "checksum URL must use HTTPS on an allowed host without credentials or fragment");
  return url;
}

function cancelBody(response: Response): void { try { void response.body?.cancel().catch(() => undefined); } catch { /* best-effort only */ } }

async function boundedBody(response: Response, limit: number, race: <T>(p: Promise<T>) => Promise<T>): Promise<string> {
  if (!response.body) throw new ChecksumError("body", "checksum response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await race(reader.read());
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new ChecksumError("size", "checksum response exceeds size limit");
      chunks.push(part.value);
    }
  } catch (error) { void reader.cancel().catch(() => undefined); throw error; }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new ChecksumError("parse", "checksum response is not valid UTF-8"); }
}

export async function fetchPublishedChecksum(assetURL: string | URL, fetcher: FetchSeam = fetch): Promise<{ digest: string; sourceURL: string }> {
  const asset = validateUrl(assetURL);
  const basenamePart = asset.pathname.split("/").filter(Boolean).at(-1) ?? "";
  let basename: string;
  try { basename = decodeURIComponent(basenamePart); } catch { throw new ChecksumError("url", "invalid encoded asset filename"); }
  if (!basename) throw new ChecksumError("url", "missing asset filename");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let expired = false;
  let timedOutResponse: Response | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { expired = true; controller.abort(); if (timedOutResponse) cancelBody(timedOutResponse); reject(new ChecksumError("timeout", "checksum request exceeded deadline")); }, CHECKSUM_TIMEOUT_MS); });
  const race = <T>(promise: Promise<T>) => Promise.race([promise, deadline]);
  const request = async (initial: URL): Promise<{ response: Response; url: URL }> => {
    let url = initial;
    for (let redirects = 0; ; redirects++) {
      const pending = Promise.resolve().then(() => fetcher(url, { method: "GET", redirect: "manual", credentials: "omit", signal: controller.signal }));
      const response = await race(pending.then((res) => { if (expired) cancelBody(res); return res; }));
      if (expired) { cancelBody(response); throw new ChecksumError("timeout", "checksum request exceeded deadline"); }
      if (response.status >= 300 && response.status < 400) {
        timedOutResponse = response;
        const location = response.headers.get("location");
        cancelBody(response);
        if (!location || redirects >= CHECKSUM_MAX_REDIRECTS) throw new ChecksumError("redirect", "checksum redirect is missing a location or exceeds redirect limit");
        try { url = validateUrl(new URL(location, url), true); } catch { throw new ChecksumError("redirect", "checksum redirect target is not allowed"); }
        continue;
      }
      timedOutResponse = response;
      return { response, url };
    }
  };
  try {
    const primaryURL = new URL(`${asset.href}.sha256`);
    const primary = await request(primaryURL);
    if (primary.response.status === 404) {
      cancelBody(primary.response);
      const directory = new URL("./SHA256SUMS", asset);
      const fallback = await request(directory);
      if (fallback.response.status !== 200) { cancelBody(fallback.response); throw new ChecksumError("http", `checksum server returned HTTP ${fallback.response.status}`); }
      const parsed = parseChecksum(await boundedBody(fallback.response, CHECKSUM_BYTE_LIMIT, race), basename, "sum");
      return { digest: parsed.digest, sourceURL: fallback.url.href };
    }
    if (primary.response.status !== 200) { cancelBody(primary.response); throw new ChecksumError("http", `checksum server returned HTTP ${primary.response.status}`); }
    const parsed = parseChecksum(await boundedBody(primary.response, CHECKSUM_BYTE_LIMIT, race), basename, "primary");
    return { digest: parsed.digest, sourceURL: primary.url.href };
  } catch (error) {
    if (expired) throw new ChecksumError("timeout", "checksum request exceeded deadline");
    if (error instanceof ChecksumError) throw error;
    throw new ChecksumError("body", `failed to read checksum response: ${String(error)}`);
  } finally { clearTimeout(timer!); }
}

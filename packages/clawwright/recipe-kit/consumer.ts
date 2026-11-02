import { curlQuote, parseResponse, STATUS_TRAILER } from "./curl.ts";
import { bytes, cap, deadline, limit, requestValue, sanitize } from "./safety.ts";
import { DEFAULT_OUTPUT_BYTES_MAX, DEFAULT_TIMEOUT_MS, RecipeKitRefusal, REQUEST_BYTES_MAX } from "./types.ts";
import type { ConsumerRequest, ConsumerResponse, RecipeContext } from "./types.ts";

/** Fetches through gateway curl; bounds wait/retention, not transport allocation or cancellation.
 * max-filesize cannot guarantee a pre-capture bound for chunked transfers on every curl version.
 */
export async function consumerFetch(ctx: RecipeContext, request: ConsumerRequest): Promise<ConsumerResponse> {
  if (request.service !== undefined && request.service !== "gateway") throw new RecipeKitRefusal("invalid-request");
  const timeoutMs = limit(request.timeoutMs, DEFAULT_TIMEOUT_MS);
  const max = limit(request.bodyBytesMax, DEFAULT_OUTPUT_BYTES_MAX);
  const redirects = request.maxRedirects ?? 0;
  if (!Number.isSafeInteger(redirects) || redirects < 0 || redirects > 20) throw new RecipeKitRefusal("invalid-request");
  requestValue(request.url);
  let url: URL;
  try { url = new URL(request.url); } catch { throw new RecipeKitRefusal("invalid-request"); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new RecipeKitRefusal("invalid-request");
  const secrets = [...(request.secrets ?? [])];
  secrets.push(request.url);
  const lines = ["silent", "show-error", "include", 'proto = "=http,https"', 'proto-redir = "=http,https"',
    `max-time = ${curlQuote(String(timeoutMs / 1000))}`, `max-filesize = ${max}`, `max-redirs = ${redirects}`,
    `url = ${curlQuote(request.url)}`, `write-out = ${curlQuote(`${STATUS_TRAILER}%{http_code}:%{num_redirects}`)}`];
  if (redirects > 0) lines.push("location");
  const method = request.method ?? "GET";
  if (!/^[A-Z]+$/.test(method)) throw new RecipeKitRefusal("invalid-request");
  lines.push(`request = ${curlQuote(method)}`);
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new RecipeKitRefusal("invalid-request");
    if (typeof value !== "string" || /[\r\n]/.test(value)) throw new RecipeKitRefusal("invalid-request");
    if (["authorization", "proxy-authorization"].includes(name.toLowerCase())) {
      secrets.push(value, `${name}: ${value}`);
      const credential = /^\S+\s+(.+)$/.exec(value)?.[1];
      if (credential) secrets.push(credential);
    }
    lines.push(`header = ${curlQuote(`${name}: ${value}`)}`);
  }
  if (request.proxy !== undefined) {
    requestValue(request.proxy);
    let proxy: URL;
    try { proxy = new URL(request.proxy); } catch { throw new RecipeKitRefusal("invalid-request"); }
    if (!["http:", "https:", "socks5:", "socks5h:", "socks4:", "socks4a:"].includes(proxy.protocol)) throw new RecipeKitRefusal("invalid-request");
    try {
      for (const component of [proxy.username, proxy.password]) if (component) secrets.push(component, decodeURIComponent(component));
    } catch { throw new RecipeKitRefusal("invalid-request"); }
    secrets.push(request.proxy);
    lines.push(`proxy = ${curlQuote(request.proxy)}`);
  }
  if (request.basicAuth) {
    const { username, password } = request.basicAuth;
    if (username.includes(":")) throw new RecipeKitRefusal("invalid-request");
    const pair = `${username}:${password}`;
    requestValue(pair);
    secrets.push(username, password, pair, btoa(Array.from(new TextEncoder().encode(pair), (byte) => String.fromCharCode(byte)).join("")));
    lines.push(`user = ${curlQuote(`${username}:${password}`)}`, "basic");
  }
  if (request.body !== undefined) lines.push(`data-raw = ${curlQuote(request.body)}`);
  const input = `${lines.join("\n")}\n`;
  if (bytes(input) > REQUEST_BYTES_MAX) throw new RecipeKitRefusal("invalid-request");
  const selected = (request.responseHeaders ?? []).map((name) => name.toLowerCase());
  if (selected.length > 128 || selected.some((name) => !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name))) throw new RecipeKitRefusal("invalid-request");
  const redact = sanitize(secrets);
  const args = ["--disable", "--config", "-"];
  const options = { input, allowFailure: true, timeoutMs };
  const raw = await deadline(() => ctx.runtime.execCommand
    ? ctx.runtime.execCommand("gateway", "curl", args, options)
    : ctx.runtime.runOneOff("gateway", args, { ...options, entrypoint: "curl", noDeps: true }), timeoutMs);
  if (raw.code !== 0) throw new RecipeKitRefusal("exit");
  const parsed = parseResponse(raw.stdout, selected);
  const headers: Record<string, string> = {};
  let remaining = max;
  for (const [name, value] of Object.entries(parsed.headers)) {
    const retained = cap(redact(value), remaining);
    Object.defineProperty(headers, name, { value: retained, enumerable: true });
    remaining -= bytes(retained);
  }
  const body = redact(parsed.body);
  return { status: parsed.status, headers, body: cap(body, max), truncated: bytes(body) > max };
}

import { requestValue } from "./safety.ts";
import { RecipeKitRefusal } from "./types.ts";

// Internal, directly testable; never interpolate request values into shell or argv.
export function curlQuote(value: string): string {
  requestValue(value);
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
}

export const STATUS_TRAILER = "\nrecipe-kit-status:";

export function parseResponse(output: string, selected: readonly string[]): { status: number; headers: Record<string, string>; body: string } {
  const trailer = output.lastIndexOf(STATUS_TRAILER);
  const tail = /^(\d{3}):(\d+)$/.exec(output.slice(trailer + STATUS_TRAILER.length));
  if (trailer < 0 || !tail) throw new RecipeKitRefusal("response");
  const finalStatus = Number(tail[1]);
  let redirects = Number(tail[2]);
  if (redirects > 20) throw new RecipeKitRefusal("response");
  const message = output.slice(0, trailer);
  let offset = 0;
  for (;;) {
    const start = message.slice(offset);
    const statusLine = /^HTTP\/\d(?:\.\d)? ([1-5]\d\d)(?: [^\r\n]*)?\r?\n/.exec(start);
    if (!statusLine) throw new RecipeKitRefusal("response");
    const boundary = /\r?\n\r?\n/.exec(start);
    if (!boundary || boundary.index > 65_536) throw new RecipeKitRefusal("response");
    const status = Number(statusLine[1]);
    const headers: Record<string, string> = {};
    for (const line of start.slice(statusLine[0].length, boundary.index).split(/\r?\n/)) {
      if (!line) continue;
      const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*(.*)$/.exec(line);
      if (!match) throw new RecipeKitRefusal("response");
      const name = match[1].toLowerCase();
      if (selected.includes(name)) Object.defineProperty(headers, name, { value: Object.hasOwn(headers, name) ? `${headers[name]}, ${match[2]}` : match[2], enumerable: true, configurable: true });
    }
    offset += boundary.index + boundary[0].length;
    const nextIsHeader = /^HTTP\/\d(?:\.\d)? [1-5]\d\d(?: [^\r\n]*)?\r?\n/.test(message.slice(offset));
    // Only protocol intermediate blocks can consume another block. A normal final body
    // beginning with HTTP is body, not a new response.
    const isRedirect = status >= 300 && status < 400 && redirects > 0;
    const intermediate = status < 200 || / connection established\r?\n/i.test(statusLine[0]) || isRedirect;
    if (isRedirect) redirects--;
    if (intermediate) {
      if (!nextIsHeader) throw new RecipeKitRefusal("response");
      continue;
    }
    if (status !== finalStatus || redirects !== 0) throw new RecipeKitRefusal("response");
    return { status, headers, body: message.slice(offset) };
  }
}

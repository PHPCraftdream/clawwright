import { UserError } from "#src/core/io/log.ts";
import { parseSSJackPlaceholder, type SSJackReference } from "#src/core/values/config/ssjack-secret-refs.ts";

export type CanonicalTextReference = SSJackReference;

const invalid = (): never => {
  throw new UserError("SSJACK_TEXT_TEMPLATE_INVALID");
};

const placeholderPattern =
  /\{"\$ssjack":\{"format":"ssjack-secret-ref-v1","object_id":"[0-9a-f]{32}","snapshot_id":"[0-9a-f]{32}","store_id":"[0-9a-f]{32}","version_id":"[0-9a-f]{32}"\}\}/g;
const reservedMarkerPattern = /\$ssjack|\\u0024ssjack/i;

const hasUnpairedSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
};

export function parseCanonicalTextReferences(template: string): readonly SSJackReference[] {
  if (typeof template !== "string") return invalid();

  if (hasUnpairedSurrogate(template)) return invalid();
  const encoded = Buffer.from(template, "utf8");
  if (encoded.length > 32768 || encoded.toString("utf8") !== template) return invalid();

  const references: SSJackReference[] = [];
  const unique = new Set<string>();
  const remainder = template.replace(placeholderPattern, (placeholder) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(placeholder);
    } catch {
      return invalid();
    }

    let reference: SSJackReference | undefined;
    try {
      reference = parseSSJackPlaceholder(parsed);
    } catch {
      return invalid();
    }
    if (reference === undefined) return invalid();

    const key = JSON.stringify(reference);
    if (!unique.has(key)) {
      unique.add(key);
      references.push(reference);
      if (unique.size > 16) return invalid();
    }
    return "";
  });

  if (references.length === 0 || reservedMarkerPattern.test(remainder)) return invalid();
  if (references.some((reference) =>
    reference.store_id !== references[0].store_id ||
    reference.snapshot_id !== references[0].snapshot_id
  )) return invalid();

  return references;
}

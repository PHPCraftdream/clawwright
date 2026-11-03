// Absolute URLs for documentation named in user-facing messages: a repository-relative
// `docs/...` path means nothing in an app folder outside the checkout.

// Must match package.json's homepage repository; asserted by the docs-url check.
const DOCS_BASE = "https://github.com/PHPCraftdream/clawwright/blob/main/docs/";

/** URL of a page under docs/, e.g. docsUrl("guide/requirements.md#anchor"). */
export function docsUrl(path: string): string {
  return `${DOCS_BASE}${path}`;
}

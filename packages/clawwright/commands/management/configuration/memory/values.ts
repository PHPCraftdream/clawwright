import * as kinds from "#src/core/values/kinds.ts";
import { approveModel } from "#src/commands/management/configuration/memory/setup/approval.ts";

const REVISION = "0123456789abcdef0123456789abcdef01234567";
const SOURCE = `https://huggingface.co/example/model/resolve/${REVISION}/model.gguf`;
const CHECKSUM = "0".repeat(64);

/** The approval grammar stays in approveModel; each kind asks it about one field of a valid whole. */
function accepts(patch: Record<string, unknown>): boolean {
  try { approveModel({ source: SOURCE, modelVersion: REVISION, checksum: CHECKSUM, pluginVersion: "1.0.0", maxBytes: 1, ...patch }); return true; }
  catch { return false; }
}

export const sha256 = () => kinds.checksum("hex64", {
  expected: "a lower-case SHA256 checksum",
  invalid: (raw) => `takes a lower-case SHA256 checksum, not "${raw}"`,
  example: "a".repeat(64),
});
export const modelSource = () => kinds.grammar({
  expected: "an immutable Hugging Face GGUF URL pinned to a revision",
  example: SOURCE,
  invalid: ["https://example.test/model.gguf", "not a url"],
  matches: (raw) => accepts({ source: raw, modelVersion: /\/resolve\/([0-9a-f]{40})\//.exec(raw)?.[1] }),
});
export const modelRevision = () => kinds.grammar({
  expected: "a 40-character lower-case commit revision",
  example: REVISION,
  invalid: ["main", "0123"],
  matches: (raw) => /^[0-9a-f]{40}$/.test(raw),
});
export const pluginVersion = () => kinds.grammar({
  expected: "an exact semantic version",
  example: "1.0.0",
  invalid: ["latest", "1.0"],
  matches: (raw) => accepts({ pluginVersion: raw }),
});

// Snapshot archives: what goes in, and how to look inside one.
//
// Split into four files, purely organisational: profile.ts (profile/naming/exclusion
// rules — what a `full`/`migrate`/`share` archive carries, and the `.replaced-*` sibling's
// own name), validate.ts (whether an archive's listing and link map are safe to unpack),
// pack.ts (the tar invocations — create/extract/list) and inventory.ts (listing archives
// and replaced-copy siblings on the target, for `backup list`/`backup prune-replaced`).
// This file, index.ts, re-exports all four under one name so importers keep a single path,
// `service/archive/index.ts`.

export * from "./profile.ts";
export * from "./validate.ts";
export * from "./pack.ts";
export * from "./inventory.ts";

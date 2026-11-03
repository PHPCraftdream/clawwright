# Task260 selected-text pair

Status: **AUTHORED-NOT-RUN** for this correction. Component CI does not establish joint acceptance.

The first actual composition used ssjack `989e5cb69dd5665acf5b62d6308e1694636494e8` with Clawwright `765efb5eb33934c189bf372a8464e31e2ae9421f`. Feature run `41567828346` passed the existing three-OS, root-adapter and license checks, but the real CLI failed before the expected withheld result and before SSH effects. The synthetic client fixtures had not enforced the SDK's Accept requirement.

The text client sent only `Accept: application/json`. Pinned `github.com/modelcontextprotocol/go-sdk` v1.0.0 `mcp/streamable.go` requires both JSON and SSE in POST Accept headers, including when `JSONResponse` is true, and otherwise rejects initialization. The correction advertises `application/json, text/event-stream`. It does not relax certificate/identity checks, capability/profile validation, JSON response admission, byte/deadline limits or uncertainty handling; the approved ssjack listener still uses JSON responses.

The existing synthetic HTTPS fixture now asserts the exact two media types for every text-client request. Reverting the product header fails that assertion at initialization. The reviewed current client-check Git blob is `5a40b9366289c81222e2deea652ab86ccbd4c48e`; other receipts, immutable baseline and historical 79 rows are unchanged. The check has exactly 700 physical lines.

Public Clawwright CI and a new ssjack pair run pinned to the corrected Clawwright commit are required. No local parser, compiler, formatter, test or application execution was performed. This document makes no application-authentication, universal-production-readiness or actual paired-success claim.

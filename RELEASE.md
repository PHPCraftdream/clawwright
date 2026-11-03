# Release checklist

This repository publishes `@phpcraftdream/clawwright` from `packages/clawwright/`.

## Publishing a release (Trusted Publisher, OIDC)

Releases are published by GitHub Actions with npm Trusted Publishing — no npm token exists
anywhere. npm trusts `PHPCraftdream/clawwright`, workflow `publish.yml`, environment `release`
(deployments from `v*` tags only), with direct publishing allowed; the repository variable
`CLAWWRIGHT_ENABLE_TRUSTED_PUBLISHER` is `true`.

1. Bump `packages/clawwright/package.json`'s version and fold `## Unreleased` in CHANGELOG.md into
   that version's section, through a pull request.
2. Tag the merged commit and push the tag: `git tag -a v<version> -m "clawwright <version>"`,
   `git push origin v<version>`.
3. Run the workflow from the tag:
   `gh workflow run publish.yml --repo PHPCraftdream/clawwright --ref v<version>`
   (`publish_mode` defaults to `trusted-publisher`). It tests and packs, then publishes that exact
   tarball with provenance.

The `token` mode stays in the workflow only as a fallback; it needs an `NPM_TOKEN` secret on the
`release` environment, which does not exist. Version 0.1.0 was the one release published that
way; the token was deleted afterwards.

Before every release:

- The package is `@phpcraftdream/clawwright`, in the release account's own scope (npm refuses the
  bare `clawwright` as too close to `playwright`); it publishes with public access.
- The copyright holder is PHPCraftdream (LICENSE-MIT, NOTICE, package `author`); the project is
  dual-licensed MIT OR Apache-2.0, and CONTRIBUTING.md accepts contributions under both.
- `THIRD_PARTY_NOTICES.md` (repository and package copies are identical) carries OpenClaw's MIT
  notice for the adapted Compose file; re-check it when that file is re-synced from upstream, and
  review the optional recipe sources separately.
- The release commit's CI is green (it already runs the checks, `pack:check` and a system-wide
  install used from a fresh app folder on Linux, macOS and Windows).
- Never publish a working tree containing deployment data, `.env`, MCP client settings, archives,
  snapshots, or generated `dist/` output — the workflow publishes only the tarball it packed.

The package is intentionally versioned independently from the example deployment. Runtime
image tags and OpenClaw releases must be pinned and reviewed separately from an npm release.

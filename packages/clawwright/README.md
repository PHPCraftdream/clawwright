# @phpcraftdream/clawwright

Clawwright is a Node.js framework and CLI for operating self-hosted
[OpenClaw](https://github.com/openclaw/openclaw) deployments. It provides transport-aware
lifecycle commands, reproducible set artifacts, archive safety checks, and two MCP surfaces for
the deployment and the OpenClaw gateway.

Source, issues and the full guides: https://github.com/PHPCraftdream/clawwright

## SSJack text backup

`backup-text --file <PATH> --output <PATH> --profile <NAME>` backs up selected text via the explicitly granted keeper path. A separate prior human approval of `reverse-copy-v1` at the root is required; launch does not prompt for or authorize approval. Output is published exclusively and never overwrites an existing file. See the [SSJack guide](../../docs/ssjack.md#backup-text-mode) for limits and refusal behavior.


## Install

System-wide, then one folder per deployment:

```bash
npm install -g @phpcraftdream/clawwright
mkdir my-openclaw && cd my-openclaw
clawwright init
clawwright bootstrap --check
clawwright bootstrap
```

Or pinned per app, as a local dependency:

```bash
npm install @phpcraftdream/clawwright
npx clawwright init
./clawwright bootstrap
```

The package requires Node.js 24 or newer. `clawwright init` writes an application
declaration, host-specific environment template, a `clawwright` launcher, and project-local
MCP configuration for Claude Code and Codex. It never edits global client settings.

`npx` (or `node_modules/.bin/clawwright`) for that one call: a locally installed package is
not on `PATH`, and afterwards the `./clawwright` launcher it writes takes over. The
declaration it writes is ESM, so the directory's `package.json` has to say `"type":
"module"` — init sets it, and refuses rather than changing it when the directory already
holds CommonJS of its own.

Installed globally instead (`npm install -g`), `clawwright` works in any app folder: `clawwright
init` there, then `clawwright <command>`. A folder with its own local `@phpcraftdream/clawwright`
still runs that one — the global command hands over to it — so a version pin per app keeps working.

The gateway image, Docker, WSL, SSH, and provider credentials belong to the deployment. The
framework does not bundle OpenClaw or any provider key. The repository owns this package's
TypeScript source under `packages/clawwright/`; `tools/build-framework-package.ts` builds the
published `dist/` package from that source. The package's public exports and runtime remain the
installed application API. See the repository guides for transport requirements, archive profiles,
set artifacts, and the security model.

Provider setup is provider-agnostic: put `<PROVIDER>_API_KEY` in the target's
`config/.env`, then run `clawwright configure-provider`. Use `--provider <id> --env <VAR>`
when the provider uses a custom variable name; URLs, adapters and model catalogues stay in
`config/desired-state.json`.

## Operating and repairing a deployment

Use Clawwright's CLI or `clawwright-control` MCP tools first: `status`, `inspect`, `doctor`,
bounded `logs`, and the relevant `recipe status`, `recipe logs`, `recipe diagnose` or
`recipe verify`. Ask `help <command>` for the installed version's contract before changing
state. Use `cli` for OpenClaw's own diagnostics and `exec` or `host` for a missing low-level
probe; do not start with custom scripts, direct Docker/WSL/SSH calls or raw secret-file dumps.
The purpose is to make complete OpenClaw setup and recovery reproducible through the
framework, not to maintain a second manual operating procedure.

Separate emergency recovery from a permanent fix. An approved live repair may restore
service, but the owning declaration or recipe must also reproduce the corrected setup and
detect the failure. Fix configuration generation, dependency readiness and verification
there, rather than leaving a working container that the next install cannot reproduce.
Record any missing framework diagnostic or recovery operation as an explicit tool gap.

A healthy container or a successful API authentication probe is not proof that a bot
responds. Verify the dependency from the gateway, the channel's running state, and an
authorized end-to-end message and reply. Do not send test messages without permission or
claim that an untested path works. Hooks may mutate state; a stale lock or recipe ownership
cutover is a safety refusal, not permission to bypass it. Agree disruptive recovery with
the operator and preserve data and credentials.

See the repository guides [Operations](https://github.com/PHPCraftdream/clawwright/blob/main/docs/guide/operations.md) and
[Recipes](https://github.com/PHPCraftdream/clawwright/blob/main/docs/guide/recipes.md) for the diagnostic sequence and durable
recipe-repair contract.

## Recipe private files

A recipe's `recipe.json` can declare two private-file fields, in two different coordinate
systems. `privatePaths` lists data-relative paths where the recipe keeps generated
credentials on the target: `migrate` and `share` snapshots exclude them, `full` keeps them,
and the `@phpcraftdream/clawwright/private-config` target-write helpers refuse writes anywhere else.
`privateFiles` lists recipe-relative files that `recipe import` leaves out of the copy — a
filter over file names, not a guarantee. Both are literal paths, validated strictly. The
repository's [Recipes guide](https://github.com/PHPCraftdream/clawwright/blob/main/docs/guide/recipes.md) documents both contracts,
including their limits.

For operator-side files created by app hooks (for example offsite full backups), the same
public entry exports `protectPrivateDirectory(path)` and
`createPrivateBinaryFile(path, bytes)`. Seal the output directory first, then create the
binary file exclusively: existing destinations refuse rather than being overwritten.
Protection is POSIX `0700`/`0600` or a verified Windows owner-only DACL before content is
written. Windows DACL protection does not isolate other Linux users accessing a DrvFs
mount: do not write plaintext credentials there; use protected Linux storage or encrypt
before transfer. These are operator files, not target recipe writes, and do not use the
target `privatePaths` ledger.

## MCP

The project-local servers are named `clawwright` (OpenClaw's channel bridge) and
`clawwright-control` (the framework command surface). Destructive control operations require
an explicit confirmation argument. Treat the generated MCP configuration as executable code
with access to the deployment and its target.

## License

Copyright (c) 2026 PHPCraftdream. This package is dual-licensed under the MIT
License or the Apache License, Version 2.0. See `LICENSE-MIT`, `LICENSE-APACHE`, and
`THIRD_PARTY_NOTICES.md`.

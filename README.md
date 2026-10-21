# Clawwright for OpenClaw

[![CI](https://github.com/PHPCraftdream/clawwright/actions/workflows/ci.yml/badge.svg)](https://github.com/PHPCraftdream/clawwright/actions/workflows/ci.yml)
[![Node.js >=24](https://img.shields.io/badge/node.js-%3E%3D24-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)](LICENSE)
[![MCP server](https://img.shields.io/badge/MCP-server-6E56CF)](docs/guide/deploy-and-mcp.md#mcp-clawwright-in-claude-code-and-codex)
[![Targets: WSL2 | Linux | SSH](https://img.shields.io/badge/targets-WSL2%20%7C%20Linux%20%7C%20SSH-informational)](docs/guide/requirements.md)
[![npm package](https://img.shields.io/npm/v/%40phpcraftdream%2Fclawwright?logo=npm)](https://www.npmjs.com/package/@phpcraftdream/clawwright)

A reproducible Clawwright environment for running [OpenClaw](https://github.com/openclaw/openclaw)
yourself: identical locally (WSL2) and on a remote Linux server, with persistent data,
state snapshots and an MCP bridge.

This repository does not fork OpenClaw and does not build it from source. It runs the
official `ghcr.io/openclaw/openclaw` image and adds a thin layer of tooling around it.

Built for an operator and for an agent alike: besides the bridge to OpenClaw's own channels,
every Clawwright command is also offered as an MCP tool (`./clawwright control-mcp`), so an AI
agent — under Claude Code, Codex or any other MCP client — can bootstrap, inspect, back up or
roll back the same instance directly, with the same arguments and the same findings a human
operator would see on a terminal. See
[Deploying and MCP](docs/guide/deploy-and-mcp.md#mcp-clawwright-in-claude-code-and-codex).

Side services run next to the instance as recipes: `recipe install` builds and starts one,
`recipe run` executes its declared actions, `recipe trial` rehearses it on a throwaway copy of
its data, `recipe pin` refreshes a pinned release artifact, and `recipe check` runs its own
checks — see [Recipes](docs/guide/recipes.md) and the [cookbook](docs/guide/recipes-cookbook.md).

## Requirements

* **Docker Engine + Compose v2** — on the machine where the instance lives
* **Node 24 or newer** — for the tooling itself
* `curl`, `tar`; `ssh` and `rsync` — for a remote server

The tooling installs nothing: when a dependency is missing it stops and says what is
missing. Under WSL either Docker Desktop with integration enabled or a native Docker Engine
works.

Which target (`local`/`wsl`/`ssh`) a given host OS can run is a fixed matrix, not a free
choice — see [docs/guide/requirements.md](docs/guide/requirements.md).

## Quick start

```bash
npm install                    # json5, plus the dev tooling the checks use
./clawwright new-app openclaw   # deployment directory: .env, config/, secrets/, recipes/
./clawwright bootstrap --check  # read-only: docker, compose v2, this directory, the port, disk space
./clawwright bootstrap          # from nothing: token, directories, image, config, provider, start
./clawwright status             # what is running and whether it is healthy
./clawwright smoke              # acceptance run
```

On a fresh host `/srv` is usually root-owned: `bootstrap --check` reports `FAIL` and prints the
exact `sudo install -d …` line each missing directory needs — run it once, then `bootstrap`.

The first step is needed once per machine: a deployment is not kept in the repository — it
is the configuration of one host, with its paths and its keys. `apps/` is entirely in
`.gitignore`.

Works from WSL and from Windows' Git Bash (the checkout entry `./clawwright` is a bash
script; PowerShell works for the installed package): Windows Node reaches the
target through `wsl.exe`, so there is no need to install Node inside WSL.

Web interface: `http://127.0.0.1:<OPENCLAW_GATEWAY_PORT>` — `new-app` picks the port (20000–32767)
and writes it to `.env`; `./clawwright status` or `./clawwright mcp-creds` print the actual URL.
Token in `.env` (`OPENCLAW_GATEWAY_TOKEN`).
Running `./clawwright bootstrap` again is safe: it re-pulls the image (a digest-pinned
`OPENCLAW_IMAGE` is left alone) and rewrites desired-state, but does not restart an
already-running gateway — run `./clawwright restart` afterwards to pick up changed settings. It never
touches data already on disk. The first time it pulls a shared tag, it pins `OPENCLAW_IMAGE` in
`.env` to `repo:tag@sha256:…` — the exact digest that pull just proved, alongside the tag it
came from — so another deployment on this Docker daemon later pulling the same tag can no
longer silently change what THIS one runs next, while `./clawwright upgrade` (with no `--image`)
still knows which tag to check for something newer; a deployment already pinned to a digest is
left alone by `bootstrap`, and `./clawwright upgrade` is the way to move it from there (see
[Upgrading the image](docs/guide/data-and-backups.md#upgrading-the-image-upgrade)).

## Installing `clawwright` system-wide

```bash
npm install -g @phpcraftdream/clawwright
cd ~/my-openclaw              # any app folder
clawwright init               # app.ts, config/, .env, ./clawwright — nothing installed into the folder
clawwright bootstrap --check
clawwright status
```

From a clone of this repository, `npm run install:system` (once `npm install` has run) packs
`tools/framework` and installs that instead — a copy, not a link to the working tree: run it
again to take later changes. It uses the deployment's own framework whenever there is one — a
local `@phpcraftdream/clawwright` dependency (the app's version pin), or, inside this checkout,
`apps/<name>` and the root go to the checkout's own gate — and runs on itself only in a folder
with neither. The `./clawwright` script and the MCP launcher that `init` writes fall back to it
the same way. Remove it with `npm uninstall -g @phpcraftdream/clawwright`.
For a per-project dependency (the app's own version pin), `npm install @phpcraftdream/clawwright` in
the app.

## I want to…

| I want to… | Run | Notes |
| --- | --- | --- |
| Check whether a fresh host is actually ready to bootstrap | `./clawwright bootstrap --check` | read-only: docker, compose v2, the data/backup/snapshot directories, the gateway port, free disk space — no lock, nothing created |
| Bring a fresh instance up | `./clawwright bootstrap` | idempotent — safe to run again on a live instance |
| Check what's running right now | `./clawwright status` | containers, image, health probes, disk — a snapshot, not a verdict |
| Get a pass/fail exit code for scripts | `./clawwright doctor` | the same inspection `inspect` computes, but exits non-zero on a blocking finding |
| Understand what's wrong and why | `./clawwright inspect` | every declared-vs-running difference, each with a stable code and a remedy; read-only, never fails the process |
| Prove the instance actually works, not just runs | `./clawwright smoke` | exercises it end to end — the agent answers, config drift self-heals, snapshots round-trip — `status`/`inspect`/`doctor` only observe |
| Change the declared configuration | edit the declaration, then `./clawwright plan` → `./clawwright apply` | `apply-config` applies the ordered `{path,value}` declarations as a patch against live config; it prunes removed declarations using its target-side ownership record, preserving unchanged SecretRefs. See [instance settings as code](docs/guide/operations.md#instance-settings-as-code) for path and selector rules. `configure-provider` only wires a model provider from a secret; `secrets --apply` only pushes secret values into force — none of the three touch `desired-state.json` itself |
| Save or restore a point-in-time snapshot | `./clawwright backup` / `./clawwright restore` | one archive of this instance's data, by name, kept on the target (the server itself for SSH, not this machine) |
| Run backups on a schedule | `./clawwright backup install` | crontab (or, on Windows, a printed/applyable Task Scheduler entry) that runs a plain `backup` on `--interval` (default 1d) — pairs with `OC_BACKUP_KEEP` |
| Move or share an instance's state | `./clawwright pull` / `./clawwright push` | same archive format as backup, meant to travel instead — `migrate`/`share` profiles leave secrets out |
| Update the OpenClaw image | `./clawwright upgrade` | resolves to a digest, backs up first, rolls back automatically on failure |
| Reach a loopback-bound gateway from outside this host | `./clawwright expose` | an SSH tunnel, a tailnet-only `tailscale serve`, or a status report — narrowest scope first |
| Get paged when the instance breaks | `./clawwright watch install` | a cron probe plus a webhook fired only on a state transition — on Windows it prints a ready Task Scheduler command (and, with `--apply`, can install it directly) instead of a crontab entry |
| Respond to a suspected compromise | `./clawwright incident` | contain exposure → preserve evidence → rotate the gateway token → audit → collect |
| Move a deployment onto a server | `./clawwright deploy user@host` | mirrors the framework and this deployment's config over SSH; credentials never leave this machine |
| See every deployment in this checkout | `./clawwright list` | monorepo checkouts only; one line each, naming why a deployment can't be read when it can't |
| Read the service log | `./clawwright logs` | `--tail <n>`, `--since <duration\|timestamp>`, `--grep <pattern>`, `--no-color`, `--json` |
| Get shell tab-completion | `eval "$(./clawwright completion bash)"` | also `zsh`/`pwsh`; generated from the live commands, so it never drifts from `--help` — see [docs/guide/commands.md](docs/guide/commands.md#shell-completion) |
| Undo a deployment | `./clawwright destroy` then `./clawwright remove-app <name>` | dry run by default; `destroy` removes the instance (containers always, data/backups/snapshots each behind its own flag), `remove-app` deletes `apps/<name>/` itself — see [Removing a deployment](docs/guide/operations.md#removing-a-deployment) |
| Run something a recipe knows how to do | `./clawwright recipe run <name> <action> key=value` | actions a recipe's `recipe.json` declares, previewed with `--dry-run`; `recipe trial` proves a recipe against a throwaway copy of its data, `recipe pin` refreshes pinned release artifacts, `recipe check` runs its own `*.check.ts` files — see [Recipe actions](docs/guide/recipes.md#recipe-actions) and the [cookbook](docs/guide/recipes-cookbook.md#run-a-one-off-action-against-a-running-recipe) |
| Move a recipe off its legacy stack when `recipe migrate` cannot | `./clawwright recipe retire-legacy <name>` | previews the proven-owned inventory; `--apply` stops, cold-backs-up and removes the legacy containers only, then `recipe install` proceeds — see [Existing-stack cutover](docs/guide/recipes.md#existing-stack-cutover) |

## Commands

```bash
./clawwright help               # the same list as below, current as of the moment you run it
./clawwright help <command>     # full description of a command and its arguments
./clawwright <command> --help   # the same thing, different syntax
```

Grouped by operator intent, one line each — full signatures and behavior in
[docs/guide/commands.md](docs/guide/commands.md):

<!-- command-list:begin (generated by npm run docs:commands from the command declarations; do not edit) -->
```
Start & stop:
  bootstrap            Bring the instance up (idempotent)
  up                   Start the service; wait until it serves
  restart              Restart so the instance re-reads its config
  down                 Stop and remove the containers (data is kept)
  destroy              Remove what bootstrap created *
  logs                 Follow the service log, or read a tail
  status               Show containers, image, health, data usage

Check:
  smoke                Acceptance run: health, agent, config, snapshots, MCP
  inspect              Declared versus running, with differences
  doctor               Report what is wrong and what to run
  accept               Run this deployment's acceptance checks
  operations           What mutating runs did and left behind *
  watch                Health monitoring with webhook alerts *

Change:
  upgrade              Update the image by digest; rollback on failure *
  plan                 Actions the declaration implies, without running
  apply                Apply the plan, then confirm the instance *
  rollback             Restore the configuration an operation replaced *
  apply-config         Apply the deployment's desired-state.json *
  memory               Declare, set up, inspect, index, verify memory *
  configure-provider   Configure model providers from target env vars
  secrets              Show required secrets and their state *
  recipe               Deploy service recipes beside the instance *
  files                Apply or preview declared deployment files *
  provision-agent      Wire a recipe's MCP server to an OpenClaw agent
  set                  Build or validate the set artifact *

Save & move:
  backup               Snapshot data; list, prune, schedule *
  restore              Restore an archive over current state *
  pull                 Snapshot the instance to the snapshot directory
  push                 Push a snapshot onto the instance *
  verify               Check a snapshot for credentials
  lock                 Pin the instance's composition, or verify it
  deploy               Deploy over SSH and bootstrap the server *

Security & access:
  expose               Expose the gateway: SSH tunnel or tailscale *
  incident             Contain, collect evidence, rotate tokens, audit *

Integrations & recovery:
  recover-env          Repair .env from the running instance
  mcp-serve            stdio MCP bridge to the service's own channels
  mcp-setup            Configure project MCP servers (Claude Code, Codex)
  mcp-creds            Print service URL, token and MCP client config

Low-level:
  cli                  Run the OpenClaw CLI in a throwaway container !
  exec                 Run a command in the same sidecar as `cli` !
  host                 Run a command on the host, not in a container !
  cli-start            Start the persistent CLI helper
  cli-stop             Stop the persistent CLI helper

Framework:
  check                Framework preflight checks (no instance needed)
  new-app              Create a deployment under apps/
  remove-app           Delete apps/<name> *
  list                 List deployments under apps/
  version              Print clawwright's own version (also: --version, -v)
  completion           Print a shell completion script (bash, zsh or pwsh) to stdout
  --app <name>         Pick another deployment, before the command (default: the OC_APP one)
  control-mcp          Expose clawwright's commands as MCP tools, for agents
  help <command>       Same as: <command> --help

  ! destructive     * destructive for some actions (a read-only or --dry-run form is safe)
```
<!-- command-list:end -->

## Documentation

* [docs/guide/requirements.md](docs/guide/requirements.md) — which target (`local`/`wsl`/`ssh`)
  each host OS can run, what each combination means, how to test it
* [docs/guide/commands.md](docs/guide/commands.md) — full command reference: every argument
  and behavior, plus `./clawwright host`
* [docs/guide/operations.md](docs/guide/operations.md) — changing the declared configuration
  (`inspect`/`plan`/`apply`), the instance lock, rollback, `accept`, instance settings as code
* [docs/guide/data-and-backups.md](docs/guide/data-and-backups.md) — data layout, provider
  and secret setup, backup/restore, `afterBackup`/`beforeRestore` hooks, `pull`/`push`,
  upgrading the image
* [docs/guide/monitoring-and-access.md](docs/guide/monitoring-and-access.md) — `expose`,
  `watch`, `incident`, the security gate and suppressions
* [docs/guide/recipes.md](docs/guide/recipes.md) — recipes, recipe-declared actions (`recipe run`),
  `recipe trial`/`pin`/`check`/`retire-legacy`, `provision-agent`, the
  `privatePaths`/`privateFiles` contract
* [docs/internal/recipe-migration-executor.md](docs/internal/recipe-migration-executor.md) —
  implementation notes behind `recipe migrate`/`recover`: journal phases, storage and
  helper-image verification, compensation and recovery-directory rules
* [docs/guide/recipe-manifest.md](docs/guide/recipe-manifest.md) — complete recipe.json fields,
  validation rules, readers and hook contracts
* [docs/guide/recipes-cookbook.md](docs/guide/recipes-cookbook.md) — worked recipe patterns:
  pinned release downloads, secret-free config changes, upstream config migrations
* [docs/guide/sets.md](docs/guide/sets.md) — installing, trying and rolling back sets;
  semantic diff and acceptance evidence
* [docs/guide/deploy-and-mcp.md](docs/guide/deploy-and-mcp.md) — several deployments side by
  side, installing as an npm dependency, deploying to a server, recovering a lost deployment
  folder, MCP setup for Claude Code and Codex
* [docs/architecture.md](docs/architecture.md) — how the framework is put together, source
  layout, design rationale, what `./clawwright check` covers
* [docs/first-hour-acceptance.md](docs/first-hour-acceptance.md) — manual acceptance run for
  a fresh deployment

## Diagnostics

| Symptom | Cause and cure |
| --- | --- |
| `node not found` / too old | Node 24+ is required. Inside WSL the Windows Node is visible through `/mnt/c` — it will not see `/srv` or Docker in WSL |
| `permission denied` on `/home/node/.openclaw` | The bind mount is not owned by uid 1000: `sudo chown -R 1000:1000 /srv/openclaw/data` |
| The gateway does not come up | `./clawwright logs`; the healthz/startupz/readyz probes and Docker's verdict are in `./clawwright status` |
| The container is forever `unhealthy` while the service answers | The healthcheck points at a file that does not exist; image 2026.6.34 needs `curl -fsS /healthz` |
| `SecretRefResolutionError` and a crash loop | The config references a variable missing from `config/.env` |
| `127.0.0.1` does not reach a service on the host | Inside the container that is the container itself — use `host.docker.internal` |
| `... needs root and sudo asks for a password` | A directory this deployment needs is owned by root and there is nowhere to type a password. The refusal now names every directory the deployment will need, not just the one that failed first — usually one `sudo install -d -o 1000 -g 1000 <shared root>`, run once on the target. `./clawwright bootstrap --check` catches this before the first bootstrap ever runs, naming the exact command for each directory that needs it |
| `port 18789 is already published by ...` / `... is already listening (...)` | The first is another deployment's Docker container; the second is a bare process Docker never published (`ss`/`netstat` on the target caught it, before pulling or preparing data). Either way: set your own `OPENCLAW_GATEWAY_PORT` in `.env`, or stop whatever is using this one |
| `bootstrap` fails mid-mutation with an opaque `find`/`stat`/`readlink`/`tar` error | The target's userland is BusyBox (Alpine without `coreutils`/`findutils`/`tar`) or BSD (a macOS `ssh` target, a minimal container) — this framework's target-side commands are GNU-specific (see [docs/guide/requirements.md](docs/guide/requirements.md#target-userland)). `./clawwright bootstrap --check` catches this first and names the exact tool(s) missing (`TARGET_NOT_GNU`) |
| The Control UI reports "Browser origin not allowed" | The gateway was never told this origin: declare it in `gateway.controlUi.allowedOrigins`, apply, and restart the gateway (`docker compose up` alone will not recreate a healthy container) |

## License

Clawwright is dual-licensed under the MIT License or the Apache License, Version 2.0. See
`LICENSE-MIT`, `LICENSE-APACHE`, and `THIRD_PARTY_NOTICES.md`.

## Sources

* [OpenClaw documentation — Docker](https://docs.openclaw.ai/install/docker)
* [Environment variables](https://docs.openclaw.ai/help/environment)
* [The `openclaw mcp serve` bridge](https://docs.openclaw.ai/cli/mcp)
* [OpenClaw provider configuration](https://docs.openclaw.ai/providers)
* [openclaw/openclaw repository](https://github.com/openclaw/openclaw)

// Lifecycle command group: bringing an instance up, down, and moving its state around.
// Split out of index.ts, which merges every group's fragment into one openclawCommands.
//
// Prose only: each command's body (arguments, effect, phases) lives in its implementation
// module and is spread into the entry here; materializeCommands builds the AppCommand face.

import type { AppCommand } from "#src/core/app.ts";
import { materializeCommands } from "#src/core/command/index.ts";

import { UP, RESTART, DOWN } from "#src/commands/lifecycle/instance/control.ts";
import { DESTROY } from "#src/commands/lifecycle/instance/destroy.ts";
import { LOGS } from "#src/commands/lifecycle/instance/logs.ts";
import { UPGRADE } from "#src/commands/lifecycle/instance/upgrade.ts";
import { BOOTSTRAP } from "#src/commands/lifecycle/bootstrap/index.ts";
import { BACKUP } from "#src/commands/lifecycle/backup/index.ts";
import { RESTORE } from "#src/commands/lifecycle/restore/index.ts";
import { VERIFY } from "#src/commands/lifecycle/verify.ts";
import { PULL, PUSH } from "#src/commands/lifecycle/state.ts";
import { SMOKE } from "#src/commands/lifecycle/smoke/index.ts";

export const lifecycleCommands: Record<string, AppCommand> = materializeCommands({
  bootstrap: {
    summary: "Bring the instance up (idempotent)",
    group: "start-stop",
    ...BOOTSTRAP,
    details:
      "Fixed order, each step paid for in debugging: .env and the gateway token first " +
      "(compose interpolates them), then data directories owned by uid 1000, the image, " +
      "baseline config (or the gateway crash-loops on \"Missing config\"), the provider " +
      "from config/.env, this deployment's desired-state.json, a secrets preflight, and " +
      "only then start.\n" +
      "Safe to run again on a live instance: re-pulls the image (digest pins stay) and " +
      "rewrites desired-state, but does not restart a running gateway — restart afterwards " +
      "to pick up changes. Never regenerates a token or touches data on disk.\n" +
      "{--check} runs none of that: a read-only prerequisite report (docker and compose v2, " +
      "the data/backup/snapshot directories, the gateway port, free disk space), one " +
      "ok/WARN/FAIL line each, no lock and nothing created — run it before the first bootstrap.",
  },
  up: {
    summary: "Start the service; wait until it serves",
    group: "start-stop",
    details:
      "Checks secrets and the gateway port before starting, not after —\n" +
      "a missing SecretRef or a port already held by another deployment otherwise " +
      "surfaces as a crash-loop with the real reason buried in the container log.\n" +
      "Returns only once /healthz answers, not just once the container exists.",
    ...UP,
  },
  restart: {
    summary: "Restart so the instance re-reads its config",
    group: "start-stop",
    details:
      "`up` cannot do this: it converges on \"running\", and an instance that is already " +
      "running and healthy is already converged — an edit to openclaw.json inside a bind " +
      "mount changes nothing the runtime compares.\n" +
      "That is why apply-config and configure-provider point here: their changes only take " +
      "effect on the next start of the gateway process.\n" +
      "Restart re-reads what the container can see — never what compose baked into it: the " +
      "environment was interpolated from the deployment .env once, at creation, and no " +
      "restart changes it. A rotated repo-env secret needs the recreate that `secrets --apply` " +
      "performs itself, or `{clawwright up}`.\n" +
      "Secrets are checked first, same as `up`; the port is not, since the container keeps " +
      "the binding it already holds.",
    ...RESTART,
  },
  down: {
    summary: "Stop and remove the containers (data is kept)",
    group: "start-stop",
    details: "Data lives in host bind mounts, not in runtime-managed volumes, so this never touches it.",
    ...DOWN,
  },
  destroy: {
    summary: "Remove what bootstrap created",
    group: "start-stop",
    details:
      "The inverse of bootstrap. Always stops and removes the compose project's containers, " +
      "network and volumes (down, plus volumes) — nothing else goes without its own flag:\n" +
      "{--data} removes the data directory (OC_DATA_DIR), {--backups} the backup directory " +
      "(OC_BACKUP_DIR), {--snapshots} the snapshot directory (OC_SNAPSHOT_DIR).\n" +
      "Never touches the deployment directory itself (.env, config/, recipes/, secrets/) — " +
      "remove that with {clawwright remove-app} once this instance is gone.\n" +
      "Default is a dry run: prints exactly what would be removed (container/network/volume " +
      "names, and each requested directory's path and size via du -sk) and exits 0 — nothing " +
      "is touched, no lock is taken.\n" +
      "A real run needs BOTH {--yes} and {--confirm-name} <name> matching this deployment's own " +
      "name, so a typo cannot remove the wrong instance; it then takes the instance lock " +
      "like every other mutating command ({--break-lock}/{--break-foreign-lock}).\n" +
      "Each requested path is refused outright rather than removed when it is not an " +
      "absolute path, is a top-level or home-directory-shaped path, or is itself a symlink — " +
      "these are the deployment's own declared directories, never a path typed on the " +
      "command line, so this is a sanity check on the deployment's .env, not on user input.\n" +
      "Removal escalates through sudo on the target the same way bootstrap's own " +
      "ensureDataDirs does, never through this machine's own privileges.",
    ...DESTROY,
  },
  logs: {
    summary: "Follow the service log, or read a tail",
    group: "start-stop",
    details:
      "On a terminal this follows the log until interrupted. Called as a tool it reads the " +
      "last lines and returns them instead — following would never produce the single " +
      "result a tool call owes its caller.\n" +
      "{--tail} sets how many lines the bounded read returns; without it the deployment's own " +
      "declared default applies.\n" +
      "{--since} takes a duration (10m, 2h, 1h30m) or an RFC3339/ISO date-time, passed to " +
      "compose as-is; anything else is refused rather than forwarded.\n" +
      "{--no-color} strips ANSI escape sequences from the output, including codes the " +
      "service itself embedded in its log lines, and does so on a followed stream as well " +
      "as on the bounded read.\n" +
      "{--json} emits each line as a JSON object (ts, service, stream when known, text) " +
      "instead of plain text; it reads a bounded tail even on a terminal.\n" +
      "{--grep} filters lines by a JS RegExp, on the bounded read and on a followed stream " +
      "alike (filtered line by line as it arrives); an invalid pattern is refused before " +
      "anything runs.",
    ...LOGS,
  },
  backup: {
    summary: "Snapshot data; list, prune, schedule",
    group: "save-move",
    details:
      "With no action: stops the gateway for the duration by default — OpenClaw keeps " +
      "state in SQLite with a multi-megabyte -wal sibling, and a copy taken mid-write is " +
      "not restorable.\n" +
      "{--hot} skips the stop for those who accept that risk.\n" +
      "{--profile} controls what travels in the archive (see `{clawwright help pull}` for what each " +
      "profile excludes); {--share}, {--migrate} and {--with-secrets} are shorthands for it, the " +
      "same vocabulary `pull` accepts — plain backups default to full, unlike `pull`, which " +
      "defaults to migrate.\n" +
      "{--native} takes a consistent snapshot WITHOUT stopping the gateway instead, via " +
      "OpenClaw's own `backup create --verify` in the running instance's sidecar rather than " +
      "a raw tar over live state — full profile only.\n" +
      "The archive it publishes is still an ordinary full backup (rotate/restore need no " +
      "native-specific case), with the pristine OpenClaw archive embedded inside so " +
      "`restore` can re-verify it before unpacking anything else.\n" +
      "What this actually guarantees: the SQLite state (config/state, config, identity, " +
      "devices) is a genuine point-in-time snapshot from OpenClaw's own mechanism, not from " +
      "stopping the container.\n" +
      "auth-secrets/ and any live file OpenClaw's own backup left out (in the pinned image: " +
      "session transcripts under agents/<id>/sessions/) are copied in afterwards, computed " +
      "generically — whatever exists live and is absent from OpenClaw's own payload, never " +
      "a hardcoded name — and the count is reported.\n" +
      "Those copies are hot: an append-only transcript's last line can be truncated by a " +
      "write landing mid-copy, the same partial-write risk {--hot} accepts for the whole " +
      "tree, narrowed here to log tails.\n" +
      "If the application declares afterBackup (see docs/guide/data-and-backups.md: Extending " +
      "backup and restore), it " +
      "runs once the archive is published and rotated — never for an internal archive smoke " +
      "takes purely to prove the mechanism works. A hook that fails never deletes the archive: " +
      "the failure is reported with the published path and a non-zero exit.\n" +
      "list — read-only: every archive in the backup directory (name, size, date, profile " +
      "parsed from the name) and every `<data>.replaced-*` copy restore left next to the " +
      "data directory (name, size, date); marks which archive a bare `{clawwright restore}` " +
      "would pick by default. {--json} for machine output.\n" +
      "prune-replaced — deletes `<data>.replaced-*` copies, which otherwise accumulate " +
      "forever: previews what would be removed by default, only {--apply} removes anything, " +
      "{--keep} <n> keeps that many newest instead of deleting all of them.\n" +
      "Refuses anything that is not exactly one of those copies (a symlink, the data " +
      "directory itself, an unrelated name), takes the instance lock while {--apply} runs.\n" +
      "Archive pruning is already handled by this command's own rotation (OC_BACKUP_KEEP) " +
      "— prune-replaced never touches an archive.\n" +
      "install / uninstall — print (and, with {--apply}, install through the transport) a " +
      "crontab entry that runs a plain `{clawwright backup}` every {--interval} (default 1d) — " +
      "30m, 6h or 1d, an explicit unit required (a bare number is minutes only for `watch install`); minutes must divide 60, hours must divide a day; anything " +
      "else is refused, naming the nearest valid values — the schedule OC_BACKUP_KEEP " +
      "presumes but nothing installed before this,\n" +
      "mirroring `watch install`/`watch uninstall` exactly (same marker convention, " +
      "same POSIX-only trust boundary, same Windows fallback: a printed `schtasks` entry, " +
      "applied for real on {--apply} on an actual Windows host).",
    ...BACKUP,
  },
  restore: {
    summary: "Restore an archive over current state",
    group: "save-move",
    details:
      "The archive is validated before anything is stopped or overwritten —\n" +
      "every entry is checked for absolute paths, `..` escapes and links that would " +
      "write outside the data directory, and it is refused outright rather than " +
      "partially unpacked.\n" +
      "The current data is moved aside as <data>.replaced-<timestamp>, never deleted, so " +
      "a wrong restore is recoverable; a failed unpack puts it straight back.\n" +
      "Before starting the gateway (unless {--no-start}), this checks that every secret " +
      "the restored config references is actually available —\n" +
      "a config referencing a variable nothing supplies otherwise crash-loops on " +
      "SecretRefResolutionError.\n" +
      "If the application declares beforeRestore (see docs/guide/data-and-backups.md: " +
      "Extending backup and restore), it runs first — nothing is stopped or moved yet — and can decrypt or fetch " +
      "the real archive, returning the path to restore from instead. A hook that fails stops " +
      "the restore before anything on the target is touched.\n" +
      "{--dry-run} runs the same selection and validation, takes no lock, and reports the " +
      "archive it picked (name, size, date), whether it carries identity, where the current " +
      "data would move to, and the ordered steps a real restore would run — nothing is " +
      "stopped, moved, written or extracted.",
    ...RESTORE,
  },
  pull: {
    summary: "Snapshot the instance to the snapshot directory",
    group: "save-move",
    details:
      "Defaults to migrate, unlike `backup`, which defaults to full: moving an instance's " +
      "state should not silently also hand over provider keys.\n" +
      "Three profiles, and the difference is not cosmetic:\n" +
      "  full ({--with-secrets})  everything, including config/.env and the operator token — never share it\n" +
      "  migrate (default)      everything except provider keys; keys travel beside the archive in <archive>.secrets.env\n" +
      "  share ({--share})        only what an agent's personality actually is: openclaw.json, workspace, plugin-skills\n" +
      "A share pull is verified before it is kept: the archive is unpacked and searched for " +
      "this instance's actual secret values, including inside binary files. A pull that " +
      "fails the check is deleted — both the snapshot and the backup it was copied from — " +
      "rather than left behind under a name that looks like a normal successful pull.\n" +
      "A migrate pull checks the staged archive's listing against the same privacy " +
      "exclusions before publishing — a snapshot carrying config/.env or a recipe's " +
      "declared private paths is rejected and deleted the same way.\n" +
      "Keeps the newest OC_SNAPSHOT_KEEP snapshots (default 10, same as backup's " +
      "OC_BACKUP_KEEP) and removes the rest, sidecar files included — unbounded before, " +
      "on a deployment pulled regularly this filled the snapshot directory forever.",
    ...PULL,
  },
  push: {
    summary: "Push a snapshot onto the instance",
    group: "save-move",
    details:
      "Restores the newest snapshot in the deployment's snapshot directory (or a given " +
      "path), installs whatever provider keys travelled beside it (<archive>.secrets.env, " +
      "produced by a migrate pull),\n" +
      "then checks every required secret is actually present before starting — a share " +
      "snapshot carries no keys at all, so this leaves the instance restored but stopped " +
      "with instructions instead of crash-looping.\n" +
      "{--dry-run} mirrors restore's own (same planner: commands/lifecycle/restore/plan.ts): " +
      "what would be replaced, what the archive holds (identity, structure), and whether a " +
      "secrets sidecar would be installed — nothing is stopped, moved, written or extracted, " +
      "and no lock is taken.",
    ...PUSH,
  },
  verify: {
    summary: "Check a snapshot for credentials",
    group: "save-move",
    details:
      "What `{clawwright pull --share}` runs automatically, callable by hand against any archive.\n" +
      "Structural checks (no absolute paths, no `..` escapes, no link writing outside the " +
      "archive) run first and need no unpacking;\n" +
      "then the archive is unpacked and searched for this instance's actual secret " +
      "values —\n" +
      "provider keys and the gateway token are never acceptable outside `full`, this " +
      "instance's own identity/device tokens are expected in `migrate` but fatal in " +
      "`share`.\n" +
      "A recipe's declared private paths (recipe.json privatePaths — literal, " +
      "data-relative) are refused the same way for migrate and share.\n" +
      "Does not scan for personal content in transcripts or workspace notes — review " +
      "those yourself.\n" +
      "{--json} emits {archive, profile, passed, findings}: each finding is a kind, a " +
      "location (a path, a rule or a provider id) and whether it is fatal under the " +
      "profile that ran — never a credential value.",
    ...VERIFY,
  },
  upgrade: {
    summary: "Update the image by digest; rollback on failure",
    group: "change",
    details:
      "Resolves the target ({--image} <ref>, or the deployment's own OPENCLAW_IMAGE) to a " +
      "digest and pulls that digest specifically — a shared tag another deployment on the " +
      "same Docker may also use never moves.\n" +
      "A tag is re-resolved at the registry every run — that includes OPENCLAW_IMAGE once " +
      "it is already pinned to repo:tag@sha256:…, so upgrade with no {--image} still checks " +
      "whether the tracked tag has moved instead of comparing the pin to itself and always " +
      "finding nothing to do.\n" +
      "{--image} repo@sha256:… names exact content; without a tag it keeps this deployment's tag " +
      "when it names the same repository, so the pin stays a channel a plain upgrade can " +
      "re-resolve — a digest of a different repository pins as-is, and the next plain upgrade " +
      "then needs {--image} <repo:tag>. A pin left with no tag (repo@sha256:… from before pins " +
      "kept one) has no channel to recover without guessing, and is refused with {--image} " +
      "<repo:tag> as the remedy.\n" +
      "Records the currently running digest, takes a consistent pre-upgrade backup (the " +
      "native path from `backup --native` when the image supports it, else a stopped full " +
      "backup), recreates the gateway on the new digest, waits for /startupz then /readyz, " +
      "and runs `openclaw doctor --lint`.\n" +
      "On any failure it recreates on the previous digest; when the failure was the " +
      "container exiting during migrations (upstream: code 78), it also restores the " +
      "pre-upgrade backup, since the data may already have changed.\n" +
      "On success it pins the deployment's OPENCLAW_IMAGE to repo:tag@sha256:… (the " +
      "channel it was resolved from, alongside the new digest), so a later recreate stays " +
      "on it — re-pin the deployment's own record with {clawwright lock} afterwards.\n" +
      "{--dry-run} prints the current digest, the channel, what it resolves to at the " +
      "registry, and whether that is an upgrade — changing nothing, not even taking the " +
      "instance lock.",
    ...UPGRADE,
  },
  smoke: {
    summary: "Acceptance run: health, agent, config, snapshots, MCP",
    group: "check",
    details:
      "Eight checks, the two negative ones matter as much as the positive ones — a suite " +
      "that only confirms success degrades silently:\n" +
      "the gateway is healthy by both the HTTP probes and the runtime's own verdict; the " +
      "agent answers end to end, meaning the provider key actually resolved;\n" +
      "a manually drifted setting is overridden back to the declaration; a snapshot " +
      "restores byte-for-byte;\n" +
      "the verifier both accepts a shareable archive AND rejects one carrying " +
      "credentials; the MCP bridge speaks clean JSON-RPC.\n" +
      "The drift check restores the declaration on its way out, verdict already in; if " +
      "that restore fails, the check fails saying the instance may still hold the drifted " +
      "value and naming {clawwright apply-config} as the repair.\n" +
      "Every check lands as passed, failed, not-checked (this deployment makes the check " +
      "inapplicable) or could-not-check (it could not obtain a verdict — the instance was " +
      "unreachable, the call never answered); the run exits non-zero unless every " +
      "applicable check passed.\n" +
      "Briefly stops the gateway once, for the three archive-based checks (the shareable " +
      "and secret-rejecting snapshots, and the round-trip backup/restore) — one outage " +
      "window, typically well under a minute, not three; every other check runs with the " +
      "gateway up.\n" +
      "{--quick} skips the slow round-trip check, but still shares that one stop/start " +
      "window with the two snapshot checks it does not skip.",
    ...SMOKE,
  },
});

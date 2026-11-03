// Operate command group: exposing the gateway, the watch schedule, incident response and
// .env recovery. Split out of openclawCommands.management.ts; index.ts merges every group's
// fragment into one openclawCommands.

import type { AppCommand } from "#src/core/app.ts";
import { materializeCommands } from "#src/core/command/index.ts";

import { RECOVER_ENV } from "#src/commands/operate/recover-env/index.ts";
import { EXPOSE } from "#src/commands/operate/expose/index.ts";
import { WATCH } from "#src/commands/operate/watch/index.ts";
import { INCIDENT } from "#src/commands/operate/incident/index.ts";

export const operateCommands: Record<string, AppCommand> = materializeCommands({
  expose: {
    summary: "Expose the gateway: SSH tunnel or tailscale",
    group: "security-access",
    details:
      "Three actions, narrowest scope first.\n" +
      "ssh — for OC_TARGET_LOCATION=ssh deployments, prints the exact `ssh -N -L <local>:127.0.0.1:<gatewayPort> " +
      "<OC_SSH_HOST>` tunnel and the http://127.0.0.1:<local> URL it opens; {--run} runs it in the foreground " +
      "through the local ssh client (needs a real terminal — refused under MCP or a plain pipe) until Ctrl+C.\n" +
      "wsl/local targets are told no tunnel is needed: Docker Desktop's WSL2 integration already forwards the " +
      "published port to this machine's own loopback.\n" +
      "tailscale — probes, on the target, whether `tailscale` exists and is logged in (`tailscale status --json`), " +
      "then prints the exact `tailscale serve --bg http://127.0.0.1:<gatewayPort>` command — tailnet-only HTTPS, " +
      "never `tailscale funnel` (refused outright, with the reason, whether or not {--apply} is given).\n" +
      "{--apply} runs it on the target through the transport — mutating, so it needs MCP confirmation and the " +
      "instance lock (guarded()), same as every other mutating command.\n" +
      "status — the published bind address/port read back from the RUNNING container (never just .env, which can " +
      "be stale the moment OC_BIND_ADDRESS is edited without a recreate), whether that is loopback-only, and — if " +
      "tailscale is present — a summary of `tailscale serve status`. Warns loudly when the bind address is " +
      "0.0.0.0 or ::.\n" +
      "The same one-line summary appears in `{clawwright status}`. {--json} emits the same facts " +
      "structured: exposure, configuredBindAddress, bindAddressDrift, tailscale.",
    ...EXPOSE,
  },
  watch: {
    summary: "Health monitoring with webhook alerts",
    group: "check",
    details:
      "Five actions.\n" +
      "check — one probe cycle, reusing exactly the findings `inspect`/`doctor` already " +
      "compute (GATEWAY_DOWN, GATEWAY_UNHEALTHY, NOT_BOOTSTRAPPED, EGRESS_UNREACHABLE — never " +
      "PROVIDER_MISSING, whose detection is unreliable enough that it would page degraded " +
      "forever on an instance answering fine, nor CONFIG_DRIFT or the rest, which are real " +
      "but not about whether the instance is serving),\n" +
      "then adds findings of its own: CHANNEL_UNHEALTHY (degraded) for a " +
      "configured, enabled channel account that `openclaw channels status --json` reports " +
      "not running, erroring or not connected " +
      "(skipped while the gateway itself is down — nothing to exec a CLI call into; " +
      "verified on OpenClaw 2026.6.34 — that CLI has no dead-letter/delivery-failure " +
      "signal, only connection/auth trouble, so that is all this reports),\n" +
      "CHANNEL_UNKNOWN (degraded) when a requested channel read fails or returns malformed or " +
      "incomplete telemetry — it holds back a healthy recovery and the heartbeat ping; an " +
      "unrequested read adds no finding,\n" +
      "CHANNEL_PROXY_DOWN (degraded) when a channel with a finding routes through a proxy " +
      "recipe that is not reporting healthy — one finding per recipe, never the proxy URL,\n" +
      "and DISK_LOW/DISK_UNKNOWN for the data directory's free space against " +
      "OC_WATCH_DISK_MIN_MB (default 1024 MB; degraded below it, down below 10% of it or " +
      "100 MB, whichever is higher; DISK_UNKNOWN — always degraded, never a silent ok — " +
      "when `df` itself fails or cannot be parsed).\n" +
      "All of this collapses into ok / degraded / down.\n" +
      "If gathering the base findings itself fails outright — the Docker daemon down, an " +
      "SSH host refusing the connection, wsl.exe never answering — that reads as down too, " +
      "reason TARGET_UNREACHABLE, rather than dying before a cycle can alert or record " +
      "anything (channel/disk are skipped in that case, and also while NOT_BOOTSTRAPPED — " +
      "no data directory yet to measure).\n" +
      "Compared against this machine's deployment history (atomic write), serialized across " +
      "processes through delivery and persistence; a busy cycle reports contention. SSH operator " +
      "cycles use separate state/watch-operator.json, not the remote scheduled history.\n" +
      "A webhook POST (OC_WATCH_WEBHOOK in " +
      "this deployment's .env, https only unless it is localhost) fires only on a " +
      "TRANSITION, so an unchanged state never pages anyone twice.\n" +
      "A failed POST leaves the persisted level at its old value on purpose, so the same " +
      "unreported transition is retried next cycle instead of being silently accepted as " +
      "normal — but the failure itself, and when it happened, is now recorded (`watch " +
      "status`'s lastError/alertPending), so a broken webhook does not fail forever without " +
      "a trace between cycles.\n" +
      "A configuration error (a bad OC_WATCH_WEBHOOK/OC_WATCH_WEBHOOK_FORMAT/" +
      "OC_WATCH_TELEGRAM_CHAT_ID/OC_WATCH_HEARTBEAT_URL) is recorded the same way, before a " +
      "probe cycle ever runs.\n" +
      "The exit code reflects the CURRENT state on every cycle, alert or not — 0 while ok, " +
      "non-zero otherwise — for a scheduler to branch on without reading the text.\n" +
      "The webhook URL is never printed, anywhere, including on failure.\n" +
      "The webhook payload shape follows OC_WATCH_WEBHOOK_FORMAT (generic/slack/discord/" +
      "telegram), or autodetects from the URL host when unset (hooks.slack.com, discord.com/" +
      "discordapp.com with /api/webhooks/, api.telegram.org).\n" +
      "generic keeps the original {deployment, from, to, reasons, at} JSON; slack/discord/" +
      "telegram instead get a one-two line human message (deployment, from → to, reason " +
      "codes with a short detail each, and the time), truncated to fit that format's own " +
      "documented limit (Slack 40000, Discord's `content` 2000, Telegram's `text` 4096).\n" +
      "telegram additionally needs OC_WATCH_TELEGRAM_CHAT_ID — refused as a configuration " +
      "error, the same way a bad URL is, before any probe cycle runs — and treats a 2xx " +
      "response carrying `ok:false` as an undelivered alert exactly like a failed POST " +
      "(state kept, retried next cycle).\n" +
      "OC_WATCH_HEARTBEAT_URL adds a dead-man's switch: a plain GET, fired every cycle whose " +
      "OWN level reads ok (never on degraded/down, and never affecting level or exit code on " +
      "its own) — https only unless it is localhost, a secret registered the same way the " +
      "webhook is.\n" +
      "Works with healthchecks.io, Uptime Kuma's push monitor and Better Stack's heartbeat " +
      "monitor, all three of which accept a bare GET.\n" +
      "When the instance, or the scheduler running `watch check` itself, stops entirely, " +
      "the pings simply stop and that external service raises its own alert — the one " +
      "failure mode a webhook fired FROM here can never report.\n" +
      "A failed ping is a warning in this cycle's output and in `watch status` (last " +
      "heartbeat error), never a level change or a non-zero exit by itself.\n" +
      "install / uninstall — print (and, with {--apply}, install through the transport) a " +
      "crontab entry that runs `watch check` every {--interval} (default 5m; a bare number is " +
      "minutes, or 30m/6h/1d like `backup install`; minutes must divide 60 — 1,2,3,4,5,6,10,12," +
      "15,20,30 — hours must divide a day — 1,2,3,4,6,8,12,24 — anything else is refused, " +
      "naming the nearest valid values, rather than silently misfiring),\n" +
      "marked so a re-run replaces only its own line and uninstall removes only it.\n" +
      "Cron installation refuses % in the working directory, command, arguments or marker " +
      "before touching the scheduler, including a percent preceded by a backslash.\n" +
      "Only where this framework can actually trust an unattended cron to find this " +
      "tooling's own node and checkout: a real SSH host (deploy already mirrored the " +
      "checkout there) or a POSIX `local` target.\n" +
      "A WSL target's Docker distro is not such a place (a `local` target is refused on " +
      "Windows) — there this prints, instead of installing something that silently " +
      "never runs, the exact command an operator-side scheduler would need to invoke, using " +
      "the transport's own clientInvocation().\n" +
      "On an actual Windows host it also prints a " +
      "ready `schtasks /create` command (the WSL target's own `wsl.exe -d <distro> --exec bash -lc \"set -e; cd -- …; exec …\"` line); " +
      "`/f` replaces the same named task on a re-run, the Task Scheduler " +
      "counterpart to the crontab marker. schtasks accepts at most 261 characters for the " +
      "action, so a longer one is refused — no schtasks line is printed and {--apply} creates " +
      "nothing; shorten the deployment path or app name.\n" +
      "{--apply} on that same Windows host actually runs " +
      "it, through the same host-spawn helper every other bare-machine action uses; anywhere " +
      "else this only ever prints — it never touches a real crontab or scheduled task by " +
      "itself.\n" +
      "status — the persisted last state, when it last changed, and whether a webhook/" +
      "heartbeat is configured (plus the heartbeat's own last successful ping time, and its " +
      "last failure if the most recent ping did not succeed) — never either URL itself.\n" +
      "SSH status reads target-side scheduled history through transport, never local ad-hoc " +
      "cycles; unavailable history is unknown. Local/WSL scheduled history is operator-side. " +
      "Install stores location/interval in state/watch-schedule.json beside that history.\n" +
      "Also reports when `watch check` last ran at all (a config error or a failed delivery " +
      "still counts), the most recent config/delivery error, an alert still waiting to be " +
      "delivered (since when, and what transition), and warns when that last run is stale —\n" +
      "more than 3x the interval `watch install {--apply}` recorded, or 3x the default (5 " +
      "minutes) when no interval was ever recorded (a state file from before this field, or " +
      "a schedule wired up by hand outside `watch install`).\n" +
      "test — sends one webhook message (clearly marked as a test, never shaped like a real " +
      "transition) and one heartbeat ping through whichever of OC_WATCH_WEBHOOK/" +
      "OC_WATCH_HEARTBEAT_URL is configured, so delivery can be proven before a real outage " +
      "is the first time it is tried.\n" +
      "Reports success or failure per target and exits non-zero if a configured one failed; " +
      "says so plainly when neither is configured.\n" +
      "Never touches level/reasons or a pending alert — only the heartbeat's own last-ping " +
      "fields move, the same way a real cycle's heartbeat ping does.",
    ...WATCH,
  },
  incident: {
    summary: "Contain, collect evidence, rotate tokens, audit",
    group: "security-access",
    details:
      "OpenClaw's own incident runbook, in order: contain — turns off, on the target, only the " +
      "`tailscale serve` route(s) that proxy to THIS gateway (never `tailscale serve reset`, " +
      "which would also drop every other service's own route on that host);\n" +
      "when the route shape cannot be parsed reliably, nothing is turned off and the exact " +
      "manual command is printed instead.\n" +
      "Refuses the whole run outright while the gateway is published on every " +
      "interface (0.0.0.0/::) — set OC_BIND_ADDRESS=127.0.0.1 and {clawwright up}, or pass " +
      "{--keep-exposure} if that is already handled elsewhere.\n" +
      "A contain failure (most commonly, " +
      "this account is not the tailscale operator on the target — the report names the fix) is " +
      "noted, never fatal: rotate still runs.\n" +
      "preserve — before rotate can recreate the " +
      "container, a log tail and a raw `docker inspect` of the container running right now are " +
      "written into this run's own evidence directory;\n" +
      "compose removes the old container once " +
      "the new one is up, and its json-file log goes with it, so this has to happen first.\n" +
      "rotate — a fresh OPENCLAW_GATEWAY_TOKEN, written to .env and recreated into the running " +
      "container so it actually takes effect (a repo-env value like this one is fixed at " +
      "container-creation time);\n" +
      "every MCP client paired against the old token needs " +
      "{clawwright mcp-creds} again.\n" +
      "audit — the same security gate `{clawwright doctor}`/`{clawwright accept}` " +
      "run, plus `openclaw doctor --lint`, both reported here rather than gating the run.\n" +
      "collect " +
      "— a bounded log tail of whatever is running by then, both audit outputs and a short " +
      "status summary, joined with preserve's own files into one manifest, into a private, " +
      "owner-only apps/<name>/incidents/<timestamp>/ directory — never inside the repository's " +
      "tracked tree (apps/ is gitignored wholesale);\n" +
      "every file is masked for known secrets " +
      "before it is written.\n" +
      "preserve and collect run and write unconditionally, even when " +
      "rotate or audit fails: the report still shows where the evidence landed, and the " +
      "original failure still reaches you afterwards as a non-zero exit.\n" +
      "Mutating (rotate recreates the gateway) — takes the instance lock. {--dry-run} prints the " +
      "plan and performs none of it, not even taking the lock.",
    ...INCIDENT,
    structured: true,
  },
  "recover-env": {
    summary: "Repair .env from the running instance",
    group: "integrations",
    details:
      "OC_DATA_DIR, OPENCLAW_GATEWAY_PORT, OC_COMPOSE_PROJECT and OPENCLAW_IMAGE are plumbing, not " +
      "secrets, and compose resolved them from this same .env at container-creation time, so one " +
      "docker inspect of the running container reads the answers back.\n" +
      "Each recovered value is merged into the existing .env — already-correct values are " +
      "untouched, and a fact Docker's answer does not carry is named and left as it is, never " +
      "guessed.\n" +
      "For a stale or half-filled .env — a wholly absent one is not repairable here, because " +
      "reaching the target to inspect anything already requires the .env that names the target " +
      "and its transport (bootstrap creates it).\n" +
      "The file is rewritten with the same owner-only protection secrets --apply uses, because " +
      "OPENCLAW_GATEWAY_TOKEN lives beside these lines and protection is per-file; unrelated " +
      "lines pass through untouched.\n" +
      "A plain recover-env fills only the fact names the file is missing entirely and reports " +
      "the ones both sides carry differently without writing over them; {--adopt-runtime} is the " +
      "container-authoritative direction that also merges those over the file's existing values.\n" +
      "{--dry-run} prints what would change and writes nothing.",
    ...RECOVER_ENV,
  },
});

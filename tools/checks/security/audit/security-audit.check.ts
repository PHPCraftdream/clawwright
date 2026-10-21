// runSecurityAudit(): in-instance findings (security audit + secrets audit) parsed from the
// real JSON shapes captured against the pinned image (2026.6.34), suppressions, the two
// host-side checks (public bind, DOCKER-USER/UFW bypass), and secret-file permissions.

import { mkdir, mkdtemp, rm, writeFile, readFile, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { privateFileProblems, runSecurityAudit } from "#framework/security/audit.ts";
import { blockingProblems } from "#framework/service/inspection.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { createPrivateFile, protectPrivateDirectory, protectPrivateFile } from "#framework/security/privacy/private-file.ts";
import { spawnLocal } from "#framework/runtime/transport/transport.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

function codes(problems: readonly { code: string }[]): string[] {
  return problems.map((entry) => entry.code).sort();
}

interface StubOptions {
  running?: boolean;
  /** stdout each CLI call answers with, keyed by "security audit" / "secrets audit". */
  cliAnswers?: Record<string, string>;
  /** Calls that should throw instead of answering (simulates a call the instance refused). */
  cliThrows?: Set<string>;
  connectionFacts?: { bindAddress?: string; port?: string } | undefined;
  transportExec?: Context["transport"]["exec"];
}

function stubContext(options: StubOptions = {}): Context {
  const running = options.running ?? true;
  return {
    settings: { env: {}, bindAddress: "127.0.0.1", gatewayPort: "18789" },
    runtime: {
      description: "stub",
      async isRunning(): Promise<boolean> {
        return running;
      },
      async runningConnectionFacts() {
        return options.connectionFacts;
      },
      async runOneOff(_service: string, args: string[]): Promise<ExecResult> {
        const key = args.slice(0, 2).join(" ");
        if (options.cliThrows?.has(key) === true) throw new Error(`${key} refused`);
        const stdout = options.cliAnswers?.[key];
        if (stdout === undefined) throw new Error(`unexpected cli call: ${args.join(" ")}`);
        return { code: 0, stdout, stderr: "" };
      },
    },
    transport: {
      description: "stub",
      // Default: a bare host with neither ufw nor iptables — ufwDockerBypassProblem's own
      // `command -v` presence probe (index.ts's commandPresent) must see a plain "not found"
      // here, not the "unexpected exec" throw below, or every wildcard-bind test that does not
      // care about UFW at all would have to know about that probe just to avoid crashing.
      exec: options.transportExec ?? (async (command: string, args: string[]): Promise<ExecResult> => {
        if (command === "sh" && (args[1] ?? "").startsWith("command -v ")) return { code: 1, stdout: "", stderr: "" };
        throw new Error(`unexpected exec: ${command} ${args.join(" ")}`);
      }),
    },
  } as unknown as Context;
}

async function withDeployment<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(resolve(tmpdir(), "clawwright-security-audit-check-"));
  await mkdir(resolve(dir, "config"), { recursive: true });
  await mkdir(resolve(dir, "secrets"), { recursive: true });
  useDeployment(dir);
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- in-instance findings: real JSON shapes captured against 2026.6.34 ---------------------

const SECURITY_AUDIT_JSON = JSON.stringify({
  ts: 1,
  summary: { critical: 1, warn: 1, info: 1 },
  findings: [
    { checkId: "summary.attack_surface", severity: "info", title: "Attack surface summary", detail: "..." },
    {
      checkId: "gateway.trusted_proxies_missing",
      severity: "warn",
      title: "Reverse proxy headers are not trusted",
      detail: "gateway.bind is loopback and gateway.trustedProxies is empty.",
      remediation: "Set gateway.trustedProxies to your proxy IPs.",
    },
    {
      checkId: "gateway.loopback_no_auth",
      severity: "critical",
      title: "Gateway auth missing on loopback",
      detail: "gateway.bind is loopback but no gateway auth secret is configured.",
      remediation: "Set gateway.auth (token recommended).",
    },
  ],
});

const SECRETS_AUDIT_JSON = JSON.stringify({
  version: 1,
  status: "dirty",
  summary: { plaintextCount: 1, unresolvedRefCount: 0, shadowedRefCount: 0, legacyResidueCount: 1 },
  findings: [
    {
      code: "PLAINTEXT_FOUND",
      severity: "warn",
      file: "openclaw.json",
      jsonPath: "models.providers.zai.apiKey",
      message: "models.json provider apiKey is stored as plaintext.",
      provider: "zai",
    },
    {
      code: "REF_UNRESOLVED",
      severity: "error",
      file: "openclaw.json",
      jsonPath: "providers.zai.apiKey",
      message: "Failed to resolve env:zai:apikey (not set).",
      provider: "zai",
    },
    {
      code: "LEGACY_RESIDUE",
      severity: "info",
      file: "auth.db",
      jsonPath: "profiles.zai",
      message: "OAuth credentials are present (out of scope for static SecretRef migration).",
      provider: "zai",
    },
  ],
});

await withDeployment(async () => {
  const ctx = stubContext({
    cliAnswers: { "security audit": SECURITY_AUDIT_JSON, "secrets audit": SECRETS_AUDIT_JSON },
  });
  const report = await runSecurityAudit(ctx);

  check("info-severity findings are dropped (attack-surface summary, OAuth residue)", report.findings.some((f) => f.checkId === "summary.attack_surface" || f.checkId === "LEGACY_RESIDUE"), false);
  checkTrue("critical security-audit finding maps to a blocking problem", codes(blockingProblems(report.problems)).includes("SECURITY_AUDIT_CRITICAL"));
  checkTrue("warn security-audit finding maps to a warning problem", report.problems.some((p) => p.code === "SECURITY_AUDIT_WARN" && p.detail.includes("gateway.trusted_proxies_missing")));
  checkTrue("error secrets-audit finding maps to blocking too", report.problems.some((p) => p.code === "SECURITY_AUDIT_CRITICAL" && p.detail.includes("REF_UNRESOLVED")));
  checkTrue("warn secrets-audit finding carries its jsonPath, never a value", report.problems.some((p) => p.detail.includes("models.providers.zai.apiKey") && !p.detail.includes("sk-")));
  check("a security-audit finding's own remediation becomes its nextAction", report.problems.find((p) => p.detail.includes("gateway.loopback_no_auth"))?.nextAction, "Set gateway.auth (token recommended).");
  check("a secrets-audit finding has no remediation, so nextAction points at the CLI", report.problems.find((p) => p.detail.includes("PLAINTEXT_FOUND"))?.nextAction, "./clawwright cli secrets audit --json");
});

// --- not running: no in-instance findings at all --------------------------------------------

await withDeployment(async () => {
  const ctx = stubContext({ running: false });
  const report = await runSecurityAudit(ctx);
  check("a stopped instance runs no in-instance audits", report.findings.length, 0);
});

// --- a call the instance refuses is reported, never silently dropped ------------------------

await withDeployment(async () => {
  const ctx = stubContext({
    cliAnswers: { "security audit": SECURITY_AUDIT_JSON },
    cliThrows: new Set(["secrets audit"]),
  });
  const report = await runSecurityAudit(ctx);
  const unavailable = report.findings.find((f) => f.checkId === "AUDIT_UNAVAILABLE");
  check("a refused audit call is reported as unavailable, not silently skipped", unavailable?.source, "secrets-audit");
  check("it is a warning, not blocking", unavailable?.severity, "warning");
  checkTrue("the other audit's findings still come through", report.findings.some((f) => f.source === "security-audit"));
});

// --- suppressions: still visible, no longer counted ------------------------------------------

await withDeployment(async (dir) => {
  await writeFile(
    resolve(dir, "config", "security-suppressions.json"),
    JSON.stringify({ suppressions: [{ checkId: "gateway.trusted_proxies_missing", reason: "reverse proxy is out of scope here" }] }),
    "utf8",
  );
  const ctx = stubContext({ cliAnswers: { "security audit": SECURITY_AUDIT_JSON, "secrets audit": SECRETS_AUDIT_JSON } });
  const report = await runSecurityAudit(ctx);

  const suppressed = report.findings.find((f) => f.checkId === "gateway.trusted_proxies_missing");
  check("a suppressed finding stays in findings", suppressed?.suppressed, true);
  check("carrying its reason", suppressed?.suppressedReason, "reverse proxy is out of scope here");
  check("a suppressed finding is not counted in problems", report.problems.some((p) => p.detail.includes("gateway.trusted_proxies_missing")), false);
  checkTrue("an unsuppressed finding from the same run still counts", report.problems.some((p) => p.detail.includes("gateway.loopback_no_auth")));
});

await withDeployment(async (dir) => {
  await writeFile(resolve(dir, "config", "security-suppressions.json"), "{ not json", "utf8");
  const ctx = stubContext({ cliAnswers: { "security audit": SECURITY_AUDIT_JSON, "secrets audit": SECRETS_AUDIT_JSON } });
  let thrown = "";
  try {
    await runSecurityAudit(ctx);
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
  }
  checkTrue("a broken suppressions file fails closed rather than reading as \"nothing suppressed\"", thrown !== "");
});

await withDeployment(async (dir) => {
  await writeFile(resolve(dir, "config", "security-suppressions.json"), JSON.stringify({ suppressions: [{ checkId: "x" }] }), "utf8");
  const ctx = stubContext({});
  let thrown = "";
  try {
    await runSecurityAudit(ctx);
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
  }
  checkTrue("a suppression missing its reason is refused", thrown.includes("reason"));
});

// --- scoped suppressions: a `match` narrows a checkId entry to one finding text --------------

// Real finding shapes (2026.6.34): the DM-policy check fires per account, and the exposure
// check lists every open context plus a runtime/FS line — instance-wide suppression of either
// would also silence future exposures of other accounts/agents.
const TELEGRAM_DM_JSON = JSON.stringify({ findings: [
  {
    checkId: "channels.telegram.dm.open",
    severity: "warn",
    detail: "channels.telegram.accounts.public.dmPolicy=\"open\" allows anyone to DM the bot.",
  },
  {
    checkId: "channels.telegram.dm.open",
    severity: "warn",
    detail: "channels.telegram.accounts.other.dmPolicy=\"open\" allows anyone to DM the bot.",
  },
] });

const EXPOSURE_JSON = JSON.stringify({ findings: [
  {
    checkId: "security.exposure.open_groups_with_runtime_or_fs",
    severity: "critical",
    detail: "Found inbound policy=\"open\" at:\n- channels.telegram.accounts.public.dmPolicy=\"open\"\nRuntime/process tools are exposed without full sandboxing in at least one context.\n- agents.list.main (sandbox=off; runtime=[exec, process])",
  },
] });

function dmAnswered(): Record<string, string> {
  return { "security audit": TELEGRAM_DM_JSON, "secrets audit": "{\"findings\":[]}" };
}

await withDeployment(async (dir) => {
  const scoped = { suppressions: [{ checkId: "channels.telegram.dm.open", match: "channels.telegram.accounts.public", reason: "r-public" }] };
  await writeFile(resolve(dir, "config", "security-suppressions.json"), JSON.stringify(scoped), "utf8");
  const report = await runSecurityAudit(stubContext({ cliAnswers: dmAnswered() }));
  check("match narrows the suppression to the finding whose text carries the path", ["channels.telegram.accounts.public", "channels.telegram.accounts.other"].map((account) => {
    const finding = report.findings.find((f) => f.message.includes(`${account}.dmPolicy`));
    return { suppressed: finding?.suppressed, suppressedReason: finding?.suppressedReason };
  }), [{ suppressed: true, suppressedReason: "r-public" }, { suppressed: false, suppressedReason: undefined }]);
});

await withDeployment(async (dir) => {
  // No `match`: exactly today's behaviour — the whole check instance-wide.
  await writeFile(
    resolve(dir, "config", "security-suppressions.json"),
    JSON.stringify({ suppressions: [{ checkId: "channels.telegram.dm.open", reason: "dmPolicy accepted here" }] }),
    "utf8",
  );
  const report = await runSecurityAudit(stubContext({ cliAnswers: dmAnswered() }));
  check("a checkId-only entry is still instance-wide", report.findings.filter((f) => f.checkId === "channels.telegram.dm.open").map((f) => f.suppressed), [true, true]);
});

await withDeployment(async (dir) => {
  const scoped = { suppressions: [
    { checkId: "channels.telegram.dm.open", match: "channels.telegram.accounts.public", reason: "r-public" },
    { checkId: "channels.telegram.dm.open", match: "channels.telegram.accounts.other", reason: "r-other" },
  ] };
  await writeFile(resolve(dir, "config", "security-suppressions.json"), JSON.stringify(scoped), "utf8");
  const report = await runSecurityAudit(stubContext({ cliAnswers: dmAnswered() }));
  check("two entries, same checkId, different match, both apply", report.findings.map((f) => f.suppressedReason), ["r-public", "r-other"]);
});

await withDeployment(async (dir) => {
  // Both entries match the public finding; file order decides — the earlier one wins.
  const scoped = { suppressions: [
    { checkId: "channels.telegram.dm.open", match: "channels.telegram.accounts.", reason: "r-first" },
    { checkId: "channels.telegram.dm.open", match: "channels.telegram.accounts.public", reason: "r-second" },
  ] };
  await writeFile(resolve(dir, "config", "security-suppressions.json"), JSON.stringify(scoped), "utf8");
  const report = await runSecurityAudit(stubContext({ cliAnswers: dmAnswered() }));
  check("first matching entry wins, in file order", report.findings.map((f) => f.suppressedReason), ["r-first", "r-first"]);
});

await withDeployment(async (dir) => {
  // The exposure finding lists several contexts; a match must still be present verbatim in it.
  const scoped = { suppressions: [{ checkId: "security.exposure.open_groups_with_runtime_or_fs", match: "channels.telegram.accounts.public", reason: "r-exposure" }] };
  await writeFile(resolve(dir, "config", "security-suppressions.json"), JSON.stringify(scoped), "utf8");
  const report = await runSecurityAudit(stubContext({ cliAnswers: { "security audit": EXPOSURE_JSON, "secrets audit": "{\"findings\":[]}" } }));
  check("a match found anywhere in the finding's full text suppresses the multi-context finding", report.findings.map((f) => f.suppressedReason), ["r-exposure"]);
});

await withDeployment(async (dir) => {
  await writeFile(resolve(dir, "config", "security-suppressions.json"), JSON.stringify({ suppressions: [{ checkId: "x", reason: "r", match: "" }] }), "utf8");
  const ctx = stubContext({});
  let thrown = "";
  try {
    await runSecurityAudit(ctx);
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
  }
  checkTrue("an empty match is refused", thrown.includes("non-empty"));
});

await withDeployment(async (dir) => {
  await writeFile(resolve(dir, "config", "security-suppressions.json"), JSON.stringify({ suppressions: [{ checkId: "x", reason: "r", match: 7 }] }), "utf8");
  const ctx = stubContext({});
  let thrown = "";
  try {
    await runSecurityAudit(ctx);
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
  }
  checkTrue("a non-string match is refused", thrown.includes("match"));
});

// --- host-side: the gateway published on every interface -------------------------------------

await withDeployment(async () => {
  const ctx = stubContext({ running: false, connectionFacts: { bindAddress: "127.0.0.1", port: "18789" } });
  const report = await runSecurityAudit(ctx);
  check("not running: the bind check does not fire (nothing to read from the container)", report.problems.some((p) => p.code.startsWith("GATEWAY_")), false);
});

await withDeployment(async () => {
  const ctx = stubContext({ connectionFacts: { bindAddress: "127.0.0.1", port: "18789" } });
  const report = await runSecurityAudit(ctx);
  check("loopback: no public-bind finding", report.problems.some((p) => p.code === "GATEWAY_PUBLICLY_BOUND"), false);
});

await withDeployment(async () => {
  const ctx = stubContext({ connectionFacts: { bindAddress: "0.0.0.0", port: "18789" } });
  const report = await runSecurityAudit(ctx);
  checkTrue("published on every interface: blocking", codes(blockingProblems(report.problems)).includes("GATEWAY_PUBLICLY_BOUND"));
});

await withDeployment(async (dir) => {
  await writeFile(
    resolve(dir, "config", "security-suppressions.json"),
    JSON.stringify({ acknowledgePublicBind: { reason: "behind a hardware firewall" } }),
    "utf8",
  );
  const ctx = stubContext({ connectionFacts: { bindAddress: "0.0.0.0", port: "18789" } });
  const report = await runSecurityAudit(ctx);
  check("acknowledged exposure is a warning, not blocking", report.problems.some((p) => p.code === "GATEWAY_PUBLICLY_BOUND"), false);
  checkTrue("and names the acknowledgement", report.problems.some((p) => p.code === "GATEWAY_EXPOSURE_ACKNOWLEDGED" && p.detail.includes("hardware firewall")));
});

// --- host-side: UFW active + DOCKER-USER bypass, only when the port is actually public -------

/** `absent` means `sh -c 'command -v <name>'` answers "not found" (exit 1, empty stdout) —
 *  the same shape a real SshTransport/WslTransport gives for a genuinely missing command,
 *  never an exception (that is the bug this stub exists to pin: a raw exec's exit 127
 *  must not be the only way "not installed" is told apart from "installed but failed"). */
function ufwTransport(
  ufw: "absent" | ExecResult,
  iptables?: "absent" | ExecResult,
): Context["transport"]["exec"] {
  return async (command: string, args: string[]): Promise<ExecResult> => {
    if (command === "sh") {
      const probe = /command -v (\w+)/.exec(args[1] ?? "")?.[1];
      if (probe === "ufw") return ufw === "absent" ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: "/usr/sbin/ufw\n", stderr: "" };
      if (probe === "iptables") return iptables === "absent" || iptables === undefined ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: "/usr/sbin/iptables\n", stderr: "" };
      throw new Error(`unexpected sh probe: ${args.join(" ")}`);
    }
    if (command === "ufw") {
      if (ufw === "absent") throw new Error("must not exec ufw once command -v reported it absent");
      return ufw;
    }
    if (command === "iptables") {
      if (iptables === undefined || iptables === "absent") throw new Error("must not exec iptables once command -v reported it absent");
      return iptables;
    }
    throw new Error(`unexpected exec: ${command}`);
  };
}

await withDeployment(async () => {
  const ctx = stubContext({
    connectionFacts: { bindAddress: "127.0.0.1", port: "18789" },
    transportExec: async () => { throw new Error("must not be called for a loopback-only gateway"); },
  });
  const report = await runSecurityAudit(ctx);
  check("loopback gateway: UFW/DOCKER-USER is never even probed", report.problems.some((p) => p.code === "UFW_DOCKER_BYPASS"), false);
});

await withDeployment(async () => {
  const ctx = stubContext({
    connectionFacts: { bindAddress: "0.0.0.0", port: "18789" },
    transportExec: ufwTransport("absent"),
  });
  const report = await runSecurityAudit(ctx);
  check("ufw not installed (command -v exit 1, no exception — the SSH/WSL shape): not applicable, no finding", report.problems.some((p) => p.code === "UFW_DOCKER_BYPASS"), false);
});

await withDeployment(async () => {
  const ctx = stubContext({
    connectionFacts: { bindAddress: "0.0.0.0", port: "18789" },
    transportExec: ufwTransport({ code: 0, stdout: "Status: inactive\n", stderr: "" }),
  });
  const report = await runSecurityAudit(ctx);
  check("ufw confirmed inactive: no finding", report.problems.some((p) => p.code === "UFW_DOCKER_BYPASS"), false);
});

await withDeployment(async () => {
  const ctx = stubContext({
    connectionFacts: { bindAddress: "0.0.0.0", port: "18789" },
    transportExec: ufwTransport({ code: 1, stdout: "", stderr: "ERROR: You need to be root to run this script" }),
  });
  const report = await runSecurityAudit(ctx);
  const finding = report.problems.find((p) => p.code === "UFW_DOCKER_BYPASS");
  check("ufw present but no permission: reported as could-not-check, never as fine", finding?.detail.includes("could not determine"), true);
  check("still a warning, not blocking", blockingProblems(report.problems).some((p) => p.code === "UFW_DOCKER_BYPASS"), false);
});

await withDeployment(async () => {
  const ctx = stubContext({
    connectionFacts: { bindAddress: "0.0.0.0", port: "18789" },
    transportExec: ufwTransport({ code: 0, stdout: "Status: active\n", stderr: "" }, "absent"),
  });
  const report = await runSecurityAudit(ctx);
  check("ufw active, no iptables (command -v exit 1): could-not-check", report.problems.find((p) => p.code === "UFW_DOCKER_BYPASS")?.detail.includes("not available"), true);
});

await withDeployment(async () => {
  const ctx = stubContext({
    connectionFacts: { bindAddress: "0.0.0.0", port: "18789" },
    transportExec: ufwTransport(
      { code: 0, stdout: "Status: active\n", stderr: "" },
      { code: 1, stdout: "", stderr: "iptables: Permission denied (you must be root)" },
    ),
  });
  const report = await runSecurityAudit(ctx);
  check("ufw active, iptables needs root: could-not-check", report.problems.find((p) => p.code === "UFW_DOCKER_BYPASS")?.detail.includes("could not be read"), true);
});

await withDeployment(async () => {
  const ctx = stubContext({
    connectionFacts: { bindAddress: "0.0.0.0", port: "18789" },
    transportExec: ufwTransport(
      { code: 0, stdout: "Status: active\n", stderr: "" },
      { code: 0, stdout: "Chain DOCKER-USER (1 references)\ntarget  prot opt source  destination\nRETURN  all  --  0.0.0.0/0  0.0.0.0/0\n", stderr: "" },
    ),
  });
  const report = await runSecurityAudit(ctx);
  check("ufw active, DOCKER-USER has no restricting rule: bypass warning", blockingProblems(report.problems).some((p) => p.code === "UFW_DOCKER_BYPASS"), false);
  check("named as such", report.problems.find((p) => p.code === "UFW_DOCKER_BYPASS")?.detail.includes("bypass"), true);
});

await withDeployment(async () => {
  const ctx = stubContext({
    connectionFacts: { bindAddress: "0.0.0.0", port: "18789" },
    transportExec: ufwTransport(
      { code: 0, stdout: "Status: active\n", stderr: "" },
      { code: 0, stdout: "Chain DOCKER-USER (1 references)\ntarget  prot opt source  destination\nDROP  all  --  0.0.0.0/0  0.0.0.0/0\nRETURN  all  --  0.0.0.0/0  0.0.0.0/0\n", stderr: "" },
    ),
  });
  const report = await runSecurityAudit(ctx);
  check("a DOCKER-USER rule that restricts traffic: no bypass finding", report.problems.some((p) => p.code === "UFW_DOCKER_BYPASS"), false);
});

// --- host-side: the deployment's own secret file permissions --------------------------------

await withDeployment(async (dir) => {
  const denied = (code: string): NodeJS.ErrnoException => Object.assign(new Error("sensitive diagnostic"), { code });
  const problems = await privateFileProblems({
    list: async () => { throw denied("EACCES"); },
    readable: async () => { throw denied("EIO"); },
  });
  check("unreadable directory and file are both reported", problems.map((entry) => entry.code), ["PRIVATE_FILE_UNREADABLE", "PRIVATE_FILE_UNREADABLE"]);
  check("findings identify paths and errno without exception text", problems.map((entry) => entry.detail), [
    `${resolve(dir, "secrets")} could not be checked (EACCES)`,
    `${resolve(dir, ".env")} could not be checked (EIO)`,
  ]);
  const absent = await privateFileProblems({
    list: async () => { throw denied("ENOENT"); },
    readable: async () => { throw denied("ENOENT"); },
  });
  check("only ENOENT means absent", absent.length, 0);
});

await withDeployment(async (dir) => {
  const denied = Object.assign(new Error("sensitive diagnostic"), { code: "EACCES" });
  const problems = await privateFileProblems({
    list: async () => [{ name: "local.env", isFile: () => true }],
    readable: async (file) => { if (file === resolve(dir, "secrets", "local.env")) throw denied; },
  });
  check("an unreadable secret file is reported", problems.some((entry) => entry.code === "PRIVATE_FILE_UNREADABLE" && entry.detail.includes("local.env")), true);
  check("the exception text is not leaked", problems.some((entry) => entry.detail.includes("sensitive diagnostic")), false);
});

await withDeployment(async (dir) => {
  await createPrivateFile(resolve(dir, ".env"), "OPENCLAW_GATEWAY_TOKEN=check-value\n");
  await protectPrivateDirectory(resolve(dir, "secrets"));
  await createPrivateFile(resolve(dir, "secrets", "local.env"), "ZAI_API_KEY=check-value\n");
  const ctx = stubContext({ running: false });
  const report = await runSecurityAudit(ctx);
  check("owner-only .env and secrets/*: no PRIVATE_FILE_INSECURE finding", report.problems.some((p) => p.code === "PRIVATE_FILE_INSECURE"), false);
});

await withDeployment(async (dir) => {
  const output = resolve(dir, "operator-copies");
  const prior = resolve(output, "prior.dat");
  await mkdir(output);
  await writeFile(prior, "prior owned bytes");
  try {
    await protectPrivateDirectory(output);
    check("sealing a directory retains owner access to inherited files", await readFile(prior, "utf8"), "prior owned bytes");
    await writeFile(prior, "updated owned bytes");
    check("owner can update an inherited file after directory sealing", await readFile(prior, "utf8"), "updated owned bytes");
  } finally {
    await protectPrivateFile(prior, { boundary: false });
  }
});

await withDeployment(async (dir) => {
  const envPath = resolve(dir, ".env");
  await writeFile(envPath, "OPENCLAW_GATEWAY_TOKEN=check-value\n", "utf8");

  if (process.platform === "win32") {
    const systemTool = (name: string): string => join(process.env.SystemRoot ?? "C:\\Windows", "System32", name);
    const widened = await spawnLocal(systemTool("icacls.exe"), [envPath, "/grant", "*S-1-5-32-546:R"], { allowFailure: true, timeoutMs: 15_000 });
    check("test setup: the review grant applied", widened.code, 0);
  } else {
    await chmod(envPath, 0o644);
  }

  const ctx = stubContext({ running: false });
  const report = await runSecurityAudit(ctx);
  const finding = report.problems.find((p) => p.code === "PRIVATE_FILE_INSECURE");
  check("a widened .env is reported", finding?.detail.includes(envPath), true);
  check("never with the secret value", finding?.detail.includes("check-value"), false);
});

// --- the in-container "lan" bind: loopback-only publishing downgrades, 0.0.0.0 does not ---

const CONTAINER_BIND_JSON = JSON.stringify({ findings: [
  { checkId: "gateway.control_ui.allowed_origins_required", severity: "critical", title: "t", detail: "Control UI is enabled on a non-loopback bind but gateway.controlUi.allowedOrigins is empty." },
] });

await withDeployment(async () => {
  const loopback = await runSecurityAudit(stubContext({
    cliAnswers: { "security audit": CONTAINER_BIND_JSON, "secrets audit": "{\"findings\":[]}" },
    connectionFacts: { bindAddress: "127.0.0.1", port: "18789" },
  }));
  check("a container-bind finding is a warning when the host publishes on loopback only", codes(loopback.problems), ["SECURITY_AUDIT_WARN"]);
  check("and says why", loopback.problems[0]?.detail.includes("loopback only"), true);

  const wildcard = await runSecurityAudit(stubContext({
    cliAnswers: { "security audit": CONTAINER_BIND_JSON, "secrets audit": "{\"findings\":[]}" },
    connectionFacts: { bindAddress: "0.0.0.0", port: "18789" },
    transportExec: async () => ({ code: 1, stdout: "", stderr: "" }),
  }));
  checkTrue("the same finding stays blocking when the host publishes on every interface", codes(blockingProblems(wildcard.problems)).includes("SECURITY_AUDIT_CRITICAL"));
});

finish("security-audit");

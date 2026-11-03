// Pure half of the security gate: parsing OpenClaw's `security audit --json` findings and the
// OC_AUDIT_BLOCK threshold, plus suppression matching. Knows no check names — which findings
// exist is OpenClaw's business.

export type AuditSeverity = "critical" | "warn" | "info";
export type AuditBlockPolicy = "critical" | "warn";

export interface ParsedAuditFinding {
  readonly checkId: string;
  readonly title: string;
  readonly detail: string;
  readonly severity: AuditSeverity;
  readonly remediation?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function parseAuditFindings(value: unknown): readonly ParsedAuditFinding[] | undefined {
  const root = record(value);
  if (root === undefined || !Array.isArray(root.findings)) return undefined;
  const parsed: ParsedAuditFinding[] = [];
  for (const value of root.findings) {
    const finding = record(value);
    if (finding === undefined) return undefined;
    // A severity this version does not know (or "info") is not a foot-gun to act on; skipping
    // it keeps a newer OpenClaw from turning the whole audit into "unavailable".
    if (finding.severity !== "critical" && finding.severity !== "warn") continue;
    if ((finding.checkId !== undefined && typeof finding.checkId !== "string") ||
      (finding.title !== undefined && typeof finding.title !== "string") ||
      (finding.detail !== undefined && typeof finding.detail !== "string") ||
      (finding.remediation !== undefined && typeof finding.remediation !== "string")) return undefined;
    const checkId = typeof finding.checkId === "string" ? finding.checkId : "unknown";
    const title = typeof finding.title === "string" ? finding.title : checkId;
    const detail = typeof finding.detail === "string" ? finding.detail : title;
    if (checkId.trim() === "" || title.trim() === "" || detail.trim() === "") return undefined;
    parsed.push({
      checkId,
      title,
      detail,
      severity: finding.severity,
      ...(typeof finding.remediation === "string" ? { remediation: finding.remediation } : {}),
    });
  }
  return parsed;
}

export interface AuditPolicy {
  readonly block: AuditBlockPolicy;
}

/** One entry of config/security-suppressions.json. An entry with a `match` applies only to
 *  findings whose text contains it — scoping an acceptance to one account/agent instead of
 *  silencing the check instance-wide. */
export interface SecuritySuppression {
  readonly checkId: string;
  readonly match?: string;
  readonly reason: string;
}

/** First matching entry wins, in file order — deterministic and documented. */
export function suppressionFor(
  finding: { readonly checkId: string; readonly title?: string; readonly message: string },
  suppressions: readonly SecuritySuppression[],
): SecuritySuppression | undefined {
  // `accept` prints title and message, `doctor` the message; a `match` is tested against both
  // together, never a single field, so either part can carry the account/agent path.
  const text = [finding.title, finding.message].filter((part) => part !== undefined).join("\n");
  return suppressions.find((entry) =>
    entry.checkId === finding.checkId && (entry.match === undefined || text.includes(entry.match))
  );
}

export function parseAuditPolicy(block: string | undefined): AuditPolicy {
  const threshold = block ?? "critical";
  if (threshold !== "critical" && threshold !== "warn") {
    throw new Error("OC_AUDIT_BLOCK must be critical or warn");
  }
  return { block: threshold };
}

export function auditFindingBlocks(severity: AuditSeverity, policy: AuditPolicy): boolean {
  if (severity === "info") return false;
  return policy.block === "warn" || severity === "critical";
}

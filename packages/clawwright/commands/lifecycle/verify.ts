// `clawwright verify <archive>` — checks a snapshot for credentials before it is shared.
//
// Exclusion lists are a promise; this is a check.
// The archive is unpacked into a temporary directory on the target and searched — binary
// files included — for the actual secret values this instance holds.
//
// Two classes, because they travel differently:
//   critical — provider API keys and the gateway token. Never acceptable outside `full`.
//   identity — the instance's own operator/device tokens. Expected in `migrate` (the same
//              instance is moving), fatal in `share`.

import { randomBytes } from "node:crypto";
import JSON5 from "json5";
import { log, info, warn, die } from "#src/core/io/log.ts";
import { shellQuote } from "#src/core/io/shell.ts";
import { withOutputSink, outputSink, emit, isCaptured } from "#src/core/io/output.ts";
import type { Context } from "#src/core/context.ts";
import { sudoFor } from "#src/runtime/files/datadir.ts";
import { PUBLISH_STAGING_MARKER, PRIVATE_STAGING_MARKER } from "#src/runtime/transport/transport.ts";
import {
  archiveRoot,
  inspectArchive,
  canonicalArchiveEntries,
  listArchive,
  listArchiveLinks,
  reportableProblems,
  SHARE_ALLOWED,
  type Profile,
} from "#src/service/archive/index.ts";
import { parseEnv } from "#src/core/env.ts";
import { collectSecretRefs } from "#src/service/secrets.ts";
import { installedRecipePrivatePaths } from "#src/service/recipe.ts";
import { privatePathsPolicy } from "#src/security/privacy/private-paths-ledger.ts";
import { commandBody, type ArgumentSpec } from "#src/core/command/spec.ts";
import { PROFILE_ARGUMENT } from "#src/commands/interface/groups/shared-arguments.ts";
import * as kinds from "#src/core/values/kinds.ts";

export const VERIFY_ARGUMENTS = [
  { name: "archive", description: "Archive to inspect", kind: "positional", required: true, value: kinds.text("archive to inspect", { leadingDash: "refuse" }) },
  PROFILE_ARGUMENT,
  { name: "json", summary: "Verdict as JSON", description: "Emit the verdict and findings as JSON — locations and kinds only, never credential values", kind: "flag" },
] as const satisfies readonly ArgumentSpec[];

/** One thing verifySnapshot found. `detail` is a path, a rule name or a provider id —
 *  never a credential value, so this is exactly what --json is safe to print. */
export interface VerifyFinding {
  readonly kind:
    | "structural"
    | "forbidden-path"
    | "unexpected-path"
    | "embedded-provider-key"
    | "embedded-gateway-token"
    | "embedded-secret-field"
    | "credential-url"
    | "unreadable-archived-config"
    | "credential-in-archive"
    | "identity-token-in-archive";
  readonly detail: string;
  /** Whether this finding is why the check failed, under the profile it ran with — an
   *  identity token is a finding under every profile but only fatal for 'share'. */
  readonly fatal: boolean;
}

/** Three rule kinds an archive entry can violate:
 *  `literals` — declared paths (recipe privatePaths, profile secrets/identity dirs), matched
 *  by exact path or '/' boundary — never bare prefix (would wrongly catch `vault-public` for
 *  `vault`).
 *  `prefixes` — the staging family `config/.env.clawwright-` (state.ts appends a random suffix),
 *  matched by prefix since it names a family, not one path.
 *  `fragments` — temp-sibling staging markers (transport.ts) left by a crashed private write,
 *  matched as a substring since the marker sits mid-name. */
export interface ForbiddenRules {
  literals: readonly string[];
  prefixes: readonly string[];
  fragments: readonly string[];
}

export function forbiddenRules(profile: Profile, recipePrivatePaths: readonly string[]): ForbiddenRules {
  if (profile === "share") {
    return {
      literals: [...recipePrivatePaths, "config/.env", "config/identity/", "config/devices/", "config/state/", "config/agents/", "config/clawwright-declared-config-patch.json", "config/clawwright-desired.json", "clawwright-declared.json"],
      prefixes: ["config/.env.clawwright-", "config/clawwright-declared-config-patch.dry-", "config/clawwright-desired.dry-"],
      fragments: [PRIVATE_STAGING_MARKER, PUBLISH_STAGING_MARKER],
    };
  }
  if (profile === "migrate") {
    return {
      literals: [...recipePrivatePaths, "config/.env", "config/clawwright-declared-config-patch.json"],
      prefixes: ["config/.env.clawwright-", "config/clawwright-declared-config-patch.dry-", "config/clawwright-desired.dry-"],
      fragments: [PRIVATE_STAGING_MARKER, PUBLISH_STAGING_MARKER],
    };
  }
  return { literals: [], prefixes: [], fragments: [] };
}

/** True when an archive entry IS the declared path or lives inside it: equality, or a '/'
 *  continuation — never a bare string prefix. Declarations may carry a trailing slash
 *  (share's directory rules above), so it is normalized away; the archive's own directory
 *  entries keep theirs and still match through the boundary test. */
function violatesLiteralPath(entry: string, declared: string): boolean {
  const path = declared.replace(/\/+$/, "");
  return entry === path || entry.startsWith(`${path}/`);
}

/** The declared rules these archive entries violate — literals by path boundary, staging
 *  prefixes by string prefix, staging markers by substring. verifySnapshot and pull's
 *  migrate publish check must judge declarations the same way, so this comparison lives
 *  here and nowhere else. */
export function forbiddenViolations(
  profile: Profile,
  recipePrivatePaths: readonly string[],
  entries: readonly string[],
): string[] {
  const rules = forbiddenRules(profile, recipePrivatePaths);
  const violated: string[] = [];
  for (const declared of rules.literals) {
    if (entries.some((entry) => violatesLiteralPath(entry, declared))) violated.push(declared);
  }
  for (const stem of rules.prefixes) {
    if (entries.some((entry) => entry.startsWith(stem))) violated.push(stem);
  }
  for (const marker of rules.fragments) {
    if (entries.some((entry) => entry.includes(marker))) violated.push(marker);
  }
  return violated;
}

/** Creates a private directory, preserving compatibility with older transports. */
async function mkdirPrivate(ctx: Context, path: string): Promise<void> {
  if (typeof ctx.transport.mkdirPrivate === "function") {
    await ctx.transport.mkdirPrivate(path);
    return;
  }
  await ctx.transport.exec("mkdir", ["-m", "700", path]);
}

/** Writes secrets to a newly-created private file without a permissive intermediate mode. */
async function writePrivateFile(ctx: Context, path: string, content: string): Promise<void> {
  if (typeof ctx.transport.writePrivateFile === "function") {
    await ctx.transport.writePrivateFile(path, content);
    return;
  }
  await ctx.transport.exec("sh", ["-c", `umask 077; set -C; cat > ${shellQuote(path)}`], { input: content });
}

/** A supported secret reference ({"source":"env","id":"VAR"} — collectSecretRefs' own
 *  definition) travels by name; a literal string IS the secret. */
function isLiteralSecret(value: unknown): value is string {
  return collectSecretRefs(value).length === 0 && typeof value === "string" && value.length > 0;
}

const CONFIG_PATH = "config/openclaw.json";

function secretField(key: string): boolean {
  const name = key.replaceAll(/[-_]/g, "").toLowerCase();
  return /(?:token|secret|password|passwd|credentials?|authorization)$/.test(name)
    || /(?:api|auth|private|access|client|encryption|signing)key(?:id)?$/.test(name);
}

function envReference(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const node = value as Record<string, unknown>;
  return Object.keys(node).every((key) => key === "source" || key === "id")
    && node.source === "env" && typeof node.id === "string" && node.id.length > 0;
}

function credentialUrl(value: string): boolean {
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.username !== "" || url.password !== "") return true;
    if ([...url.searchParams].some(([key, entry]) => secretField(key) && entry !== "")) return true;
    return /(?:^|[&#?])(?:token|secret|password|api[_-]?key)=/i.test(url.hash);
  } catch {
    return value.includes("@");
  }
}

/** Inspects the archived config itself; finding locations never include user-supplied keys. */
function embeddedConfigFindings(config: unknown): Pick<VerifyFinding, "kind" | "detail">[] {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("invalid config root");
  }
  const findings: Pick<VerifyFinding, "kind" | "detail">[] = [];
  const visit = (node: unknown, path: string, ancestors: readonly string[]): void => {
    if (typeof node === "string") {
      if (credentialUrl(node)) findings.push({ kind: "credential-url", detail: `${CONFIG_PATH} (${path})` });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`, ancestors));
      return;
    }
    if (node === null || typeof node !== "object") return;
    Object.entries(node).forEach(([key, value], index) => {
      const next = `${path}.field[${index}]`;
      if (secretField(key) && value !== null && value !== "") {
        const knownProviderKey = ancestors.length === 3 && ancestors[0] === "models"
          && ancestors[1] === "providers" && key === "apiKey"
          && typeof value === "string" && value.length >= 12;
        const knownGatewayToken = ancestors.length === 2 && ancestors[0] === "gateway"
          && ancestors[1] === "auth" && key === "token" && isLiteralSecret(value);
        if (!envReference(value) && !knownProviderKey && !knownGatewayToken) {
          findings.push({ kind: "embedded-secret-field", detail: `${CONFIG_PATH} (${next})` });
        }
      } else {
        visit(value, next, [...ancestors, key]);
      }
    });
  };
  visit(config, "$", []);
  return findings;
}

async function collectSecrets(ctx: Context): Promise<{ critical: string[]; identity: string[] }> {
  const critical: string[] = [];
  const identity: string[] = [];

  // Provider keys. Short values are skipped: a 4-character value matches everywhere and
  // turns the check into noise.
  const secretsPath = `${ctx.settings.dataDir}/config/.env`;
  if (await ctx.transport.exists(secretsPath)) {
    for (const value of Object.values(parseEnv(await ctx.transport.readFile(secretsPath), secretsPath))) {
      if (value.length >= 12) critical.push(value);
    }
  }

  const token = ctx.settings.env.OPENCLAW_GATEWAY_TOKEN;
  if (token !== undefined && token.length >= 12) critical.push(token);

  // openclaw.json IS allowed content for 'share', so a plain-string apiKey baked into it
  // (instead of a SecretRef) is the one credential no other check here looks for.
  const configPath = `${ctx.settings.dataDir}/config/openclaw.json`;
  if (await ctx.transport.exists(configPath)) {
    try {
      // JSON5: OpenClaw's gateway config format allows comments/trailing commas that
      // JSON.parse rejects; a parse failure here just means nothing to scan.
      const config = JSON5.parse(await ctx.transport.readFile(configPath)) as {
        models?: { providers?: Record<string, unknown> };
        gateway?: { auth?: { token?: unknown } };
      };
      for (const provider of Object.values(config.models?.providers ?? {})) {
        const apiKey = (provider as { apiKey?: unknown } | null)?.apiKey;
        if (typeof apiKey === "string" && apiKey.length >= 12) critical.push(apiKey);
      }
      // The gateway token, symmetric with the provider keys: a literal in the live config
      // ships with the archive just the same. A reference is a name, not a value to grep for.
      const gatewayToken = config.gateway?.auth?.token;
      if (isLiteralSecret(gatewayToken) && gatewayToken.length >= 12) critical.push(gatewayToken);
    } catch {
      // A config that cannot be parsed is reported elsewhere (inspect/doctor); this scan
      // just has nothing to add from it.
    }
  }

  // Operator/device tokens — these hand over control of the instance.
  const identityPath = `${ctx.settings.dataDir}/config/identity/device-auth.json`;
  if (await ctx.transport.exists(identityPath)) {
    const content = await ctx.transport.readFile(identityPath);
    for (const match of content.matchAll(/"token"\s*:\s*"([^"]{12,})"/g)) {
      identity.push(match[1]);
    }
  }

  return { critical: [...new Set(critical)], identity: [...new Set(identity)] };
}

/** Greps an unpacked tree for any of the given values, binary files included. */
async function findSecrets(ctx: Context, directory: string, values: string[], patternFile: string): Promise<string[]> {
  if (values.length === 0) return [];

  // The private session directory is created first, so this file is owner-only before its
  // first secret byte is written. Its path stays outside the extracted tree.
  await writePrivateFile(ctx, patternFile, `${values.join("\n")}\n`);

  try {
    // -a: treat binaries as text, so a key inside a sqlite page is still caught.
    const result = await ctx.transport.exec(
      "grep",
      ["-r", "-a", "-l", "-F", "-f", patternFile, directory],
      { allowFailure: true },
    );

    // Only a completed grep can clear the archive; interrupted stdout may be partial.
    if (result.timedOut || (result.code !== 0 && result.code !== 1)) {
      throw new Error(`scanning ${directory} failed (grep exit ${result.code}): ${result.stderr.trim()}`);
    }

    return result.stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => line.replace(`${directory}/`, ""));
  } finally {
    await ctx.transport.remove(patternFile);
  }
}

/** Structural check result: nothing fatal, plus the canonical relative-path listing the
 *  policy and content-scan phases both need. undefined when the archive already failed. */
interface StructuralResult {
  relative: string[];
  root: string;
}

/** Validate phase: structural safety (no absolute paths, no `..` escapes, no link written
 *  through) — needs no unpacking, so it runs before anything below touches the archive's
 *  content. Returns undefined once the verdict is already decided (unsafe to unpack, or the
 *  root cannot be canonicalized). */
async function structuralCheck(
  ctx: Context,
  archive: string,
  profile: Profile,
  onFinding?: (finding: VerifyFinding) => void,
): Promise<StructuralResult | undefined> {
  const entries = await listArchive(ctx, archive);

  const structural = inspectArchive(entries, await listArchiveLinks(ctx, archive));
  // Links into the container image are an ordinary artefact of installing inside it — real
  // snapshots carry dozens, so they fold into one summary line instead of one warning each.
  const { toReport, foldedImageLinks } = reportableProblems(structural);
  for (const problem of toReport) {
    if (problem.fatal) warn(problem.message);
    else info(problem.message);
    onFinding?.({ kind: "structural", detail: problem.message, fatal: problem.fatal });
  }
  if (foldedImageLinks > 0) info(`${foldedImageLinks} expected link(s) into the OpenClaw image`);

  // A fatal structural problem (absolute path, .. escape, a link written through) means
  // unpacking this archive can write outside the destination. Nothing below this point may
  // run: the content scan itself unpacks the archive, and a rejected count is not a refusal.
  if (structural.some((problem) => problem.fatal)) {
    warn(`snapshot FAILED the '${profile}' check: unsafe to unpack`);
    return undefined;
  }

  // The root is read from the archive, not assumed to be "data": the data directory is
  // named by the deployment and an archive from elsewhere may use anything.
  let canonical: string[];
  try {
    canonical = canonicalArchiveEntries(entries);
  } catch (error) {
    warn(`snapshot FAILED the '${profile}' check: ${(error as Error).message}`);
    return undefined;
  }
  const root = canonicalArchiveEntries([archiveRoot(entries)])[0];
  const relative = canonical.map((entry) => entry === root ? "" : entry.slice(root.length + 1));
  return { relative, root };
}

/** Validate phase: the profile's declared exclusions (forbiddenViolations) plus, for
 *  'share', the positive allow-list — anything new in the data directory is reported
 *  instead of travelling unnoticed. Returns how many findings were fatal under this profile. */
function policyViolations(
  profile: Profile,
  recipePrivatePaths: readonly string[],
  relative: readonly string[],
  onFinding?: (finding: VerifyFinding) => void,
): number {
  let failures = 0;
  for (const path of forbiddenViolations(profile, recipePrivatePaths, relative)) {
    warn(`archive contains ${path}, which the '${profile}' profile must exclude`);
    onFinding?.({ kind: "forbidden-path", detail: path, fatal: true });
    failures += 1;
  }

  if (profile === "share") {
    const unexpected = new Set<string>();
    for (const raw of relative) {
      const entry = raw.replace(/\/+$/, "");
      // The root entry itself, and the directories on the way to an allowed path.
      if (entry === "") continue;
      if (SHARE_ALLOWED.some((allowed) => entry === allowed || entry.startsWith(`${allowed}/`))) continue;
      if (SHARE_ALLOWED.some((allowed) => allowed.startsWith(`${entry}/`))) continue;
      unexpected.add(entry.split("/").slice(0, 2).join("/"));
    }
    if (unexpected.size > 0) {
      warn(`archive contains paths the 'share' profile does not allow:`);
      for (const path of unexpected) {
        info(path);
        onFinding?.({ kind: "unexpected-path", detail: path, fatal: true });
      }
      failures += 1;
    }
  }
  return failures;
}

/** Act phase: unpacks the archive into a private temp tree and greps it for the live
 *  instance's own secret values, plus scans the archive's own embedded openclaw.json for a
 *  plain-string key. Removes the temp tree whatever the outcome. Returns how many findings
 *  were fatal under this profile. */
async function contentScan(
  ctx: Context,
  archive: string,
  root: string,
  profile: Profile,
  secrets: { critical: string[]; identity: string[] },
  onFinding?: (finding: VerifyFinding) => void,
): Promise<number> {
  let failures = 0;
  const session = `/tmp/clawwright-verify-${randomBytes(6).toString("hex")}`;
  const workdir = `${session}/tree`;
  const patternFile = `${session}/patterns`;
  // Resolved before the try so cleanup uses the same privilege: tar preserves ownership, so
  // a sudo-extracted tree (auth-secrets is 700) needs sudo to `rm -rf` it too.
  const prefix = await sudoFor(ctx, archive);
  let sessionCreated = false;
  try {
    await mkdirPrivate(ctx, session);
    sessionCreated = true;
    await mkdirPrivate(ctx, workdir);
    const [head, ...rest] = [...prefix, "tar", "-xzf", archive, "-C", workdir];
    await ctx.transport.exec(head, rest);

    // A plain-string provider apiKey embedded in the ARCHIVE'S OWN openclaw.json is direct
    // evidence, checked independently of the live config: a key rotated out of the live
    // config since the archive was taken would otherwise be missed.
    // Parsed as JSON5 (OpenClaw's gateway config format) — a parse failure is a finding, not
    // silence: a file this check cannot read is a file it cannot clear.
    const archivedConfigPath = `${workdir}/${root}/config/openclaw.json`;
    if (await ctx.transport.exists(archivedConfigPath)) {
      try {
        const archivedConfig = JSON5.parse(await ctx.transport.readFile(archivedConfigPath)) as {
          models?: { providers?: Record<string, unknown> };
          gateway?: { auth?: { token?: unknown } };
        };
        const embeddedKeys = Object.entries(archivedConfig.models?.providers ?? {})
          .filter(([, provider]) => {
            const apiKey = (provider as { apiKey?: unknown } | null)?.apiKey;
            return typeof apiKey === "string" && apiKey.length >= 12;
          })
          .map(([id]) => id);
        // The gateway token, judged on the same evidence: an archive from another instance,
        // or taken before a rotation, carries a token the live value never names — so the
        // archive's own gateway.auth.token is read directly, not searched for.
        const embeddedToken = isLiteralSecret(archivedConfig.gateway?.auth?.token);
        if (embeddedKeys.length > 0 || embeddedToken) {
          const report = profile === "full" ? info : warn;
          const fatal = profile !== "full";
          if (embeddedKeys.length > 0) {
            report("the archive's own openclaw.json embeds a plain-string provider apiKey:");
            for (const id of embeddedKeys) {
              info(`provider ${id}`);
              onFinding?.({ kind: "embedded-provider-key", detail: `config/openclaw.json (provider ${id})`, fatal });
            }
          }
          if (embeddedToken) {
            report("the archive's own openclaw.json embeds a literal gateway.auth.token");
            onFinding?.({ kind: "embedded-gateway-token", detail: "config/openclaw.json", fatal });
          }
          if (fatal) failures += 1;
        }
        const extraFindings = embeddedConfigFindings(archivedConfig);
        for (const finding of extraFindings) {
          const fatal = profile !== "full";
          (fatal ? warn : info)(`the archive's own openclaw.json contains ${finding.kind} at ${finding.detail}`);
          onFinding?.({ ...finding, fatal });
          if (fatal) failures += 1;
        }
      } catch {
        warn("the archive's own openclaw.json could not be safely checked");
        onFinding?.({ kind: "unreadable-archived-config", detail: "config/openclaw.json", fatal: true });
        failures += 1;
      }
    }

    const criticalHits = await findSecrets(ctx, workdir, secrets.critical, patternFile);
    if (criticalHits.length > 0) {
      const report = profile === "full" ? info : warn;
      report("provider/gateway credentials found inside the archive:");
      for (const hit of criticalHits) {
        info(hit);
        onFinding?.({ kind: "credential-in-archive", detail: hit, fatal: profile !== "full" });
      }
      if (profile !== "full") failures += 1;
    }

    const identityHits = await findSecrets(ctx, workdir, secrets.identity, patternFile);
    if (identityHits.length > 0) {
      if (profile === "share") {
        warn("instance identity tokens found inside the archive:");
        for (const hit of identityHits) {
          info(hit);
          onFinding?.({ kind: "identity-token-in-archive", detail: hit, fatal: true });
        }
        failures += 1;
      } else {
        info(`contains this instance's identity tokens (expected for profile '${profile}')`);
        for (const hit of identityHits) onFinding?.({ kind: "identity-token-in-archive", detail: hit, fatal: false });
      }
    }
  } finally {
    // allowFailure: a scan that finished has an answer, and a leftover directory in /tmp is
    // not a reason to throw it away.
    if (sessionCreated) {
      const [rmHead, ...rmRest] = [...prefix, "rm", "-rf", session];
      await ctx.transport.exec(rmHead, rmRest, { allowFailure: true });
    }
  }
  return failures;
}

export async function verifySnapshot(
  ctx: Context,
  archive: string,
  profile: Profile,
  onFinding?: (finding: VerifyFinding) => void,
): Promise<boolean> {
  if (!(await ctx.transport.exists(archive))) die(`archive not found: ${archive}`);

  const secrets = await collectSecrets(ctx);
  // The same enumeration archive.ts excludes by: this check is what refuses an archive that
  // was already taken before that exclusion existed.
  const [installedPrivatePaths, recordedPrivatePaths] = await Promise.all([
    installedRecipePrivatePaths(),
    privatePathsPolicy(ctx),
  ]);
  const recipePrivatePaths = [...new Set([...installedPrivatePaths, ...recordedPrivatePaths])];
  log(
    `checking against ${secrets.critical.length} provider/gateway and ${secrets.identity.length} identity secret(s)`,
  );

  // Structural rules first — they need no unpacking.
  const structural = await structuralCheck(ctx, archive, profile, onFinding);
  if (structural === undefined) return false;
  const { relative, root } = structural;

  let failures = policyViolations(profile, recipePrivatePaths, relative, onFinding);

  // Content scan.
  failures += await contentScan(ctx, archive, root, profile, secrets, onFinding);

  if (failures > 0) {
    warn(`snapshot FAILED the '${profile}' check: ${failures} finding(s)`);
    return false;
  }

  log(`passed the '${profile}' check: ${archive}`);
  info("transcripts and workspace notes are not scanned for personal content — review them yourself");
  return true;
}

/** verifySnapshot() for a caller whose WANTED answer is "rejected" — its explanatory
 *  warnings are then expected evidence, not an alarm, in an otherwise-passing run. Captured
 *  via withOutputSink and surfaced only if the verifier answered the other way (accepted). */
export async function verifySnapshotQuietly(ctx: Context, archive: string, profile: Profile): Promise<boolean> {
  let captured = "";
  const passed = await withOutputSink((chunk) => { captured += chunk; }, () => verifySnapshot(ctx, archive, profile));
  if (passed) {
    const sink = outputSink();
    if (sink !== undefined) sink(captured);
    else process.stderr.write(captured);
  }
  return passed;
}

export const VERIFY = commandBody({
  effect: "read",
  arguments: VERIFY_ARGUMENTS,
  async run(ctx, values) {
    const profile = (values.profile ?? "share") as Profile;
    const archive = values.archive;
    const jsonOnly = values.json === true;

    if (jsonOnly || isCaptured()) {
    const findings: VerifyFinding[] = [];
    let passed = false;
    // Swallows verifySnapshot's own narration (log/info/warn) so a captured caller — MCP
    // shares one sink for both — sees only the JSON emitted below, never mixed text.
    await withOutputSink(() => {}, async () => {
      passed = await verifySnapshot(ctx, archive, profile, (finding) => findings.push(finding));
    });
    emit(`${JSON.stringify({ archive, profile, passed, findings }, null, 2)}\n`);
    if (!passed) die(`snapshot failed the '${profile}' profile check`);
    return;
  }

  if (profile === "full") warn("profile 'full' is credential-complete by design — never share it");

  if (!(await verifySnapshot(ctx, archive, profile))) {
    die(`snapshot failed the '${profile}' profile check`);
  }
},
});

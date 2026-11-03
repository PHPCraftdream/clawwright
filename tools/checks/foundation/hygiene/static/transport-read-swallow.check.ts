// The target-read ratchet (S3.4, invariant I14's reading half): no catch around a transport
// READ in packages/clawwright/service or packages/clawwright/commands may discard the error — an
// unreachable target is "could not find out" (thrown, with Advice), never "nothing there".
// Reads are transport.readFile/exists/listFiles, the contract helpers themselves (a bare
// catch around one converts its unknown into absence), and allowFailure exec reads whose
// handler returns an empty/absent default. The analysis lives in
// transport-read-swallow-rules.ts (tokenizer-based: strings and comments never authorize a
// swallow); this file self-checks it on in-memory snippets, then scans the real trees. ALLOW
// is the counted allow-list of deliberate sites: one reason per entry, entries must shrink,
// and a stale entry (the site no longer flags) fails — never a silent parking spot.

import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { analyze, type Hit } from "./transport-read-swallow-rules.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");

// --- self-check: table-driven, in-memory, every case asserts the exact hits ---------------

type SelfCase = { name: string; source: string; hits: string[] };

// hits entries are "line:call:form" relative to the snippet (line 1-based).
const SELF_CASES: SelfCase[] = [
  {
    name: "bare catch returning undefined around a read",
    source: "try { return await ctx.transport.readFile(path); } catch { return undefined; }",
    hits: ["1:ctx.transport.readFile(:try"],
  },
  {
    name: "bare catch returning false around exists",
    source: "try { if (!(await ctx.transport.exists(live))) return a; } catch { return false; }",
    hits: ["1:ctx.transport.exists(:try"],
  },
  {
    name: "multiline try, catch bound but unused",
    source: "try {\n  const raw = await ctx.transport.readFile(path);\n  return parse(raw);\n} catch (ignored) {\n  return DEFAULT;\n}",
    hits: ["4:ctx.transport.readFile(:try"],
  },
  {
    name: "promise .catch(() => default) form",
    source: "const files = await ctx.transport.listFiles(dir).catch(() => [] as string[]);",
    hits: ["1:ctx.transport.listFiles(:promise"],
  },
  {
    name: "promise .catch with a typed but unused parameter",
    source: "const raw = await ctx.transport.readFile(path).catch((error: unknown) => \"\");",
    hits: ["1:ctx.transport.readFile(:promise"],
  },
  {
    name: "catch that only logs the error still discards it",
    source: "try { return await ctx.transport.readFile(path); } catch (error) { console.log(error); return []; }",
    hits: ["1:ctx.transport.readFile(:try"],
  },
  {
    name: "a comment saying rethrow does not authorize a swallow",
    source: "try { return await ctx.transport.readFile(path); } catch { /* rethrow is pointless here */ return undefined; }",
    hits: ["1:ctx.transport.readFile(:try"],
  },
  {
    name: "a string containing throw-error words does not authorize a swallow",
    source: "try { return await ctx.transport.readFile(path); } catch (error) { log(\"throw error\"); return undefined; }",
    hits: ["1:ctx.transport.readFile(:try"],
  },
  {
    name: "bare catch around readIfExists converts unknown into absent",
    source: "try { return await readIfExists(ctx.transport, path); } catch { return undefined; }",
    hits: ["1:readIfExists(:try"],
  },
  {
    name: "bare catch around probeExists converts unknown into absent",
    source: "try { return await probeExists(ctx.transport, path); } catch { return false; }",
    hits: ["1:probeExists(:try"],
  },
  {
    name: "allowFailure exec degraded to an empty string",
    source: "try { const r = await ctx.transport.exec(\"cat\", [path], { allowFailure: true }); return r.stdout; } catch { return \"\"; }",
    hits: ["1:ctx.transport.exec(:try"],
  },
  {
    name: "allowFailure exec success-path .then is not a swallow",
    source: "const files = await ctx.transport.exec(\"ls\", [dir], { allowFailure: true }).then((r) => r.stdout, () => []);",
    hits: [],
  },
  {
    name: "allowFailure exec degraded via rejected .catch arrow",
    source: "const out = await ctx.transport.exec(\"cat\", [p], { allowFailure: true }).catch(() => \"\");",
    hits: ["1:ctx.transport.exec(:promise"],
  },
  {
    name: "exec catch that rethrows is fine",
    source: "try { await ctx.transport.exec(\"cat\", [path], { allowFailure: true }); } catch (error) { throw error; }",
    hits: [],
  },
  {
    name: "exec without allowFailure is out of the read rule",
    source: "try { await ctx.transport.exec(\"tar\", args); } catch { return undefined; }",
    hits: [],
  },
  {
    name: "catch that rethrows is fine",
    source: "try { return await ctx.transport.readFile(path); } catch (error) { throw error; }",
    hits: [],
  },
  {
    name: "a conditional rethrow with a swallowing else path is a hit",
    source: "try { return await ctx.transport.exists(path); } catch (error) { if (error instanceof TransportUnreachableError) throw error; return false; }",
    hits: ["1:ctx.transport.exists(:try"],
  },
  {
    name: "a conditional rethrow whose other path throws TargetReadUnknownError is fine",
    source: "try { return await ctx.transport.readFile(path); } catch (error) { if (fallback()) throw error; throw new TargetReadUnknownError(path, error); }",
    hits: [],
  },
  {
    name: "a conditional rethrow whose other path returns the typed read outcome is fine",
    source: "try { return await ctx.transport.readFile(path); } catch (error) { if (fallback()) throw error; return readIfExists(ctx.transport, path); }",
    hits: [],
  },
  {
    name: "if/else where both branches throw is fine",
    source: "try { return await ctx.transport.exists(path); } catch (error) { if (retryable(error)) { throw error; } else { throw new TargetReadUnknownError(path, error); } }",
    hits: [],
  },
  {
    name: "a nested conditional rethrow whose inner fall-through path swallows is a hit",
    source: "try { return await ctx.transport.readFile(path); } catch (error) { if (x) { if (y) throw error; } else { throw error; } }",
    hits: ["1:ctx.transport.readFile(:try"],
  },
  {
    name: "a nested if/else that throws on every path is fine",
    source: "try { return await ctx.transport.readFile(path); } catch (error) { if (a) { if (b) { throw error; } else { throw new TargetReadUnknownError(path, error); } } else { throw error; } }",
    hits: [],
  },
  {
    name: "a returned expression that is only partly the typed outcome is a hit",
    source: "try { return await ctx.transport.readFile(path); } catch (error) { return y ? readIfExists(ctx.transport, path) : undefined; }",
    hits: ["1:ctx.transport.readFile(:try"],
  },
  {
    name: "a promise .catch whose conditional rethrow swallows the other path is a hit",
    source: "const raw = await ctx.transport.readFile(path).catch((error) => { if (fatal(error)) throw error; return \"\"; });",
    hits: ["1:ctx.transport.readFile(:promise"],
  },
  {
    name: "die() in the handler is fine",
    source: "try { raw = await ctx.transport.readFile(path); } catch (readFailure) { die(`cannot read: ${readFailure}`); }",
    hits: [],
  },
  {
    name: "a conditional rethrow whose other path returns a non-read value is a hit",
    source: "try { return await ctx.transport.readFile(path); } catch (error) { if (fallback()) throw error; return sudo(path); }",
    hits: ["1:ctx.transport.readFile(:try"],
  },
  {
    name: "a write call is out of scope",
    source: "try { await ctx.transport.writeFile(path, content); } catch { return undefined; }",
    hits: [],
  },
  {
    name: "a local node:fs read is out of scope",
    source: "try { return await readFile(path, \"utf8\"); } catch { return undefined; }",
    hits: [],
  },
  {
    name: "catch around an unrelated try is not flagged",
    source: "try { return JSON.parse(text); } catch { return undefined; }",
    hits: [],
  },
  {
    name: "exists inside the handler (an absent re-probe) still discards the original error",
    source: "try { return await ctx.transport.readFile(path); } catch { return !(await ctx.transport.exists(path)); }",
    hits: ["1:ctx.transport.readFile(:try"],
  },
  {
    name: "an invalid return inside a bare block terminates the path as a swallow",
    source: "try { return await ctx.transport.readFile(path); } catch (e) { { return undefined; } throw e; }",
    hits: ["1:ctx.transport.readFile(:try"],
  },
  {
    name: "a promise expression body that is only partly the typed outcome is a hit",
    source: "const raw = await ctx.transport.readFile(path).catch((error) => (fatal(error) ? readIfExists(ctx.transport, path) : undefined));",
    hits: ["1:ctx.transport.readFile(:promise"],
  },
  {
    name: "a promise .catch whose whole expression body is the typed outcome is fine",
    source: "const raw = await ctx.transport.readFile(path).catch(() => readIfExists(ctx.transport, path));",
    hits: [],
  },
  {
    name: "a returned die() call terminates the path safely",
    source: "try { return await ctx.transport.readFile(path); } catch (e) { return die(msg(e)); }",
    hits: [],
  },
  {
    name: "a .catch( inside a string literal is not a handler",
    source: "const sample = \"files().catch(() => [])\";\ntry { return await ctx.transport.readFile(path); } catch (error) { throw error; }",
    hits: [],
  },
  {
    name: "a .catch( inside a comment is not a handler",
    source: "// listFiles(dir).catch(() => []);\ntry { return await ctx.transport.readFile(path); } catch (error) { throw error; }",
    hits: [],
  },
  {
    name: "handler paren matching skips a string with a closing paren",
    source: "try { return await ctx.transport.readFile(path); } catch (error) { const s = (\")\"); return undefined; }",
    hits: ["1:ctx.transport.readFile(:try"],
  },
];

for (const selfCase of SELF_CASES) {
  const hits = analyze(selfCase.source).map((hit: Hit) => `${hit.line}:${hit.call}:${hit.form}`);
  check(`transport-read-swallow self: ${selfCase.name}`, hits, selfCase.hits);
}

async function walk(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

interface AllowEntry {
  /** Repo-relative path, forward slashes. */
  readonly file: string;
  /** 1-based line of the catch handler. */
  readonly line: number;
  /** Why this swallow is deliberate. Shrink-only: a stale entry fails the check. */
  readonly reason: string;
}

const ALLOW: readonly AllowEntry[] = [
  {
    file: "packages/clawwright/service/secrets.ts",
    line: 98,
    reason:
      "noProviderConfigured is a best-effort diagnostic feeding smoke's hint; an unreadable config answers false (documented on the function) rather than aborting a report that has its own failure path",
  },
  {
    file: "packages/clawwright/commands/lifecycle/bootstrap/index.ts",
    line: 220,
    reason:
      "a bonus 'provider: none configured yet' hint after bootstrap; doctor's own read of the same file reports a broken config, and the hint must never fail a bootstrap that just succeeded (comment on site)",
  },
  {
    file: "packages/clawwright/commands/lifecycle/verify.ts",
    line: 250,
    reason:
      "the LIVE openclaw.json secret scan (verify.ts collectSecrets) only adds findings to a verify that reports an unreadable config elsewhere (inspect/doctor); the swallow cannot hide a failed verify",
  },
  {
    file: "packages/clawwright/commands/lifecycle/verify.ts",
    line: 460,
    reason:
      "the catch is loud, not silent: warn() plus an unreadable-archived-config finding plus failures += 1 - the unknown is reported, never read as clean",
  },
  {
    file: "packages/clawwright/service/archive/pack.ts",
    line: 36,
    reason:
      "conservative default documented on site: an exists() the target could not answer is treated as PRESENT so privilege escalation is still demanded - never the other way round",
  },
  {
    file: "packages/clawwright/commands/lifecycle/backup/index.ts",
    line: 378,
    reason:
      "cleanup compensation: the catch collects the error into compensationErrors reported alongside the failure in flight - never discarded",
  },
  {
    file: "packages/clawwright/commands/lifecycle/bootstrap/prereqs.ts",
    line: 37,
    reason:
      "a port-probe tool that cannot even launch falls through to the next probe tool (ss, then netstat) and the function finally answers 'unavailable' - a visible gap, never a silent port claim",
  },
  {
    file: "packages/clawwright/commands/lifecycle/bootstrap/prereqs.ts",
    line: 127,
    reason:
      "nearestExistingAncestor: an unknown exists() answer is treated as absent - the walk stops and the candidate is returned as if it were the nearest existing ancestor; the operator then sees only the downstream probe's line (the writable line may be 'ok'), with no sign existence was never established. Lost here: the unknown-vs-absent distinction"
  },
  {
    file: "packages/clawwright/commands/lifecycle/bootstrap/prereqs.ts",
    line: 152,
    reason:
      "targetUserIdentity: a non-unreachable failure becomes undefined, so readyLine prints the path-only 'sudo install -d <path>' hint instead of the owner/group form - a correct but generic hint; the operator is never told the identity probe failed. Lost here: the cause and the ownership facts"
  },
  {
    file: "packages/clawwright/commands/lifecycle/bootstrap/prereqs.ts",
    line: 195,
    reason:
      "dockerProbe: a non-unreachable exec failure becomes fail('docker is not on PATH on the target', advice); the operator sees the named failure and fix guidance. Lost here: the underlying transport error - the message asserts 'not on PATH' without the cause"
  },
  {
    file: "packages/clawwright/commands/lifecycle/bootstrap/prereqs.ts",
    line: 218,
    reason:
      "composeProbe: a non-unreachable exec failure becomes fail('could not run docker compose version on the target', advice); the operator sees the failure and install guidance. Lost here: the underlying transport error cause"
  },
  {
    file: "packages/clawwright/commands/lifecycle/bootstrap/prereqs.ts",
    line: 269,
    reason:
      "diskProbe: a non-unreachable df failure becomes warn('could not run df -Pk <path> on the target', advice); the operator sees the degraded warning with advice, and bootstrap continues. Lost here: the error cause, and free space stays unknown"
  },
  {
    file: "packages/clawwright/commands/lifecycle/bootstrap/prereqs.ts",
    line: 374,
    reason:
      "gnuUserlandProbe: a non-unreachable sh failure becomes fail('no POSIX sh on the target', advice); the operator sees the failure and install guidance. Lost here: the underlying transport error cause",
  },
  {
    file: "packages/clawwright/service/secrets.ts",
    line: 316,
    reason:
      "readTargetSecrets: the catch retries the read through the sudo prefix (sudoForRead); when the retry succeeds the operator sees normal secret statuses and the first failure is discarded with no trace - only when no prefix exists does the original error rethrow. Lost here: any sign of the first failed read on the success path",
  },
  {
    file: "packages/clawwright/commands/lifecycle/restore/index.ts",
    line: 476,
    reason:
      "the caught error drives rollbackRestore, which reports it and unwinds the restore - the failure is the rollback's input, never read as clean",
  },
  {
    file: "packages/clawwright/commands/operate/recover-env/bootstrap.ts",
    line: 79,
    reason:
      "inspection failure retains the first TargetReadUnknownError with cause and advice while later candidates are tried; exhaustion throws it, and only a valid later match supersedes it. The handler-local analyzer cannot follow the deferred throw after the loop",
  },
  {
    file: "packages/clawwright/commands/operate/watch/health.ts",
    line: 70,
    reason:
      "a df that cannot run becomes a DISK_UNKNOWN 'degraded' finding carrying the cause (never a silent ok, never a false down) - the watch contract's documented unknown state",
  },
  {
    file: "packages/clawwright/commands/operate/watch/state.ts",
    line: 105,
    reason:
      "documented gap (backlog): readScheduledWatchState turns any failure, including an unknown transport read, into known:false 'no watch history'; migrating it needs the corrupt-history and absent-history branches split first",
  },
];

const scannedFiles = [
  ...(await walk(resolve(repoRoot, "packages", "clawwright", "service"))),
  ...(await walk(resolve(repoRoot, "packages", "clawwright", "commands"))),
].sort();

interface Flagged extends Hit {
  readonly file: string;
}

const flagged: Flagged[] = [];
let scanned = 0;
for (const file of scannedFiles) {
  const rel = relative(repoRoot, file).replaceAll("\\", "/");
  scanned += 1;
  for (const hit of analyze(await readFile(file, "utf8"))) flagged.push({ file: rel, ...hit });
}

const key = (entry: Flagged): string => `${entry.file}:${entry.line}`;
const allowedKeys = new Set(ALLOW.map((entry) => `${entry.file}:${entry.line}`));

const unallowed = flagged.filter((entry) => !allowedKeys.has(key(entry)));
check(
  "transport-read-swallow: every swallowing catch is migrated or allow-listed with a reason",
  unallowed.map((entry) => `${key(entry)} [${entry.call}]`),
  [],
);

const stale = ALLOW.filter((entry) => !flagged.some((flag) => key(flag) === `${entry.file}:${entry.line}`));
check(
  "transport-read-swallow: no stale allow-list entry (a listed site must still flag)",
  stale.map((entry) => `${entry.file}:${entry.line}: ${entry.reason.slice(0, 60)}...`),
  [],
);
// 14 -> 21 (fix33-Z): the all-path rule newly flags conditional rethrows whose other path
// ends in fail()/warn()/a fallback read; each entry's reason states exactly what the operator
// sees and what is lost. The widening is recorded in baseline.json (transportReadSwallowAllow).
const recorded = JSON.parse(await readFile(resolve(repoRoot, "tools", "checks", "architecture", "baseline.json"), "utf8")) as { transportReadSwallowAllow: { readonly total: number } };
checkTrue("transport-read-swallow: the allow-list only shrinks (counted ceiling in baseline.json)", ALLOW.length <= recorded.transportReadSwallowAllow.total);

console.log(
  `transport-read-swallow: ${scanned} files scanned, ${flagged.length} swallowing catches, ${ALLOW.length} allow-listed (must shrink), ${stale.length} stale`,
);
finish("transport-read-swallow");

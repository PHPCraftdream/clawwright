// Pure local-tar ownership analysis over source TEXT — no filesystem, no imports of the
// tree. packages/clawwright/set/artifacts/tar.ts is the single owner of LOCAL tar spawns; tar
// over ctx.transport runs on the target and is legitimate. Enforces two invariants:
// (1) no local process runner is ever given the literal program "tar" outside the owner;
// (2) inside the owner, a spawnLocal/localTarRunner("tar", [...]) array that passes "-C"
// must wrap the next element in tarLocalPath(...) — the rf6-fix33 forward-slash invariant. Shared by
// local-tar-owner.check.ts (real-tree scan) and its table-driven self-check.

import { maskLiterals } from "./write-isolation-syntax/write-isolation-rules.ts";

export type Classification = "LOCAL TAR SPAWN" | "UNNORMALIZED -C";

const SPAWN_KIND: Classification = "LOCAL TAR SPAWN";
const UNNORMALIZED_KIND: Classification = "UNNORMALIZED -C";

export type Hit = { call: string; classification: Classification };

// Local process runners. Receiver-qualified call sites (childProcess.spawn, cp.execFile)
// match too, except target-side receivers (transport, *.transport, this). Longest names
// first so execFileAsync is not eaten by execFile; the (?<![\w$.]) guard keeps
// withLocalTarRunner from matching localTarRunner.
const RUNNER_CALL = /(?<![\w$.])(?:([\w$.]+)\.)?(spawnLocal|runProcess|execFileAsync|execFile|execSync|spawnSync|spawn|exec|localTarRunner)\s*\(/g;

// Shells a runner may be given; the shell's command string is scanned for a tar token.
const SHELL_ARG = /^\s*(['"])(?:sh|bash|zsh|fish|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?)\1\s*,/;

const TAR_PROGRAM = /^\s*(['"])\s*tar\b/;
const TAR_TOKEN = /\btar\b/;
const DASH_C = /^\s*(['"])-C\1$/;
const NORMALIZED = /\btarLocalPath\s*\(/;

// End index (inclusive) of the balanced `open` bracket on the masked text.
function balancedEnd(masked: string, open: number, openChar: string, closeChar: string): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === openChar) depth++;
    else if (masked[i] === closeChar && --depth === 0) return i;
  }
  return masked.length - 1;
}

function splitElements(masked: string, original: string, from: number, to: number): string[] {
  const elements: string[] = [];
  let depth = 0;
  let start = from;
  for (let i = from; i <= to; i++) {
    const c = masked[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if ((c === "," && depth === 0) || i === to) {
      elements.push(original.slice(start, i).trim());
      start = i + 1;
    }
  }
  return elements;
}

/** Local tar spawn hits in `source`; `owner` enables the UNNORMALIZED -C classification. */
export function localTarHits(source: string, owner: boolean): Hit[] {
  const masked = maskLiterals(source);
  const hits: Hit[] = [];
  for (const m of masked.matchAll(RUNNER_CALL)) {
    const receiver = m[1];
    const call = m[2];
    const open = (m.index ?? 0) + m[0].length - 1;
    // Target-side receivers run tar on the remote host — a different concern.
    if (receiver !== undefined && (receiver === "this" || receiver === "transport" || receiver.endsWith(".transport"))) continue;
    const after = source.slice(open + 1);
    if (TAR_PROGRAM.test(after)) {
      hits.push({ call, classification: SPAWN_KIND });
      continue;
    }
    // Shell pipeline passed directly: a single string argument carrying a tar token.
    if (call === "exec" || call === "execSync") {
      const end = balancedEnd(masked, open, "(", ")");
      const literal = source.slice(open + 1, end + 1).match(/^\s*(['"])([\s\S]*?)\1/);
      if (literal !== null && TAR_TOKEN.test(literal[2])) hits.push({ call, classification: SPAWN_KIND });
      continue;
    }
    if (!SHELL_ARG.test(after)) continue;
    // Shell form: the runner spawns sh/bash/... — tar as a token in the command string.
    const end = balancedEnd(masked, open, "(", ")");
    if (TAR_TOKEN.test(source.slice(open + 1, end + 1))) hits.push({ call, classification: SPAWN_KIND });
  }
  if (!owner) return hits;
  // Owner-only: every "-C" in a spawnLocal/localTarRunner("tar", [...]) literal must hand
  // tar a tarLocalPath(...) value (rf6-fix33: everything tar decodes goes forward-slash).
  for (const m of masked.matchAll(/\b(spawnLocal|localTarRunner)\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    if (!/^[ \t\r\n]*(['"])tar\1[ \t\r\n]*,[ \t\r\n]*\[/.test(source.slice(open + 1))) continue;
    const bracket = masked.indexOf("[", open);
    const end = balancedEnd(masked, bracket, "[", "]");
    const elements = splitElements(masked, source, bracket + 1, end);
    for (let i = 0; i < elements.length - 1; i++) {
      if (DASH_C.test(elements[i]) && !NORMALIZED.test(elements[i + 1])) {
        hits.push({ call: m[1], classification: UNNORMALIZED_KIND });
        break;
      }
    }
  }
  return hits;
}

export function analyze(source: string, owner = false): { spawns: Hit[]; unnormalized: Hit[] } {
  const hits = localTarHits(source, owner);
  return {
    spawns: hits.filter((hit) => hit.classification === SPAWN_KIND),
    unnormalized: hits.filter((hit) => hit.classification === UNNORMALIZED_KIND),
  };
}

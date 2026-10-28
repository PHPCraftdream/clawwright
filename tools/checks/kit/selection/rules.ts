// Dependency rules the import graph cannot see: whole-file relationships that live in shell
// scripts, child-process spawns, fixture wiring or prose rather than an import specifier. Each
// rule maps a glob of changed repo files to check-path filters (same substring semantics as the
// check command's --filters) plus the one-line reason the graph is blind to the dependency.

// The one sanctioned regex-escape helper (layout.check.ts enforces a single definition).
import { regexEscape } from "#framework/core/io/log.ts";

/** One dependency rule: changed files matching any glob select the checks named by the filters. */
export interface Rule {
  /** Repo-relative glob patterns (`*`, `**`, `?` only). */
  readonly changed: readonly string[];
  /** Substrings of check labels (paths relative to tools/checks), matched exactly like --filters. */
  readonly select: readonly string[];
  /** Why the import graph cannot see this dependency. */
  readonly reason: string;
}

// --- glob matching ------------------------------------------------------------------------------

/** Compiles a glob (`*` within one path segment, `**` across segments, `?` one non-separator
 *  character) to an anchored RegExp. A double star followed by a slash may also match zero
 *  directories at that boundary. */
export function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        while (pattern[i + 1] === "*") i += 1;
        if (pattern[i + 1] === "/") {
          i += 1;
          source += "(?:.*/)?";
        } else source += ".*";
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else source += regexEscape(char);
  }
  return new RegExp(source + "$");
}

/** Whether `path` (repo-relative, forward slashes) matches the glob `pattern`. */
export function matchGlob(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path);
}

// --- the rule table -----------------------------------------------------------------------------

/** Check files that exercise the framework by spawning the CLI as a child process; the spawn
 *  boundary erases the import edge from tools/framework to their assertions. */
const SPAWN_BASED_CHECKS: readonly string[] = [
  "foundation/cli/cli-help.check.ts",
  "foundation/cli/gate-dispatch.check.ts",
  "foundation/core/command/spec/binder.check.ts",
  "foundation/core/command/spec/call.check.ts",
  "foundation/hygiene/static/write-isolation.check.ts",
  "integration/agent/recipe-hook-freshness/hook-framework-import.check.ts",
  "integration/apps/invocation-hints-rooted.check.ts",
  "integration/init.check.ts",
  "integration/mcp/dispatch/gate-confirm.check.ts",
  "integration/mcp/dispatch/mcp-changed.check.ts",
  "integration/mcp/dispatch/mcp-server.check.ts",
  "integration/mcp/dispatch/option-literals.check.ts",
  "integration/mcp/mcp-mirror.check.ts",
  "integration/mcp-safety-policy.check.ts",
  "kit/capabilities/run-guard.check.ts",
  "kit/self/controls.check.ts",
  "kit/self/deployment-fixture.check.ts",
  "kit/self/harness.check.ts",
  "kit/self/runtime-guard.check.ts",
  "release/release/installed-consumer.check.ts",
  "release/release/system-install.check.ts",
  "sets/lifecycle/set-module-load.check.ts",
  "surfaces/advice/checkout-paste.check.ts",
  "surfaces/advice/real-shells.check.ts",
];

/** The rule table, in table order. */
export const RULES: readonly Rule[] = [
  {
    changed: ["tools/framework/**"],
    select: SPAWN_BASED_CHECKS,
    reason: "these checks spawn the CLI as a child process, so no import edge ties them to framework files",
  },
  {
    changed: ["docs/**", "README.md"],
    select: ["foundation/packaging/docs-commands.check.ts", "foundation/hygiene/readme-quickstart.check.ts", "foundation/hygiene/docs-private-content.check.ts"],
    reason: "docs prose and README text are read or checked directly, without any import edge to the checker",
  },
  {
    changed: ["tools/checks/golden/**"],
    select: ["golden/"],
    reason: "golden expectations live next to the check as committed fixtures, not as an import graph edge",
  },
  {
    changed: ["package.json", "package-lock.json", "tsconfig.json", ".github/**"],
    select: ["foundation/packaging/", "release/release/", "foundation/layout.check.ts"],
    reason: "packaging, release and layout checks read repo-level config and CI files directly, never via imports",
  },
  {
    changed: [".github/workflows/**"],
    select: ["ci/ci-tiers.check.ts"],
    reason: "the workflow-structure check parses ci.yml as text, with no import edge from the YAML",
  },
  {
    changed: ["tools/framework/commands/**"],
    select: [
      "integration/mcp/",
      "golden/",
      "foundation/core/command/completion/",
      "completeness/flags-matrix.check.ts",
      "property/",
      "foundation/core/command/spec/binder.check.ts",
      "foundation/cli/cli-help.check.ts",
      "foundation/core/command/needs.check.ts",
    ],
    reason: "whole-surface families assert over the full command registry, which is wired at runtime, not imported per command",
  },
  {
    changed: [
      "package-lock.json",
      "tools/framework/package.json",
      "tools/checks/release/license-audit.ts",
      "tools/checks/release/license-audit.check.ts",
      "LICENSE",
      "LICENSE-MIT",
      "LICENSE-APACHE",
      "NOTICE",
      "tools/framework/LICENSE",
      "tools/framework/LICENSE-MIT",
      "tools/framework/LICENSE-APACHE",
      "tools/framework/NOTICE",
    ],
    select: ["release/license-audit.check.ts"],
    reason: "the license audit reads lockfile, framework manifest and license/notice files directly, and its regression check copies them into a sandbox",
  },
  {
    changed: ["tools/checks/controls/**"],
    select: ["controls/"],
    reason: "control tables and their acceptance check share the controls/ directory without the check importing every table",
  },
];

/** The rules whose changed-globs match `changedFile` (possibly none). */
export function rulesFor(changedFile: string): readonly Rule[] {
  return RULES.filter((rule) => rule.changed.some((pattern) => matchGlob(pattern, changedFile)));
}

export interface RuleSelection {
  /** Check labels (tools/checks-relative) selected by at least one rule. */
  readonly labels: ReadonlySet<string>;
  /** Label -> the reason of the first rule that selected it. */
  readonly reasons: ReadonlyMap<string, string>;
}

/** Applies every rule to the changed files, resolving the select filters against the full list of
 *  check labels (same substring match as the check command's --filters). */
export function checksFromRules(changedFiles: readonly string[], checkLabels: readonly string[]): RuleSelection {
  const active = new Map<string, string>();
  for (const changed of changedFiles) {
    for (const rule of rulesFor(changed)) {
      for (const filter of rule.select) {
        for (const label of checkLabels) {
          if (label.includes(filter)) active.set(label, rule.reason);
        }
      }
    }
  }
  return { labels: new Set(active.keys()), reasons: active };
}

// Proves the static import graph: the conservative scanner finds real imports and ignores
// import-shaped text in strings and comments; alias/relative resolution matches the repo's
// package.json "imports" maps; and a synthetic mini-graph selects exactly the checks that
// transitively import a changed file, with the changed file and depth as the reason.

import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { buildImportGraph, parseImportSpecifiers, resolveSpecifier, selectRelatedChecks, stripNonCode } from "./import-graph.ts";

// --- scanning -----------------------------------------------------------------------------------

check("parse.string.with.import.word.finds.nothing", parseImportSpecifiers(`const s = 'the word import in a string';`), []);
check("parse.line.comment.import.ignored", parseImportSpecifiers(`// import x from "./nope.ts"`), []);
check("parse.block.comment.import.ignored", parseImportSpecifiers(`/*\nimport x from "./nope.ts"\n*/`), []);
check(
  "parse.real.import.after.fake.ones.is.found",
  parseImportSpecifiers(`const s = 'import x from "./a.ts"';\n// import y from "./b.ts"\nimport real from "./real.ts";`),
  ["./real.ts"],
);
check("parse.dynamic.import.found", parseImportSpecifiers(`const m = await import("./late.ts");`), ["./late.ts"]);
check("parse.export.from.found", parseImportSpecifiers(`export { Shell } from "./shells.ts";`), ["./shells.ts"]);
check("parse.bare.side.effect.import.found", parseImportSpecifiers(`import "./side-effect.ts";`), ["./side-effect.ts"]);
check(
  "parse.template.with.import.text.ignored",
  parseImportSpecifiers("const t = `import x from \"./inside.ts\";`;\nimport { a } from \"./actual.ts\";"),
  ["./actual.ts"],
);
check(
  "parse.escaped.quote.does.not.end.string",
  parseImportSpecifiers(`const s = "escaped \\" import x from \\"./fake.ts";\nimport real from "./real.ts";`),
  ["./real.ts"],
);
check("parse.specifiers.deduplicated.in.order", parseImportSpecifiers(`import "./a.ts";\nimport "./b.ts";\nimport "./a.ts";`), ["./a.ts", "./b.ts"]);
checkTrue("parse.strip.blanks.comment.bodies.only", !stripNonCode(`a/*x*/b`).includes("x"));

// --- resolution (pure: existence is injected, no filesystem needed) -----------------------------

const never = (): boolean => false;
const onlyTs = (path: string): boolean => path.endsWith(".ts");

check("resolve.alias.framework.family", resolveSpecifier("#framework/core/env.ts", "tools/x.ts", onlyTs), "packages/clawwright/core/env.ts");
check("resolve.alias.checks.family", resolveSpecifier("#checks/kit/harness.ts", "tools/x.ts", onlyTs), "tools/checks/kit/harness.ts");
check("resolve.alias.tools.family", resolveSpecifier("#tools/clawwright.ts", "tools/x.ts", onlyTs), "tools/clawwright.ts");
check("resolve.alias.framework.src.map", resolveSpecifier("#src/core/env.ts", "tools/x.ts", onlyTs), "packages/clawwright/core/env.ts");
check("resolve.relative.uses.importer.directory", resolveSpecifier("./spawn.ts", "tools/checks/kit/harness.ts", onlyTs), "tools/checks/kit/spawn.ts");
check("resolve.relative.parent", resolveSpecifier("../harness.ts", "tools/checks/kit/self/shells.check.ts", onlyTs), "tools/checks/kit/harness.ts");
check("resolve.bare.package.ignored", resolveSpecifier("json5", "tools/x.ts", onlyTs), null);
check("resolve.node.builtin.ignored", resolveSpecifier("node:fs", "tools/x.ts", onlyTs), null);
check("resolve.missing.target.is.null", resolveSpecifier("./ghost.ts", "tools/x.ts", never), null);
check("resolve.extensionless.gets.dot.ts", resolveSpecifier("./spawn", "tools/checks/kit/harness.ts", onlyTs), "tools/checks/kit/spawn.ts");

// --- end-to-end mini-graph over a synthetic temp tree --------------------------------------------

let made: string | undefined;
try {
  made = mkdtempSync(join(tmpdir(), "import-graph-check-"));
  // Physical temp tree; graph paths are the repo-relative POSIX spellings selectRelatedChecks
  // filters on (*.check.ts under tools/checks/), so the fixture mirrors that layout virtually.
  mkdirSync(join(made, "fx"), { recursive: true });
  writeFileSync(join(made, "fx", "leaf.ts"), `export const leaf = 1;\n`);
  writeFileSync(join(made, "fx", "intermediate.ts"), `import { leaf } from "./leaf.ts";\nexport const mid = leaf;\n`);
  writeFileSync(join(made, "fx", "the.check.ts"), `import { mid } from "./intermediate.ts";\ncheckTrue("x", true);\n`);
  writeFileSync(join(made, "fx", "unrelated.ts"), `export const other = 2;\n`);

  const physical = ["leaf.ts", "intermediate.ts", "the.check.ts", "unrelated.ts"];
  const virtual = (name: string): string => "tools/checks/fx/" + name;
  const graph = new Map<string, string[]>();
  for (const name of physical) {
    const file = virtual(name);
    // Resolution is unit-tested above; here plain relative joining mirrors it for the fixture.
    graph.set(file, parseImportSpecifiers(readFileSync(join(made, "fx", name), "utf8")).map((s) => posix.join("tools/checks/fx", s)));
  }

  const leafSelection = selectRelatedChecks(graph, ["tools/checks/fx/leaf.ts"]);
  check("select.changed.leaf.selects.exactly.the.check", leafSelection.checks, [
    { file: "tools/checks/fx/the.check.ts", depth: 2, via: "tools/checks/fx/leaf.ts" },
  ]);
  checkTrue("select.reachable.set.holds.the.check", leafSelection.reachableChecks.has("tools/checks/fx/the.check.ts"));

  check("select.unrelated.changed.file.selects.nothing", selectRelatedChecks(graph, ["tools/checks/fx/unrelated.ts"]).checks, []);
  // A changed check file is itself the reason to run it — depth 0, via itself.
  check("select.changed.check.selects.itself.at.depth.zero", selectRelatedChecks(graph, ["tools/checks/fx/the.check.ts"]).checks, [
    { file: "tools/checks/fx/the.check.ts", depth: 0, via: "tools/checks/fx/the.check.ts" },
  ]);
} finally {
  if (made !== undefined) rmSync(made, { recursive: true, force: true });
}

// The real graph builds over this repo and resolves its own import (sanity, machine-independent paths).
const realGraph = buildImportGraph();
checkTrue("real.graph.contains.this.file", realGraph.has("tools/checks/kit/selection/import-graph.ts"));
checkTrue("real.graph.contains.relocated.product.module", realGraph.has("packages/clawwright/commands/lifecycle/bootstrap/check.ts"));
checkTrue("real.graph.contains.transitive.product.dependency", realGraph.has("packages/clawwright/core/context.ts"));
const productSources = [...realGraph.keys()].filter((file) => file.startsWith("packages/clawwright/") && !file.endsWith(".check.ts"));
const productReachableChecks = selectRelatedChecks(realGraph, productSources).reachableChecks;
const formerlyMissingChecks = [
  "tools/checks/foundation/providers/provider.check.ts",
  "tools/checks/integration/agent/cron-timezone.check.ts",
  "tools/checks/runtime/recovery/private-config-publish.check.ts",
  "tools/checks/runtime/service/image-identity/compose-sweep.check.ts",
  "tools/checks/runtime/service/image-identity/runtime-image-identity.check.ts",
  "tools/checks/runtime/service/image-identity/upgrade-support.check.ts",
  "tools/checks/runtime/transport/remote/ssjack-client.check.ts",
  "tools/checks/runtime/transport/remote/ssjack-contract.check.ts",
  "tools/checks/runtime/transport/remote/ssjack-scoped.check.ts",
  "tools/checks/runtime/transport/remote/ssjack-selection.check.ts",
  "tools/checks/runtime/transport/remote/ssjack-stream.check.ts",
  "tools/checks/runtime/transport/remote/ssjack.check.ts",
  "tools/checks/sets/artifact/set-evidence.check.ts",
];
check("real.graph.product.sources.reach.named.checks", formerlyMissingChecks.filter((file) => !productReachableChecks.has(file)), []);
checkTrue("explicit.rootDir.remains.tools.only", !buildImportGraph("tools").has("packages/clawwright/core/context.ts"));
checkTrue(
  "real.graph.edges.point.inside.repo",
  [...realGraph.values()].flat().every((target) => !target.includes("\\") && !target.startsWith("/")),
);

finish("kit-selection-import-graph");

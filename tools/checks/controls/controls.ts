// The registry of negative controls (stage 7, S0.3): for each mechanism a past review round
// fixed, the product edit that would reintroduce it and the check that MUST fail with the
// edit applied. `npm run check:controls` applies each edit to one shared temp copy of the
// repository and demands the failure — a control that no longer fails is a finding, never
// a skip. Invariant I11: an evidence-bearing check ships with a control.

import { STAGE7_CONTROLS } from "./stage7.ts";
import { STAGE7_ACCEPT_CONTROLS } from "./stage7-accept.ts";

export interface ControlDecl {
  readonly id: string;
  /** The row in docs/internal/review-findings-registry.md whose fix this control pins. */
  readonly finding: string;
  /** One line: which mechanism the control pins. */
  readonly note: string;
  /** Repo-relative, forward slashes. */
  readonly product: string;
  /** Search text that must occur EXACTLY once in the product file. */
  readonly search: string;
  readonly replace: string;
  /** Repo-relative path of the check file that must fail with the edit applied. */
  readonly check: string;
  /** A stable fragment of the failing assertion's name in the check's output. */
  readonly fragment: string;
  /** The check's baseline needs git metadata in the temp copy (e.g. deploy's tracked-files vetting). */
  readonly needsGit?: boolean;
  /** Host capabilities (capabilities.ts) whose absence means this control cannot bite on this host — it is reported as `skipped (needs <cap>)`, never as a failure. */
  readonly requires?: readonly string[];
}

export const CONTROLS: readonly ControlDecl[] = [
  {
    id: "F5-recipe-check-failure",
    finding: "F5",
    note: "recipe check propagates subprocess failures to the command verdict",
    product: "packages/clawwright/commands/management/recipe/recovery/checks/check.ts",
    search: "return failed === 0 && !lintFailed ? 0 : 1;",
    replace: "return 0;",
    check: "tools/checks/management/recipe/actions/check-action.check.ts",
    fragment: "failing checks return nonzero",
  },
  {
    id: "C1",
    finding: "R19-06",
    note: "late argument refusal: the binder's parse must own set --name — a kind whose parse accepts everything lets every invalid sample flow past parse to set build's run-stage refusal, failing the sweep's stage assertion",
    product: "packages/clawwright/commands/sets/set.ts",
    search: `, value: kinds.name("set", "create") }`,
    replace: `, value: { ...kinds.name("set", "create"), parse: (raw: string) => raw } }`,
    check: "tools/checks/foundation/core/command/pipeline/property/property.check.ts",
    fragment: "refused no later than prepare",
  },
  {
    id: "C2",
    finding: "R18-11",
    note: "destroy --confirm-name value refusal must sit at prepare, not after the context",
    product: "packages/clawwright/commands/lifecycle/instance/destroy.ts",
    search: "      if (confirmName !== deploymentName()) {\n        call.refuse(\"confirm-name\", confirmNameMismatch(confirmName));\n      }\n      return { ...values, confirmName };\n    }\n    return { ...values };\n  },\n  async run(ctx, plan) {\n    const targets = destroyTargets(ctx, plan);\n    for (const target of targets) assertSafeRemovalShape(target);\n\n    // Never bootstrapped: no instance or lock home exists \u2014 only the independent dirs can be there.\n    const bootstrapped = await ctx.runtime.isRunning().then(() => true, (error) => {\n      if (error instanceof NotBootstrapped) return false;\n      throw error;\n    });\n\n    if (plan.confirmName === undefined) {",
    replace: "      return { ...values, confirmName };\n    }\n    return { ...values };\n  },\n  async run(ctx, plan) {\n    const targets = destroyTargets(ctx, plan);\n    for (const target of targets) assertSafeRemovalShape(target);\n\n    // Never bootstrapped: no instance or lock home exists \u2014 only the independent dirs can be there.\n    const bootstrapped = await ctx.runtime.isRunning().then(() => true, (error) => {\n      if (error instanceof NotBootstrapped) return false;\n      throw error;\n    });\n\n    if (plan.confirmName !== deploymentName()) {\n      throw new Error(confirmNameMismatch(plan.confirmName ?? \"\"));\n    }\n    if (plan.confirmName === undefined) {",
    check: "tools/checks/controls/stage-placement.check.ts",
    fragment: "at the prepare stage",
  },
  {
    id: "C3",
    finding: "R18-03",
    note: "advice naming another deployment must keep its own --app, not the current selection's",
    product: "packages/clawwright/core/io/invocation/render.ts",
    search: `  } else if (advice.app !== undefined) {
    parts.push("--app", quote(advice.app));
  } else if (`,
    replace: `  } else if (advice.app !== undefined && false) {
    parts.push("--app", quote(advice.app));
  } else if (`,
    check: "tools/checks/surfaces/advice/advice-matrix.check.ts",
    fragment: "--app names the rule's deployment",
  },
  {
    id: "C4",
    finding: "R18-13",
    note: "toArgv emits positionals from the chosen action's own slice, never the merged declaration",
    product: "packages/clawwright/integration/mcp/legacy.ts",
    search: `  for (const argument of slice) {
    if (argument.kind !== "positional") continue;`,
    replace: `  for (const argument of declared) {
    if (argument.kind !== "positional") continue;`,
    check: "tools/checks/foundation/core/command/pipeline/property/property.check.ts",
    fragment: "emits the action's own positionals in its own order",
  },
  {
    id: "C5",
    finding: "R19-01",
    note: "an unreachable target is rethrown by the journal question, never read as no operations",
    product: "packages/clawwright/service/operations.ts",
    search: "  const files = (await Promise.all([operationsDir(ctx), ...legacyOperationsDirs(ctx)].map(async (directory) => {\n    const listed = await listIfExists(ctx.transport, directory);\n    return listed.kind === \"absent\" ? [] as string[] : listed.value;\n  }))).flat();",
    replace: "  const files = (await Promise.all([operationsDir(ctx), ...legacyOperationsDirs(ctx)].map((directory) =>\n    ctx.transport.listFiles(directory).catch(() => [] as string[]),\n  ))).flat();",
    check: "tools/checks/runtime/transport/target-unreachable.check.ts",
    fragment: "operations reports an unreachable target instead of an empty journal",
  },
  {
    id: "C6",
    finding: "R18-07",
    note: "the --json refusal document's structured `next` advice is masked",
    product: "packages/clawwright/core/command/execute.ts",
    search: `      next: advice.map(maskedJson),`,
    replace: `          next: advice,`,
    check: "tools/checks/foundation/core/command/pipeline/execute.check.ts",
    fragment: "the --json document carries the refusal's structured remedy",
  },
  {
    id: "C7",
    finding: "R18-23",
    note: "upgrade --dry-run --json carries the pinned image reference",
    product: "packages/clawwright/commands/lifecycle/instance/upgrade.ts",
    search: `{ ok: true, changed: false, current: previousDigest, channel: target.channel ?? null, target: target.targetDigest, pinnedImage: pinnedReference, upToDate }`,
    replace: `{ ok: true, changed: false, current: previousDigest, channel: target.channel ?? null, target: target.targetDigest, pinnedImage: target.targetDigest, upToDate }`,
    check: "tools/checks/runtime/connection-facts/upgrade/pin-and-digest.check.ts",
    fragment: "JSON dry-run of a tagless tracked-repo digest retains the channel tag",
  },
  {
    id: "C8",
    finding: "R19-18",
    note: "the schema-summary pin in view.check fails when the shared argument table's summary changes",
    product: "packages/clawwright/commands/interface/groups/shared-arguments.ts",
    search: `  summary: "Take over the lock",`,
    replace: `  summary: "Take the lock",`,
    check: "tools/checks/foundation/core/command/spec/view.check.ts",
    fragment: "break-lock's schema line is the declared summary",
  },
  {
    id: "C9",
    finding: "R19-15",
    note: "SSH-operator and target-local scheduler ownership derive independently and the check demands equality, so a drift in one path fails it",
    product: "packages/clawwright/commands/operate/schedule.ts",
    search: `root = await realpath(deploymentDir());`,
    replace: `root = "clawwright-drift";`,
    check: "tools/checks/runtime/schedule/identity.check.ts",
    fragment: "same-basename Windows task names differ",
  },
  {
    id: "C11",
    finding: "R19-18",
    note: "the receipt writer/reader path is compared against the fixture, so a writer or reader that loses identity fails",
    product: "packages/clawwright/set/artifacts/receipt.ts",
    search: "    await handle.close();\n  }\n  return receipt;",
    replace: "    await handle.close();\n  }\n  return { ...receipt, setName: `${receipt.setName}-drift` };",
    check: "tools/checks/sets/artifact/set-receipt.check.ts",
    fragment: "preserves the receipt",
  },
  {
    id: "C10",
    finding: "R19-15",
    note: "the scheduler's crontab-update refusal keeps the exit code in the operator's text",
    product: "packages/clawwright/commands/operate/schedule.ts",
    search: "  return `could not update crontab on ${description} (exit ${code}): ${reason}`;",
    replace: "  return `could not update crontab on ${description}: ${reason}`;",
    check: "tools/checks/runtime/schedule/schedule.check.ts",
    fragment: "account lock refusal reaches the operator",
  },
  {
    id: "C12",
    finding: "R19-18",
    note: "the identity probe's evidence names the probe itself (id -u), not just the answer",
    product: "packages/clawwright/commands/interface/host/contexts.ts",
    search: "  return `the identity probe id -u answered uid ${uid} on ${description}`;",
    replace: "  return `the identity probe answered uid ${uid} on ${description}`;",
    check: "tools/checks/foundation/cli/host.check.ts",
    fragment: "the refusal names where the uid answer came from",
  },
  {
    id: "C13",
    finding: "R18-19",
    note: "the provision-agent recipe mirror (the shared files mirror) copies asset bytes verbatim",
    product: "packages/clawwright/runtime/files/files.ts",
    search: "const content = await readFile(resolve(sourceDir, ...rel.split(\"/\")));",
    replace: "const content = (await readFile(resolve(sourceDir, ...rel.split(\"/\")))).subarray(1);",
    check: "tools/checks/runtime/lifecycle/recipe-portable-content.check.ts",
    fragment: "byte-identical",
    needsGit: true,
  },
  {
    id: "C14",
    finding: "R19-18",
    note: "the deploy framework sync's rsync source is the checkout root itself",
    product: "packages/clawwright/commands/management/deploy/sync.ts",
    search: "    `${source}/`,\n",
    replace: "    `${source.slice(0, source.lastIndexOf(\"/\"))}/`,\n",
    check: "tools/checks/runtime/service/deploy/checkout-policy/checkout-policy.check.ts",
    fragment: "used the checkout root",
    needsGit: true,
  },
  {
    id: "C15",
    finding: "R19-05",
    note: "a local tar invocation with an unnormalized -C path back inside the owner module",
    product: "packages/clawwright/set/artifacts/tar.ts",
    search: `return runLocalTar(["-czf", archive, "-C", fromDir, "."], { ...options, archivePath: archive });`,
    replace: `return spawnLocal("tar", ["-czf", archive, "-C", fromDir, "."], { allowFailure: true });`,
    check: "tools/checks/foundation/hygiene/static/local-tar-owner.check.ts",
    fragment: "unnormalized -C in the owner",
  },
  {
    id: "C16",
    finding: "R19-05",
    note: "path normalization removed from the owner's tar arguments",
    product: "packages/clawwright/set/artifacts/tar.ts",
    search: `const first = await localTarRunner("tar", [...forceLocal, ...args.map(tarLocalPath)], { allowFailure: true, timeoutMs });`,
    replace: `const first = await localTarRunner("tar", [...forceLocal, ...args], { allowFailure: true, timeoutMs });`,
    check: "tools/checks/sets/tar/local-tar-owner.check.ts",
    fragment: "backslash:",
    requires: ["windows-host", "gnu-userland"], // the -C assertions run only with GNU tar and bite only where join() spells backslashes
  },
  {
    id: "C17",
    finding: "R19-17",
    note: "an unknown MCP action is refused in the console's words, never silently bound to the default action",
    product: "packages/clawwright/core/command/parse/index.ts",
    search: `if (!known.has(word)) dieUnknownAction(word, unknownActionMessage(word, names), names, "action");`,
    replace: `return fallback() ?? dieUnknownAction(word, unknownActionMessage(word, names), names, "action");`,
    check: "tools/checks/foundation/core/command/spec/call.check.ts",
    fragment: "unknown action refuses with the console's words",
  },
  {
    id: "C18",
    finding: "R19-17",
    note: "an Object.prototype member (constructor, toString, __proto__) is never a declared action",
    product: "packages/clawwright/core/command/parse/index.ts",
    search: `if (!known.has(word)) dieUnknownAction(word, unknownActionMessage(word, names), names, "action");`,
    replace: `if (false) dieUnknownAction(word, unknownActionMessage(word, names), names, "action");`,
    check: "tools/checks/foundation/core/command/spec/call.check.ts",
    fragment: "prototype name refused with the console's words",
  },
  {
    id: "C20",
    finding: "R19-01 (neighbour)",
    note: "the destination presence check keeps the read contract: a stat the target cannot answer is unknown, not 'no snapshot'",
    product: "packages/clawwright/service/operations.ts",
    search: "  if (await probeExists(ctx.transport, destination)) return undefined;",
    replace: "  try { if (await ctx.transport.exists(destination)) return undefined; } catch { return undefined; }",
    check: "tools/checks/runtime/transport/scenarios/target-read-sites.check.ts",
    fragment: "a destination the target cannot stat is unknown",
  },
      {
    id: "C21",
    finding: "R19-01 (neighbour)",
    note: "the live-config read keeps the read contract: an unreachable/unreadable source is never read as absent",
    product: "packages/clawwright/service/operations.ts",
    search: "  const liveRead = await readIfExists(ctx.transport, live);\n  if (liveRead.kind === \"absent\") return undefined;",
    replace: "  let liveRead: { kind: \"absent\" } | { kind: \"present\"; value: string };\n  try { liveRead = (await ctx.transport.exists(live)) ? { kind: \"present\", value: await ctx.transport.readFile(live) } : { kind: \"absent\" }; } catch { liveRead = { kind: \"absent\" }; }\n  if (liveRead.kind === \"absent\") return undefined;",
    check: "tools/checks/runtime/transport/scenarios/target-read-sites.check.ts",
    fragment: "a refused contact is a typed unknown",
  },
  {
    id: "C22",
    finding: "R19-01 (neighbour)",
    note: "the operation-history listing keeps the read contract: an unreadable target is never an empty history",
    product: "packages/clawwright/service/operations.ts",
    search: "  const files = (await Promise.all([operationsDir(ctx), ...legacyOperationsDirs(ctx)].map(async (directory) => {\n    const listed = await listIfExists(ctx.transport, directory);\n    return listed.kind === \"absent\" ? [] as string[] : listed.value;\n  }))).flat();",
    replace: "  const files = (await Promise.all([operationsDir(ctx), ...legacyOperationsDirs(ctx)].map((directory) =>\n    ctx.transport.listFiles(directory).catch(() => [] as string[]),\n  ))).flat();",
    check: "tools/checks/runtime/transport/scenarios/target-read-sites.check.ts",
    fragment: "an unreadable history directory is unknown",
  },
  {
    id: "C23",
    finding: "R19-07 (neighbour)",
    note: "the read contract always attaches its Advice to an unknown answer",
    product: "packages/clawwright/runtime/transport/quoting.ts",
    search: "      advice: [command(\"status\", { note: \"reports whether the target answers at all\" })],",
    replace: "      advice: [],",
    check: "tools/checks/runtime/transport/scenarios/target-read-sites.check.ts",
    fragment: "the rendered next step names the project command",
  },
  {
    id: "C40",
    finding: "S2.4",
    note: "apply --expect keeps the hex64 checksum kind, not a dash-permitting grammar-less text kind",
    product: "packages/clawwright/commands/orchestration/apply.ts",
    search: `, value: kinds.checksum("hex64", { expected: "a declaration checksum", invalid: () => "takes a declaration checksum — 64 hexadecimal digits", example: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" }) }`,
    replace: `, value: kinds.text("declaration checksum", { leadingDash: "allow" }) }`,
    check: "tools/checks/foundation/core/command/pipeline/property/property.check.ts",
    fragment: "apply --expect",
  },
  {
    id: "C41",
    finding: "S2.4",
    note: "the hex64 checksum kind pins exactly 64 hexadecimal digits",
    product: "packages/clawwright/core/values/kinds.ts",
    search: `/^[0-9a-f]{64}$/.test(raw)`,
    replace: `/^[0-9a-f]{4,64}$/.test(raw)`,
    check: "tools/checks/values/kind.check.ts",
    fragment: "checksum hex64 refuses a short prefix",
  },
  {
    id: "C42",
    finding: "S2.4",
    note: "deploy <target> keeps its leading-dash refusal in the sshDestination kind",
    product: "packages/clawwright/core/values/kinds.ts",
    search: `raw[0] === "-" || /\\s`,
    replace: `raw[0] === "-Z" || /\\s`,
    check: "tools/checks/foundation/core/command/pipeline/property/property.check.ts",
    fragment: "deploy: <target>",
  },
  {
    id: "C30",
    finding: "S1.2a-D1",
    note: "the program is spelled by the KIND of launch through spell(); deciding by a slash in the handed spelling drops npm's Windows bin wrapper (no slash) to the shim and un-climbs the subdirectory spellings",
    product: "packages/clawwright/core/io/invocation/render.ts",
    search: `    if (launchRoot !== undefined && launchRoot !== "" && from !== undefined) {`,
    replace: `    if (from !== undefined) { program = handed.includes("/") ? handed : SHIM_PROGRAM; } else if (false) {`,
    check: "tools/checks/surfaces/frame-law.check.ts",
    // S1.6: the law now resolves the deployment-directory shim paste (the fixture carries the committed shim), so the witness keys are the checkout-subdirectory shim hints the un-climb breaks
    fragment: "checkout gate shim (cwd: docs) | command: status",
  },
  {
    id: "C31",
    finding: "S1.2a-quoting",
    note: "argument quoting follows the frame's shells (double-quote rule for a frame that pastes into cmd.exe and PowerShell); collapsing both frames onto the POSIX single-quote rule breaks the pasted words in cmd",
    product: "packages/clawwright/core/io/invocation/render.ts",
    search: `  const quote = (word: string): string => (posixOnly ? posixArgument(word) : shellArgument(word));`,
    replace: `  const quote = (word: string): string => posixArgument(word);`,
    check: "tools/checks/surfaces/frame-law.check.ts",
    fragment: "law: quoting round-trip",
  },
  ...STAGE7_CONTROLS,
  ...STAGE7_ACCEPT_CONTROLS,
];

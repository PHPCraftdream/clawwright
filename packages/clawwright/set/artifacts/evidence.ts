import { frameworkVersion } from "#src/commands/management/lock.ts";
import { maskSecrets } from "#src/core/io/log.ts";
import { writeReceipt } from "./receipt.ts";
import type { ReceiptObservations, AcceptanceReceipt, ReceiptCheckInput, ReceiptSource } from "./receipt.ts";
import type { SetManifest } from "./model.ts";
import type { VerifiedArtifact } from "./install.ts";
import type { Context } from "#src/core/context.ts";
import type { AcceptanceResult } from "#src/commands/orchestration/accept.ts";
import type { SecurityAuditReport } from "#src/security/audit.ts";
import { blockingProblems } from "#src/service/inspection.ts";
import { digestOf } from "#src/runtime/docker/image-ref.ts";

export interface ObservedRuntime {
  readonly observations: ReceiptObservations;
  readonly containerId?: string;
  readonly digests: readonly string[];
}

/** Read the container's identity, never resolve the configured tag as a substitute. */
export async function observeRuntime(ctx: Context, manifest: SetManifest): Promise<ObservedRuntime> {
  const version = await frameworkVersion();
  let image;
  try { image = await ctx.runtime.runningImageIdentity?.(); } catch { /* Unknown is retained. */ }
  const digests = image?.digests ?? [];
  const requiredDigest = digestOf(manifest.requires.image);
  const imageDigest = digests.find((digest) => digestOf(digest) === requiredDigest) ?? digests[0];
  return {
    observations: {
      frameworkVersion: version ?? "unknown",
      ...(image?.version === undefined ? {} : { openclawVersion: image.version }),
      ...(image?.imageId === undefined ? {} : { imageId: image.imageId }),
      ...(imageDigest === undefined ? {} : { imageDigest }),
    },
    containerId: image?.containerId,
    digests,
  };
}

export function runtimeMatches(manifest: SetManifest, before: ObservedRuntime, after: ObservedRuntime): boolean {
  const requiredDigest = digestOf(manifest.requires.image);
  return before.containerId !== undefined && before.containerId === after.containerId
    && before.observations.imageId !== undefined && before.observations.imageId === after.observations.imageId
    && before.observations.frameworkVersion === manifest.requires.framework
    && after.observations.frameworkVersion === manifest.requires.framework
    && before.digests.some((digest) => digestOf(digest) === requiredDigest)
    && after.digests.some((digest) => digestOf(digest) === requiredDigest);
}

/** A result slot belongs to one declared check, even when that check never completed. */
export async function saveEvidence(input: {
  verified: VerifiedArtifact;
  source: ReceiptSource;
  startedAt: string;
  withModel: boolean;
  selected: readonly string[];
  results: Record<string, readonly AcceptanceResult[]>;
  observed: ObservedRuntime;
  subjectVerified: boolean;
  security?: SecurityAuditReport;
  failure?: string;
  root?: string;
}): Promise<AcceptanceReceipt> {
  const checks: Record<string, ReceiptCheckInput[]> = {};
  for (const recipe of input.selected) {
    const definitions = input.verified.manifest.acceptance[recipe];
    if (definitions === undefined) throw new Error(`recipe ${recipe} has no acceptance declaration in this artifact`);
    checks[recipe] = definitions.map((definition, index) => {
      const result = input.results[recipe]?.[index];
      const detail = result?.detail ?? (result === undefined ? input.failure ?? "check did not complete" : undefined);
      return {
        name: definition.name ?? definition.kind,
        kind: definition.kind,
        status: result?.status ?? "could-not-check",
        ...(detail === undefined ? {} : { detail: maskSecrets(detail) }),
        definition,
      };
    });
  }
  const all = Object.keys(input.verified.manifest.acceptance).sort();
  const selected = [...input.selected].sort();
  const blocking = input.security === undefined ? undefined : blockingProblems(input.security.problems);
  return writeReceipt({
    setId: input.verified.id,
    setName: input.verified.manifest.name,
    source: input.source,
    subjectVerified: input.subjectVerified,
    ...(blocking === undefined ? {} : { security: { blocking: blocking.length, reasons: blocking.map((problem) => problem.code) } }),
    selection: { recipes: input.selected, withModel: input.withModel, allRecipes: JSON.stringify(all) === JSON.stringify(selected) },
    observations: input.observed.observations,
    startedAt: input.startedAt,
    finishedAt: new Date().toISOString(),
    checks,
  }, input.root);
}

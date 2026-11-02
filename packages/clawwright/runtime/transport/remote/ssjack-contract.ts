import { UserError } from "#src/core/io/log.ts";

/** Temporary child credentials; these names must never reach unrelated subprocesses. */
export const SSJACK_ENV = {
  endpoint: "SSJACK_APP_ENDPOINT",
  token: "SSJACK_APP_TOKEN",
  pin: "SSJACK_APP_CERTIFICATE_SHA256",
} as const;

/** Scrub only the supplied environment copy, including stale case variants on every OS. */
export function clearSsjackEnvironment(environment: Record<string, string | undefined>): void {
  const names = new Set(Object.values(SSJACK_ENV).map((name) => name.toLowerCase()));
  for (const name of Object.keys(environment)) {
    if (names.has(name.toLowerCase())) delete environment[name];
  }
}

/** Minimum optional serving protocol, independent of where a binary was prepared. */
export const SSJACK_REQUIREMENTS = {
  optional: true,
  protocol: 1,
  chunkSize: 16384,
  capabilities: ["exec", "stdin", "binary", "backpressure", "cancel"],
  cancellation: "connection-only",
} as const;

interface SupplyBase {
  readonly repository: "PHPCraftdream/ssjack";
  readonly commit: string;
  readonly platform: "windows-amd64" | "linux-amd64" | "linux-arm64" | "darwin-amd64" | "darwin-arm64";
  readonly archiveSHA256: string;
  readonly executableSHA256: string;
}

export type SsjackSupply = SupplyBase & (
  | { readonly kind: "ci"; readonly runId: number; readonly artifactId: number; readonly artifactName: string }
  | { readonly kind: "release"; readonly version: string; readonly asset: string }
);

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const digest = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const positiveId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const name = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);

/** Validate an operator's supply record, never install or discover a replacement. */
export function validateSsjackSupply(value: unknown): SsjackSupply {
  const invalid = (): never => { throw new UserError("SSJACK_SUPPLY_INVALID"); };
  if (!record(value) || value.repository !== "PHPCraftdream/ssjack" ||
      typeof value.commit !== "string" || !/^[0-9a-f]{40}$/.test(value.commit) ||
      typeof value.platform !== "string" || !["windows-amd64", "linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64"].includes(value.platform) ||
      !digest(value.archiveSHA256) || !digest(value.executableSHA256)) return invalid();
  const base = {
    repository: "PHPCraftdream/ssjack" as const,
    commit: value.commit,
    platform: value.platform as SsjackSupply["platform"],
    archiveSHA256: value.archiveSHA256,
    executableSHA256: value.executableSHA256,
  };
  if (value.kind === "ci" && positiveId(value.runId) && positiveId(value.artifactId) && name(value.artifactName)) {
    if (Object.keys(value).some((key) => ![...Object.keys(base), "kind", "runId", "artifactId", "artifactName"].includes(key))) return invalid();
    return { ...base, kind: "ci", runId: value.runId, artifactId: value.artifactId, artifactName: value.artifactName };
  }
  if (value.kind === "release" && typeof value.version === "string" && /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(value.version) && name(value.asset)) {
    if (Object.keys(value).some((key) => ![...Object.keys(base), "kind", "version", "asset"].includes(key))) return invalid();
    return { ...base, kind: "release", version: value.version, asset: value.asset };
  }
  return invalid();
}

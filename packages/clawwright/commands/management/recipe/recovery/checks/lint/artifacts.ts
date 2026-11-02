import { hasFlag, instructions, shellTokens } from "./text.ts";

export interface ArgDeclaration { readonly name: string; readonly value?: string }
export interface PinnedAddDeclaration {
  readonly line: number;
  readonly urlTemplate: string;
  readonly versionArg: string;
  readonly version: string;
  readonly checksumArg: string;
  readonly checksum: string;
  readonly versionArgLine: number;
  readonly checksumArgLine: number;
}

export function parseArgDeclaration(text: string): ArgDeclaration | undefined {
  const declaration = /^([A-Za-z_]\w*)(?:=(.*))?$/.exec(text.trim());
  if (declaration === null) return undefined;
  return declaration[2] === undefined ? { name: declaration[1] } : { name: declaration[1], value: shellTokens(declaration[2])[0] ?? "" };
}

export interface ResolvedArg { readonly value: string | undefined; readonly line: number }

// Shared ARG resolution across the lint and the pin artifact extraction: a stage's map is
// seeded from the base image's map, a stage-level ARG without a value keeps the current
// stage value when present and only then falls back to the global default.
export class ArgResolver {
  readonly #globalArgs = new Map<string, ResolvedArg>();
  readonly #stages = new Map<string, Map<string, ResolvedArg>>();
  #args = this.#globalArgs;
  #stageIndex = 0;

  fromStage(base: string, alias?: string): void {
    this.#args = new Map(this.#stages.get(base) ?? []);
    this.#stages.set(String(this.#stageIndex++), this.#args);
    if (alias) this.#stages.set(alias, this.#args);
  }

  arg(declaration: ArgDeclaration, line: number): void {
    const resolved = declaration.value === undefined
      ? this.#args.get(declaration.name) ?? this.#globalArgs.get(declaration.name) ?? { value: undefined, line }
      : { value: declaration.value, line };
    this.#args.set(declaration.name, resolved);
  }

  get(name: string): ResolvedArg | undefined { return this.#args.get(name); }

  hasStage(name: string): boolean { return this.#stages.has(name); }
}

export function artifactReference(value: string): { readonly name: string } | undefined {
  const match = /^\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\})$/.exec(value);
  return match === null ? undefined : { name: match[1] ?? match[2] };
}

export function extractArtifactDeclarations(source: string): PinnedAddDeclaration[] {
  const resolver = new ArgResolver();
  const result: PinnedAddDeclaration[] = [];
  for (const ins of instructions(source)) {
    if (ins.unparsed) continue;
    if (ins.command === "FROM") {
      const words = shellTokens(ins.text).filter((x) => hasFlag(x, "--") === undefined);
      const alias = words[1]?.toUpperCase() === "AS" ? words[2]?.toLowerCase() : undefined;
      resolver.fromStage(words[0]?.toLowerCase() ?? "", alias);
      continue;
    }
    if (ins.command === "ARG") {
      const parsed = parseArgDeclaration(ins.text);
      if (parsed) resolver.arg(parsed, ins.line);
      continue;
    }
    if (ins.command !== "ADD") continue;
    const words = shellTokens(ins.text);
    const checksum = words.map((w) => hasFlag(w, "--checksum=")).find((value) => value !== undefined);
    const urls = words.filter((w) => /^https:\/\//i.test(w));
    if (urls.length !== 1 || !checksum) continue;
    const cref = /^sha256:\$\{?([A-Za-z_]\w*)\}?$/.exec(checksum);
    if (!cref || (checksum.includes("{") !== checksum.includes("}"))) continue;
    const matches = [...urls[0].matchAll(/\$\{?([A-Za-z_]\w*)\}?/g)];
    const names = [...new Set(matches.map((m) => m[1]))];
    if (names.length !== 1 || matches.some((m) => m[0].includes("{") !== m[0].includes("}"))) continue;
    const versionArg = names[0], v = resolver.get(versionArg), c = resolver.get(cref[1]);
    if (!v?.value || !c?.value || versionArg === cref[1] || !/^[A-Za-z0-9][A-Za-z0-9_.+-]*$/.test(v.value) || !/^[0-9a-f]{64}$/.test(c.value)) continue;
    result.push({ line: ins.line, urlTemplate: urls[0], versionArg, version: v.value, checksumArg: cref[1], checksum: c.value, versionArgLine: v.line, checksumArgLine: c.line });
  }
  return result;
}

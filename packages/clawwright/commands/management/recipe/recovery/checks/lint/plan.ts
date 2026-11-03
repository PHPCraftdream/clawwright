import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { composeTargets } from "./compose.ts";
import { lintDockerfile } from "./rules.ts";
import type { Finding } from "./text.ts";

export interface LintPlan { readonly targets: readonly string[]; readonly findings: readonly Finding[] }

export async function prepareLint(directory: string, portable: readonly string[]): Promise<LintPlan> {
  const targets = new Map<string, Readonly<Record<string, string | undefined>>[]>();
  const findings: Finding[] = [];
  for (const file of portable) {
    const name = file.split("/").at(-1)!;
    if (name === "Dockerfile" || name.startsWith("Dockerfile.") || name.endsWith(".Dockerfile")) targets.set(file, []);
  }
  if (portable.includes("compose.yml")) {
    try {
      const builds = composeTargets(await readFile(resolve(directory, "compose.yml"), "utf8"));
      for (const build of builds) {
        if (!portable.includes(build.file)) throw new Error("Dockerfile missing or not portable");
      }
      for (const build of builds) targets.set(build.file, [...targets.get(build.file) ?? [], build.args]);
    } catch {
      findings.push({ code: "compose-unparsed", severity: "warning", file: "compose.yml", line: 1, message: "Compose build discovery skipped: unsupported, invalid or nonportable definition" });
    }
  }
  for (const file of [...targets.keys()].sort()) {
    const source = await readFile(resolve(directory, ...file.split("/")), "utf8");
    const configurations = targets.get(file)!;
    for (const args of configurations.length ? configurations : [{}]) {
      for (const finding of lintDockerfile(source, file, args)) {
        if (!findings.some((other) => other.file === finding.file && other.line === finding.line && other.code === finding.code && other.message === finding.message)) findings.push(finding);
      }
    }
  }
  return { targets: [...targets.keys()].sort(), findings };
}

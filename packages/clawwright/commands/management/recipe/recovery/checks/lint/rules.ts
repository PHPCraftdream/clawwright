import { ArgResolver, artifactReference, parseArgDeclaration } from "./artifacts.ts";
import { instructions, runTokens, shellTokens } from "./text.ts";

import type { Finding } from "./text.ts";

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64}|\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*\}))$/;
const executable = (word: string): string => word.split("/").at(-1) ?? word;

// A tag sits on the last path segment; earlier segments may carry a registry port.
const TAGGED_IMAGE = /^(?:[^/]+\/)*[^/:@]+:[^/:@]+$/;
const CHECKSUM_ALGORITHM = "sha256:";
const LATEST_TAG = /:latest$/i;

export function lintDockerfile(source: string, file: string, buildArgs: Readonly<Record<string, string | undefined>> = {}): Finding[] {
  const findings: Finding[] = [];
  const physical = source.split(/\r?\n/);
  const globalArgs = new ArgResolver();
  const emit = (code: string, severity: Finding["severity"], line: number, message: string): void => {
    const waiver = /^\s*#\s*recipe-check:\s*allow\s+(\S+)\s+(\S.*)\s*$/.exec(physical[line - 2] ?? "");
    findings.push(waiver?.[1] === code
      ? { code: "waived", severity: "info", file, line, message: `waived ${code}: ${waiver[2]}` }
      : { code, severity, file, line, message });
  };
  for (const instruction of instructions(source)) {
    const { command, text, line } = instruction;
    if (instruction.unparsed) { emit("unparsed-construct", "info", line, "construct skipped (including heredoc bodies)"); continue; }
    try {
      if (command === "ARG") {
        const parsed = parseArgDeclaration(text);
        if (parsed) globalArgs.arg(parsed, line);
      }
      if (command === "FROM") {
        const lexemes = shellTokens(text).filter((token) => !token.startsWith('--'));
        const image = lexemes[0] ?? "";
        const previous = globalArgs.hasStage(image.toLowerCase());
        if (image.toLowerCase() !== "scratch" && !previous && !/@/.test(image) && (!TAGGED_IMAGE.test(image) || LATEST_TAG.test(image))) {
          emit("floating-base-tag", "warning", line, "base image has latest or no tag/digest");
        }
        const alias = lexemes[1]?.toUpperCase() === "AS" ? lexemes[2]?.toLowerCase() : undefined;
        globalArgs.fromStage(image.toLowerCase(), alias);
      }
      if (command === "ADD") {
        const lexemes = shellTokens(text);
        if (!lexemes.some((token) => /^https?:\/\//i.test(token)) && !/https?:\/\//i.test(text)) continue;
        const checksum = lexemes.find((token) => token.startsWith('--checksum='))?.slice(11);
        const prefix = (checksum ?? "").startsWith(CHECKSUM_ALGORITHM) ? CHECKSUM_ALGORITHM : "";
        let valid = /^sha256:[0-9a-f]{64}$/.test(checksum ?? "");
        const ref = artifactReference(prefix ? checksum!.slice(prefix.length) : checksum ?? "");
        if (ref) {
          const name = ref.name;
          const declared = globalArgs.get(name);
          if (declared !== undefined) {
            const visible = [declared.value, buildArgs[name]].filter((entry): entry is string => entry !== undefined);
            const defaults = visible.filter((entry) => !/\$(?:[A-Za-z_]|\{)/.test(entry));
            const isValid = (entry: string): boolean => prefix ? SHA256.test(entry) : /^sha256:[0-9a-f]{64}$/.test(entry);
            if (defaults.length === 0) {
              emit("remote-add-checksum-unverified", "info", line, "declared checksum ARG has no statically visible value");
              continue;
            }
            valid = defaults.every(isValid);
          }
        }
        if (!valid) emit("remote-add-unpinned", "error", line, "HTTP(S) ADD requires sha256 checksum with 64 lowercase hex digits");
      }
      if (command === "RUN") lintRun(runTokens(text), line, emit);
    } catch {
      emit("unparsed-construct", "info", line, "unsupported or malformed text construct skipped");
    }
  }
  return findings;
}

function lintRun(lexemes: string[], line: number, emit: (code: string, severity: Finding["severity"], line: number, message: string) => void): void {
  const commands: { words: string[]; separator: string }[] = [];
  let words: string[] = [];
  for (const token of lexemes) {
    if (["|", "||", "&&", ";", "&"].includes(token)) { commands.push({ words, separator: token }); words = []; }
    else words.push(token);
  }
  commands.push({ words, separator: "" });
  const downloads: { file: string; index: number }[] = [];
  let verified = false;
  for (let i = 0; i < commands.length; i++) {
    const { words, separator } = commands[i];
    const name = executable(words[0] ?? "");
    if ((name === "sha256sum" && words.some((v) => v === "-c" || v === "--check" || v.startsWith('--check=')))
      || (name === "shasum" && words.includes("-a") && words[words.indexOf("-a") + 1] === "256" && words.includes("-c"))) verified = true;
    if (name === "curl" || name === "wget") {
      if (separator === "|" && ["sh", "bash"].includes(executable(commands[i + 1]?.words[0] ?? ""))) emit("curl-pipe-shell", "error", line, "download piped directly to sh/bash");
      const option = words.findIndex((v) => name === "curl" ? /^(?:-[A-Za-z]*o|--output)$/.test(v) : /^(?:-O|--output-document)$/.test(v));
      let file = option >= 0 ? words[option + 1] : words.find((v) => v.match(name === "curl" ? /^--output=/ : /^--output-document=/))?.split("=").slice(1).join("=");
      const redirect = words.indexOf(">");
      if (redirect >= 0) file = words[redirect + 1];
      if (!file && (name === "curl" ? words.includes("-O") : !words.includes("-O"))) file = words.find((v) => /^https?:\/\//.test(v))?.split("/").at(-1);
      if (file && file !== "-") downloads.push({ file, index: i });
    }
  }
  if (!verified && downloads.some(({ file, index }) => commands.slice(index + 1).some(({ words }) => {
    const name = executable(words[0] ?? "");
    return ((["tar", "unzip", "sh", "bash", "python", "python3", "node"].includes(name) && words.slice(1).includes(file)) || words[0] === file || words[0] === `./${file}`);
  }))) emit("download-without-verification", "warning", line, "downloaded file extracted/executed in same RUN without checksum check");
  const remoteGit = commands.some(({ words }) => executable(words[0] ?? "") === "git" && (words.includes("clone") || words.includes("fetch")) && words.some((v) => /^(?:https?:\/\/|ssh:\/\/|git:\/\/|git@)/.test(v)));
  const pinned = commands.some(({ words }) => executable(words[0] ?? "") === "git" && (words.includes("checkout") || words.includes("fetch")) && words.some((v) => COMMIT.test(v)));
  if (remoteGit && !pinned) emit("git-clone-unpinned", "warning", line, "remote git clone/fetch lacks commit checkout or pinned fetch in same RUN");
}

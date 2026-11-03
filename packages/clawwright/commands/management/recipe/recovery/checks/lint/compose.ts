import { posix } from "node:path";

export interface ComposeTarget { readonly file: string; readonly args: Record<string, string | undefined> }

function scalar(raw: string): string | undefined {
  const value = raw.trim();
  if (value === "" || value === "null" || value === "~") return undefined;
  if (value.startsWith('"')) return JSON.parse(value);
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) throw new Error("unterminated scalar");
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (/^[[\]{},&*!>|]/.test(value)) throw new Error("unsupported YAML construct");
  return value.replace(/\s+#.*$/, "").trim();
}

// No framework YAML parser exists; accept the common block subset and report all other forms.
export function composeTargets(source: string): ComposeTarget[] {
  const root: Record<string, unknown> = {};
  const stack: { indent: number; value: Record<string, unknown> }[] = [{ indent: -1, value: root }];
  for (const physical of source.split(/\r?\n/)) {
    if (/^\s*(?:#.*)?$/.test(physical) || physical.trim() === "---") continue;
    if (physical.includes("\t")) throw new Error("tab indentation");
    const indent = physical.length - physical.trimStart().length;
    while (stack.at(-1)!.indent >= indent) stack.pop();
    const parent = stack.at(-1)!.value;
    const list = /^\s*-\s+([A-Za-z_]\w*)(?:=(.*))?\s*$/.exec(physical);
    if (list) { parent[list[1]] = scalar(list[2] ?? ""); continue; }
    const entry = /^\s*([^:#]+):(?:\s+(.*))?$/.exec(physical.replace(/\s+#.*$/, ""));
    if (!entry) throw new Error("unsupported YAML line");
    const key = scalar(entry[1]);
    if (!key || Object.hasOwn(parent, key)) throw new Error("invalid or duplicate key");
    if (entry[2] === undefined || entry[2].trim() === "") {
      const child: Record<string, unknown> = {};
      parent[key] = child;
      stack.push({ indent, value: child });
    } else parent[key] = scalar(entry[2]);
  }
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected mapping");
    return value as Record<string, unknown>;
  };
  const services = object(root.services);
  const targets: ComposeTarget[] = [];
  for (const service of Object.values(services)) {
    const build = object(service).build;
    if (build === undefined) continue;
    const config = typeof build === "string" ? { context: build } : object(build);
    const context = config.context ?? ".";
    const dockerfile = config.dockerfile ?? "Dockerfile";
    if (typeof context !== "string" || typeof dockerfile !== "string") throw new Error("invalid build path");
    const safe = (path: string): boolean => !path.includes("\\") && !path.includes("$") && !posix.isAbsolute(path) && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path);
    if (!safe(context) || !safe(dockerfile)) throw new Error("nonlocal build path");
    const normalizedContext = posix.normalize(context);
    if (normalizedContext === ".." || normalizedContext.startsWith("../")) throw new Error("build context outside recipe");
    const file = posix.normalize(posix.join(context, dockerfile));
    if (file === ".." || file.startsWith("../")) throw new Error("build path outside recipe");
    const args: Record<string, string | undefined> = {};
    if (config.args !== undefined) {
      for (const [key, value] of Object.entries(object(config.args))) {
        if (typeof value !== "string" && value !== undefined) throw new Error("invalid build arg");
        args[key] = value;
      }
    }
    targets.push({ file, args });
  }
  return targets;
}

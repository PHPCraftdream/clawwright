import JSON5 from "json5";

export type ConfigPathPart =
  | { readonly kind: "key"; readonly key: string; readonly arrayIndex: boolean }
  | { readonly kind: "selector"; readonly field: string; readonly value: string };
export type ReadMode = "single" | "set";
const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);
const MAX_INDEX = 100_000;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isObject = (value: unknown): value is Record<string, unknown> | unknown[] => value !== null && typeof value === "object";

export function arrayIndex(key: string): number | undefined {
  if (!/^(0|[1-9]\d*)$/.test(key)) return undefined;
  const result = Number(key);
  return Number.isSafeInteger(result) && result <= MAX_INDEX ? result : undefined;
}
function invalidPath(path: string): never { throw new Error(`invalid configuration path "${path}"`); }
function assertSafe(key: string): void {
  if (UNSAFE.has(key)) throw new Error(`refusing unsafe configuration path segment "${key}"`);
}
function bracketEnd(path: string, open: number): number {
  let quote = "";
  let escaped = false;
  for (let index = open + 1; index < path.length; index += 1) {
    const character = path[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "]") return index;
  }
  return -1;
}

/** Parse dot/bracket config paths, quoted keys, numeric indexes, and keyed array selectors. */
export function configPathParts(path: string): ConfigPathPart[] {
  const raw = path.trim();
  if (!raw) throw new Error("configuration path must not be empty");
  const parts: ConfigPathPart[] = [];
  let text = "";
  let bracketEnded = false;
  const emitText = (): void => {
    if (!text.trim()) invalidPath(path);
    const key = text.trim();
    assertSafe(key);
    parts.push({ kind: "key", key, arrayIndex: arrayIndex(key) !== undefined });
    text = "";
  };
  for (let index = 0; index < raw.length;) {
    const character = raw[index];
    if (character === "\\") {
      if (index + 1 === raw.length) invalidPath(path);
      text += raw[index + 1]; index += 2; continue;
    }
    if (character === ".") {
      if (text) emitText();
      else if (!bracketEnded) invalidPath(path);
      bracketEnded = false; index += 1; continue;
    }
    if (character !== "[") {
      if (bracketEnded) invalidPath(path);
      text += character; index += 1; continue;
    }
    if (text) emitText();
    else if (!bracketEnded && parts.length > 0) invalidPath(path);
    const end = bracketEnd(raw, index);
    if (end < 0) invalidPath(path);
    const inside = raw.slice(index + 1, end).trim();
    if (!inside) invalidPath(path);
    if (inside[0] === '"' || inside[0] === "'") {
      let key: unknown;
      try { key = JSON5.parse(inside); } catch { invalidPath(path); }
      if (typeof key !== "string" || !key) invalidPath(path);
      assertSafe(key as string);
      parts.push({ kind: "key", key: key as string, arrayIndex: false });
    } else {
      const selector = /^([A-Za-z_$][A-Za-z0-9_$-]*)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^\s.\]=["'\\]+))$/.exec(inside);
      if (inside.includes("=")) {
        if (!selector) invalidPath(path);
        const field = selector[1];
        assertSafe(field);
        let value: unknown;
        if (selector[2] !== undefined) {
          try { value = JSON.parse(`"${selector[2]}"`); } catch { invalidPath(path); }
        } else value = selector[3].trim();
        if (typeof value !== "string" || (selector[2] === undefined && value.length === 0)) invalidPath(path);
        parts.push({ kind: "selector", field, value: value as string });
      } else {
        assertSafe(inside);
        parts.push({ kind: "key", key: inside, arrayIndex: arrayIndex(inside) !== undefined });
      }
    }
    index = end + 1;
    bracketEnded = true;
  }
  if (text) emitText();
  else if (!bracketEnded) invalidPath(path);
  return parts;
}
function selectorMatches(item: unknown, field: string, value: string): item is Record<string, unknown> {
  if (!isRecord(item) || !Object.hasOwn(item, field)) return false;
  const fieldValue = item[field];
  return (typeof fieldValue === "string" || typeof fieldValue === "number" || typeof fieldValue === "boolean") && String(fieldValue) === value;
}

/** Reads one value, or returns a set for terminal selector reads. Middle selector ambiguity refuses. */
export function readConfigPath(root: unknown, path: string, mode: ReadMode = "single"): unknown {
  const parts = configPathParts(path);
  let current: unknown[] = [root];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const terminal = index === parts.length - 1;
    const next: unknown[] = [];
    for (const node of current) {
      if (part.kind === "selector") {
        if (!Array.isArray(node)) continue;
        next.push(...node.filter((item) => selectorMatches(item, part.field, part.value)));
      } else if (isObject(node)) {
        if (Array.isArray(node) && arrayIndex(part.key) === undefined) continue;
        if (Object.hasOwn(node, part.key)) next.push((node as Record<string, unknown>)[part.key]);
      }
    }
    if (part.kind === "selector" && !terminal && next.length > 1) throw new Error(`configuration path "${path}" is ambiguous`);
    current = next;
  }
  const last = parts.at(-1);
  if (mode === "set" && last?.kind === "selector") return current;
  if (mode === "set") return current;
  if (current.length > 1) throw new Error(`configuration path "${path}" is ambiguous`);
  return current[0];
}
function own(node: Record<string, unknown> | unknown[], key: string): unknown {
  return Object.hasOwn(node, key) ? (node as Record<string, unknown>)[key] : undefined;
}
function ensureSelectorObject(value: unknown, field: string, expected: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("selector assignment requires an object");
  if (Object.hasOwn(value, field) && String(value[field]) !== expected) throw new Error("selector field conflicts with assignment");
  return { ...value, [field]: expected };
}

/** Applies a declaration by replacing an object selector or appending keyed objects to arrays. */
export function setConfigPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = configPathParts(path);
  let node: Record<string, unknown> | unknown[] = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    const next = parts[index + 1];
    if (part.kind === "selector") {
      if (!Array.isArray(node)) throw new Error("selector requires an array");
      const matches: Record<string, unknown>[] = node.filter((item): item is Record<string, unknown> => selectorMatches(item, part.field, part.value));
      if (matches.length > 1) throw new Error("ambiguous selector");
      let target: Record<string, unknown> | undefined = matches[0];
      if (!target) { target = { [part.field]: part.value }; node.push(target); }
      node = target; continue;
    }
    if (Array.isArray(node) && arrayIndex(part.key) === undefined) throw new Error("configuration path expects numeric array index");
    let child = own(node, part.key);
    if (!isObject(child)) {
      child = next.kind === "selector" || (next.kind === "key" && next.arrayIndex) ? [] : {};
      (node as Record<string, unknown>)[part.key] = child;
    }
    node = child as Record<string, unknown> | unknown[];
  }
  const last = parts[parts.length - 1];
  if (last.kind === "key") {
    if (Array.isArray(node) && arrayIndex(last.key) === undefined) throw new Error("configuration path expects numeric array index");
    (node as Record<string, unknown>)[last.key] = value; return;
  }
  if (!Array.isArray(node)) throw new Error("selector requires an array");
  const objects = node.filter((item) => isRecord(item));
  const matches = objects.filter((item) => selectorMatches(item, last.field, last.value));
  const replacements = Array.isArray(value) ? value.map((item) => ensureSelectorObject(item, last.field, last.value)) : [ensureSelectorObject(value, last.field, last.value)];
  if (matches.length > 1 && !Array.isArray(value)) throw new Error("ambiguous selector");
  if (Array.isArray(value)) {
    for (let i = node.length - 1; i >= 0; i -= 1) if (selectorMatches(node[i], last.field, last.value)) node.splice(i, 1);
    node.push(...replacements);
  } else if (matches.length === 1) {
    node[node.indexOf(matches[0])] = replacements[0];
  } else node.push(replacements[0]);
}

/** Prunes a key or selector; numeric indexes are deliberately unsupported. */
export function pruneConfigPath(root: unknown, path: string, previousValue?: unknown): void {
  const parts = configPathParts(path);
  if (parts.some((part) => part.kind === "key" && part.arrayIndex)) throw new Error("numeric-index prune refused; use a keyed selector or remove manually");
  const last = parts.pop()!;
  let nodes: unknown[] = [root];
  for (const part of parts) {
    const next: unknown[] = [];
    for (const node of nodes) {
      if (part.kind === "selector") { if (Array.isArray(node)) next.push(...node.filter((item) => selectorMatches(item, part.field, part.value))); }
      else if (isRecord(node) && Object.hasOwn(node, part.key)) next.push(node[part.key]);
    }
    nodes = next;
    if (nodes.length > 1) throw new Error("ambiguous prune path");
    if (nodes.length === 0) return;
  }
  for (const node of nodes) {
    if (last.kind === "key") { if (isObject(node)) delete (node as Record<string, unknown>)[last.key]; continue; }
    if (!Array.isArray(node)) continue;
    const hits = node.filter((item) => selectorMatches(item, last.field, last.value));
    if (hits.length > 1 && !Array.isArray(previousValue) && hits.some(isRecord)) throw new Error("ambiguous object selector prune");
    for (let i = node.length - 1; i >= 0; i -= 1) if (selectorMatches(node[i], last.field, last.value)) node.splice(i, 1);
  }
}
function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => jsonEqual(item, right[index]));
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const keys = Object.keys(left); const rightKeys = Object.keys(right);
    return keys.length === rightKeys.length && keys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]));
  }
  return false;
}
/** JSON merge-patch diff. Undefined means no-op; stored null is refused because it means deletion. */
export function mergePatchDiff(before: unknown, after: unknown): unknown {
  if (jsonEqual(before, after)) return undefined;
  if (after === null) throw new Error("merge-patch cannot represent storing null");
  if (isRecord(before) && isRecord(after)) {
    const patch: Record<string, unknown> = {};
    for (const key of Object.keys(before)) if (!Object.hasOwn(after, key)) patch[key] = null;
    for (const [key, value] of Object.entries(after)) {
      const child = mergePatchDiff(before[key], value);
      if (child !== undefined) patch[key] = child;
    }
    return Object.keys(patch).length ? patch : undefined;
  }
  if (isRecord(after)) {
    for (const value of Object.values(after)) if (value === null || (isRecord(value) && mergePatchDiff({}, value) !== undefined)) {
      // Recursion validates representability throughout newly introduced subtrees.
      mergePatchDiff(undefined, value);
    }
    return after;
  }
  return after;
}
export function validateConfigDeclaration(path: string, value: unknown): void {
  const parts = configPathParts(path);
  const terminal = parts.at(-1);
  if (terminal?.kind === "selector") {
    if (Array.isArray(value)) { for (const item of value) ensureSelectorObject(item, terminal.field, terminal.value); }
    else ensureSelectorObject(value, terminal.field, terminal.value);
  }
}
/** True when a parsed path is an exact prefix of another (selector identity included). */
export function configPathPrefix(a: readonly ConfigPathPart[], b: readonly ConfigPathPart[]): boolean {
  return a.length <= b.length && a.every((part, index) => {
    const other = b[index];
    return other !== undefined && part.kind === other.kind && (part.kind === "key"
      ? other.kind === "key" && part.key === other.key
      : other.kind === "selector" && part.field === other.field && part.value === other.value);
  });
}

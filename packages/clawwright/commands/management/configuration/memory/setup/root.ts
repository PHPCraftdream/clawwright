import type { FileIdentity } from "./model.ts";

export interface RootRequest {
  readonly operation: "inspect" | "create";
  readonly configRoot: string;
  readonly expected?: FileIdentity;
  readonly expectedModels?: FileIdentity;
}
export interface RootFacts {
  readonly ok: boolean;
  readonly code: string;
  readonly changed: boolean;
  readonly created: boolean;
  readonly exists?: boolean;
  readonly config?: FileIdentity;
  readonly models?: FileIdentity;
}
export function modelRootOperation(input: RootRequest, load: NodeRequire): RootFacts {
  const fs: typeof import("node:fs") = load("node:fs");
  const path: typeof import("node:path") = load("node:path");
  let attempted = false, created = false;
  const fail = (code: string): never => { throw new Error(code); };
  const id = (s: import("node:fs").BigIntStats): FileIdentity => ({ dev: String(s.dev), ino: String(s.ino) });
  const same = (s: import("node:fs").BigIntStats, expected: FileIdentity) => String(s.dev) === expected.dev && String(s.ino) === expected.ino;
  try {
    const root = input.configRoot;
    if (process.platform !== "linux" || process.getuid?.() !== 1000 ||
        !["inspect", "create"].includes(input.operation) || typeof root !== "string" ||
        !path.isAbsolute(root) || path.normalize(root) !== root || root === "/") fail("ROOT_INPUT");
    const models = path.join(root, "models");
    const decode = (value: string) => value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));
    const mounts = fs.readFileSync("/proc/self/mountinfo", "utf8").trim().split("\n").map((line) => decode(line.split(" ")[4]));
    const owner = (file: string) => mounts.filter((m) => file === m || file.startsWith(m + path.sep)).sort((a, b) => b.length - a.length)[0];
    function boundary(): import("node:fs").BigIntStats {
      let current = path.parse(root).root;
      for (const part of root.slice(current.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        const s = fs.lstatSync(current, { bigint: true });
        if (!s.isDirectory() || s.isSymbolicLink()) fail("ROOT_BOUNDARY");
      }
      const s = fs.lstatSync(root, { bigint: true });
      if (fs.realpathSync(root) !== root || s.uid !== 1000n || (s.mode & 0o022n) !== 0n ||
          owner(root) !== root || owner(models) !== root || process.env.OPENCLAW_STATE_DIR !== root ||
          process.env.OPENCLAW_CONFIG_DIR !== root || process.env.OPENCLAW_CONFIG_PATH !== path.join(root, "openclaw.json") ||
          (input.expected && !same(s, input.expected))) fail("ROOT_BOUNDARY");
      return s;
    }
    const parent = boundary();
    let exists = false;
    try { fs.lstatSync(models); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!exists && input.expectedModels) fail("ROOT_IDENTITY");
    if (!exists && input.operation === "inspect") return { ok: true, code: "ROOT_MISSING", changed: false, created: false, exists: false, config: id(parent) };
    if (!exists) {
      if (!input.expected) fail("ROOT_IDENTITY");
      attempted = true;
      try { fs.mkdirSync(models, { mode: 0o700 }); created = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    const s = fs.lstatSync(models, { bigint: true });
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== 1000n || (s.mode & 0o077n) !== 0n ||
        fs.realpathSync(models) !== models || (input.expectedModels && !same(s, input.expectedModels)) || !same(boundary(), id(parent))) fail("ROOT_IDENTITY");
    return { ok: true, code: created ? "ROOT_CREATED" : "ROOT_PRESENT", changed: attempted, created, exists: true, config: id(parent), models: id(s) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return { ok: false, code: /^ROOT_[A-Z_]+$/.test(message) ? message : "ROOT_IO", changed: attempted, created };
  }
}
export const MODEL_ROOT_SCRIPT = `"use strict";const run=(${modelRootOperation.toString()});try{const facts=run(JSON.parse(process.argv[1]),require);process.stdout.write(JSON.stringify(facts)+"\\n");process.exitCode=facts.ok?0:1}catch{process.stdout.write('{"ok":false,"code":"ROOT_INPUT","changed":false,"created":false}\\n');process.exitCode=1}`;

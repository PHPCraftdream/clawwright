// Where the deployment is when `clawwright` runs in one of its subfolders, and the startup diagnostic for a checkout whose dist is older than its sources (the entry directory is at its entry cap, so both live here).

import { lstatSync, opendirSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { frameworkPackage } from "../core/env.ts";
import { classifyCopy } from "../integration/version.ts";
import type { HostPlatform, Frame, Launch } from "../core/io/invocation/frame.ts";
import { defaultLaunch, modeOf, pasteShells, spell } from "../core/io/invocation/frame.ts";
import type { Invocation } from "../core/io/invocation/index.ts";

export async function defaultInvocation(appRoot: string, platform: string = process.platform, checkout: string | undefined = undefined): Promise<Pick<Invocation, "program" | "mode">> {
  const launch = await decideLaunch(appRoot, { host: platform === "win32" ? "win32" : "posix", checkout });
  const host = platform === "win32" ? "win32" : "posix";
  return {
    // The entry default's own spelling: the npm wrapper under cmd on Windows, POSIX elsewhere.
    program: (host === "win32" ? spell(launch, "cmd", host, appRoot) : undefined) ?? spell(launch, "posix", host, appRoot)!,
    mode: modeOf(launch),
  };
}

/** True when the app's own node_modules reaches the running package: npm's file:... install
 *  spells node_modules/@phpcraftdream/clawwright as a symlink/junction to the framework checkout,
 *  and the deployment then runs its own local package — the launch must not name the checkout
 *  the link resolves to. The probe is package identity, not link detection: an ordinary
 *  (non-linked) install whose package directory IS this directory matches too, and its
 *  launch is the same local-package answer classifyCopy would give it. */
function linkedThroughApp(pkgDir: string, appRoot: string): boolean {
  try {
    const link = realpathSync.native(resolve(appRoot, "node_modules", "@phpcraftdream", "clawwright"));
    const real = realpathSync.native(pkgDir);
    return process.platform === "win32" ? link.toLowerCase() === real.toLowerCase() : link === real;
  } catch {
    return false;
  }
}

// The launch decision shared by the default Invocation and the default frame: which copy runs.
async function decideLaunch(appRoot: string, facts: { host: HostPlatform; checkout?: string }): Promise<Launch> {
  const pkg = await frameworkPackage();
  if (pkg !== undefined && linkedThroughApp(pkg.dir, appRoot)) return defaultLaunch({ source: "local-package", appRoot, host: facts.host });
  const copy = pkg === undefined ? undefined : classifyCopy(pkg.dir, appRoot);
  return pkg === undefined || copy === undefined || copy.source === "global"
    ? defaultLaunch({ source: "global" })
    : copy.source === "checkout"
      ? defaultLaunch({ source: "checkout-copy", root: facts.checkout ?? copy.path })
      : defaultLaunch({ source: "local-package", appRoot, host: facts.host });
}

export async function defaultFrame(appRoot: string, facts: { host: HostPlatform; msys: boolean; cwd: string; checkout?: string }): Promise<Frame> {
  const launch = await decideLaunch(appRoot, { host: facts.host, checkout: facts.checkout });
  const hostFact = { kind: "operator" as const, platform: facts.host };
  return { launch, host: hostFact, shells: pasteShells(launch, hostFact, facts.msys), cwd: { kind: "dir", path: facts.cwd }, places: { ...(facts.checkout === undefined ? {} : { checkoutRoot: facts.checkout }), deploymentRoot: appRoot }, app: { state: "none" }, audience: "terminal" };
}

/** Best-effort checkout diagnostic, never a build or a startup requirement. */
export function warnIfDistStale(
  packageRoot: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  warn: (line: string) => void = (line) => { process.stderr.write(line); },
): void {
  // OC_NO_STALE_DIST_WARNING=1 silences this diagnostic.
  if (env.OC_NO_STALE_DIST_WARNING === "1") return;
  try {
    const dist = resolve(packageRoot, "dist");
    const sourceEntry = lstatSync(resolve(packageRoot, "entry", "bin.ts"));
    const builtEntry = lstatSync(resolve(dist, "entry", "bin.js"));
    if (!sourceEntry.isFile() || !builtEntry.isFile()) return;
    // MCP stdio mode does not skip this warning: stderr is not protocol stdout and keeps JSON stdout clean.
    const report = () => { warn("clawwright: warning: checkout package sources are newer than dist; run npm run build from the checkout root.\n"); };
    if (sourceEntry.mtimeMs > builtEntry.mtimeMs) {
      report();
      return;
    }

    // Compare existing outputs individually. A newly added source without output is
    // stale only when newer than the built entry. Skip links and generated trees;
    // entry/depth bounds limit work, but later gaps cannot undo definite evidence.
    let remaining = 4096;
    const scan = (dir: string, rel: string, depth: number): boolean => {
      if (depth > 16) return false;
      const entries = opendirSync(dir);
      try {
        for (let entry = entries.readSync(); entry !== null; entry = entries.readSync()) {
          if (--remaining < 0) return false;
          if (entry.name === "dist" || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
          const child = resolve(dir, entry.name);
          const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
          if (entry.isDirectory()) {
            if (scan(child, childRel, depth + 1)) return true;
          } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
            const source = lstatSync(child);
            if (!source.isFile()) continue;
            let outputMtime = builtEntry.mtimeMs;
            try {
              const output = lstatSync(resolve(dist, childRel.replace(/\.ts$/, ".js")));
              if (!output.isFile()) continue;
              outputMtime = output.mtimeMs;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
            if (source.mtimeMs > outputMtime) {
              // Warn immediately; no later missing output or traversal limit can suppress it.
              report();
              return true;
            }
          }
        }
        return false;
      } finally {
        entries.closeSync();
      }
    };
    scan(packageRoot, "", 0);
  } catch {
    // Missing installed-package sources, filesystem races and diagnostic failures stay silent.
  }
}

/** Locate only this copy, independent of cwd; installed packages have no sibling sources. */
export function warnForEntry(entryUrl: string): void {
  try {
    const entryDir = dirname(fileURLToPath(entryUrl));
    const parent = dirname(entryDir);
    if (basename(parent) !== "dist" || basename(entryDir) !== "entry" || basename(fileURLToPath(entryUrl)) !== "bin.js") return;
    warnIfDistStale(dirname(parent));
  } catch {
    // A diagnostic must not prevent startup.
  }
}

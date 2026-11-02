// The system-wide command's small pieces, without installing anything: the upward search for
// app.ts, the one-shot delegation flag, the version source classification and the installer's
// PATH-shadow detection. The installed end-to-end runs are in system-install.check.ts.

import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, accessSync, statSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { findAppRootIn, type FsProbe } from "#framework/entry/resolve.ts";
import { takeDelegationFlag } from "#framework/entry/delegate.ts";
import { classifyCopy } from "#framework/integration/version.ts";
import { resolveOnPath, shadowMessage } from "#tools/dev/resolve-on-path.ts";
import { check, finish } from "#checks/kit/harness.ts";

// Canonical, as classifyCopy reports it (macOS /var → /private/var, Windows 8.3 names).
const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "clawwright-system-units-")));
try {
  const fs: FsProbe = {
    exists: (path) => { try { accessSync(path); return true; } catch { return false; } },
    isDirectory: (path) => { try { return statSync(path).isDirectory(); } catch { return false; } },
    readdir: (path) => { try { return readdirSync(path); } catch { return []; } },
    readFile: (path) => { try { return readFileSync(path, "utf8"); } catch { return undefined; } },
    realpath: (path) => { try { return realpathSync(path); } catch { return path; } },
  };

  // --- upward search ------------------------------------------------------------------------
  const app = join(scratch, "app");
  const deep = join(app, "recipes", "one");
  mkdirSync(deep, { recursive: true });
  check("no app.ts anywhere above: nothing found", findAppRootIn(deep, fs), undefined);
  writeFileSync(join(app, "app.ts"), "");
  check("an ancestor's bare app.ts (some other project's) is not a deployment", findAppRootIn(deep, fs), undefined);
  mkdirSync(join(app, "config"));
  writeFileSync(join(app, "config", "desired-state.json"), "[]");
  check("a subfolder finds the nearest ancestor deployment", findAppRootIn(deep, fs), app);
  check("the app folder itself is its own root", findAppRootIn(app, fs), app);
  writeFileSync(join(app, "recipes", "app.ts"), "");
  check("a bare app.ts in between is skipped", findAppRootIn(deep, fs), app);
  mkdirSync(join(app, "recipes", "config"));
  writeFileSync(join(app, "recipes", "config", "desired-state.json"), "[]");
  check("the nearest deployment wins", findAppRootIn(deep, fs), join(app, "recipes"));
  check("the start itself counts with app.ts alone", findAppRootIn(join(app, "recipes"), fs), join(app, "recipes"));

  // --- the delegation flag covers one hand-over only --------------------------------------------
  process.env.CLAWWRIGHT_DELEGATED = "1";
  check("the receiver reads the flag", takeDelegationFlag(), true);
  check("and clears it, so its descendants never inherit it", process.env.CLAWWRIGHT_DELEGATED, undefined);
  check("without the flag nothing is handed over", takeDelegationFlag(), false);

  // --- which copy runs ------------------------------------------------------------------------
  const checkout = join(scratch, "checkout");
  mkdirSync(join(checkout, "packages", "clawwright"), { recursive: true });
  mkdirSync(join(checkout, "tools"), { recursive: true });
  writeFileSync(join(checkout, "tools", "clawwright.ts"), "");
  check("a checkout package folder is not mistaken for its parent tools folder", classifyCopy(join(checkout, "packages", "clawwright")), { source: "checkout", path: checkout });
  const relocatedCheckout = join(scratch, "relocated", "packages", "clawwright");
  mkdirSync(join(scratch, "relocated", "tools"), { recursive: true });
  mkdirSync(relocatedCheckout, { recursive: true });
  writeFileSync(join(scratch, "relocated", "tools", "clawwright.ts"), "");
  check("a relocated checkout package resolves tools/clawwright.ts from the repository root", classifyCopy(relocatedCheckout), { source: "checkout", path: join(scratch, "relocated") });
  const local = join(app, "node_modules", "@phpcraftdream", "clawwright");
  mkdirSync(local, { recursive: true });
  check("a package inside the app is local", classifyCopy(local, app).source, "local");
  check("the same package seen from another app is global", classifyCopy(local, join(scratch, "other")).source, "global");
  check("without an app root it is global", classifyCopy(local).source, "global");

  // --- the installer's PATH resolution ------------------------------------------------------
  const first = join(scratch, "first");
  const second = join(scratch, "second");
  mkdirSync(first);
  mkdirSync(second);
  writeFileSync(join(first, "clawwright.cmd"), "");
  writeFileSync(join(second, "clawwright"), "");
  chmodSync(join(second, "clawwright"), 0o755);
  const path = `${first}${delimiter}${second}`;
  check("Windows: PATHEXT extensions are tried", resolveOnPath("clawwright", { Path: path, PATHEXT: ".exe;.cmd" }, true), join(first, "clawwright.cmd"));
  check("POSIX: the bare name is found in the first directory holding it", resolveOnPath("clawwright", { PATH: path }, false), join(second, "clawwright"));
  check("a missing command resolves to nothing", resolveOnPath("clawwright-nope", { PATH: path }, false), undefined);
  const shim = join(scratch, "prefix", "clawwright");
  check("the installed shim itself is not a shadow", shadowMessage(shim, shim, false), undefined);
  check("no clawwright on PATH is not a shadow", shadowMessage(shim, undefined, false), undefined);
  const shadow = shadowMessage(shim, join(second, "clawwright"), false) ?? "";
  check("another clawwright on PATH is reported with both paths", shadow.includes(join(second, "clawwright")) && shadow.includes(shim), true);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

finish("system command units");

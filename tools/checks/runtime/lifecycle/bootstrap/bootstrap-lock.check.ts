// `./clawwright bootstrap` must hold the instance lock across its ENTIRE mutating sequence,
// not rely on the sub-commands it calls (applyConfig, configureProvider) to each take their
// own separately.
//
// Before the fix, ensureDataDirs/ensureSecretsFile ran with no lock check of their own at
// all — bootstrap only ever found out another operation was contending for the instance
// once applyConfig's own internal guardedWith() call finally refused, by which point
// ensureSecretsFile had already written config/.env. This proves the refusal now happens
// before anything is written at all: with another operation already holding the lock,
// bootstrap must refuse immediately, and nothing downstream of that refusal — not
// ensureDataDirs, not ensureSecretsFile, not the image pull, not a single write — may run.

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DATA_DIR_MARKER, ensureDataDirs } from "#framework/runtime/files/datadir.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { asDirectTest } from "#checks/runtime/service/restore/file-test-stub.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";

const DATA_DIR = "/srv/openclaw/data";

const deployment = await mkdtemp(join(tmpdir(), "clawwright-bootstrap-lock-check-"));
try {
  await mkdir(resolve(deployment, "config"), { recursive: true });
  await writeFile(resolve(deployment, "config", "desired-state.json"), "[]");
  useDeployment(deployment);

  const holder = JSON.stringify({
    operationId: "op-holder",
    what: "apply",
    by: "someone@host pid 1",
    takenAt: new Date().toISOString(),
  });
  const writes: string[] = [];
  const runtimeCalls: string[] = [];
  const execCalls: string[][] = [];
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const lockHome = "/srv/openclaw/data-locks";

  const ctx = {
    settings: {
      dataDir: DATA_DIR,
      env: { OPENCLAW_GATEWAY_TOKEN: "test-token" },
      image: "ghcr.io/openclaw/openclaw:extended-stable",
      gatewayPort: "18789",
      serviceUrl: "http://127.0.0.1:18789",
    },
    transport: {
      description: "stub",
      async exists(path: string): Promise<boolean> {
        if (path === `${DATA_DIR}/clawwright-declared.json`) return false;
        // The secrets file must look ABSENT, or ensureSecretsFile's own "already there,
        // nothing to do" early return means it never even attempts the write this test
        // exists to catch — everything else can report present, since creating data
        // directories that already exist is not what this test is about.
        return !path.endsWith("config/.env");
      },
      async readFile(path: string): Promise<string> {
        if (path.endsWith("/operation.lock/holder.json")) return holder;
        const content = files.get(path);
        if (content === undefined) throw new Error(`no such file: ${path}`);
        return content;
      },
      async writeFile(path: string, content: string): Promise<void> {
        if (path.endsWith("/config/.env")) writes.push(path);
        files.set(path, content);
      },
      async remove(path: string): Promise<void> {
        files.delete(path);
      },
      async listFiles(path: string): Promise<string[]> {
        const prefix = `${path}/`;
        return [...files.keys()].filter((entry) => entry.startsWith(prefix)).map((entry) => entry.slice(prefix.length));
      },
      async mkdirp(): Promise<void> {},
      async exec(rawCommand: string, rawArgs: string[], options: { allowFailure?: boolean } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
        const { command, args } = asDirectTest(rawCommand, rawArgs);
        execCalls.push([command, ...args]);
        if (command === "ln") {
          const [source, destination] = args;
          if (source === undefined || destination === undefined || !files.has(source)) return { code: 1, stdout: "", stderr: "No such file" };
          if (files.has(destination)) return { code: 1, stdout: "", stderr: "File exists" };
          files.set(destination, files.get(source)!);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "rmdir") {
          dirs.delete(args[args.length - 1] ?? "");
          return { code: 0, stdout: "", stderr: "" };
        }
        // The mutation guard is available; only the operation lock is held by the fixture.
        if (command === "mkdir" && args[0] === `${lockHome}/operation.mutation`) {
          const target = args[0];
          if (dirs.has(target)) return { code: 1, stdout: "", stderr: "File exists" };
          dirs.add(target);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "mkdir" && args[0] === `${lockHome}/operation.lock`) return { code: 1, stdout: "", stderr: "" };
        if (command === "test" && args[0] === "-d") {
          return { code: args[1] === `${lockHome}/operation.lock` ? 0 : 1, stdout: "", stderr: "" };
        }
        const code = 0;
        if (code !== 0 && options.allowFailure !== true) throw new Error(`${command} failed`);
        return { code, stdout: "", stderr: "" };
      },
    },
    paths: { toContainer: (path: string) => path },
    runtime: {
      async pullImage(): Promise<void> {
        runtimeCalls.push("pullImage");
      },
      async runOneOff(): Promise<{ code: number; stdout: string; stderr: string }> {
        runtimeCalls.push("runOneOff");
        return { code: 0, stdout: "", stderr: "" };
      },
      async start(): Promise<void> {
        runtimeCalls.push("start");
      },
      async waitForHealth(): Promise<void> {
        runtimeCalls.push("waitForHealth");
      },
      async imageReference(): Promise<string | undefined> {
        return undefined;
      },
    },
  } as unknown as Context;

  let refused = "";
  try {
    await withOutputSink(() => {}, () => openclawCommands.bootstrap.run(ctx, ["--no-pull"]));
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
  }

  check(
    "bootstrap refuses when another operation already holds the instance lock",
    refused.includes("another operation is changing this instance"),
    true,
  );
  check("nothing is ever written — not even config/.env (ensureSecretsFile)", writes.length, 0);
  check("the runtime is never touched — no pull, no config apply, no start", runtimeCalls.length, 0);

  {
    // A truly fresh host: the lock's own home directory does not exist yet, and its parent
    // is root:root — writable only via passwordless sudo. Before the fix, guardedWith()'s own
    // unprivileged claim ran BEFORE ensureDataDirs (and the ensureLockHome escalation inside
    // it) ever got a chance to run, so the first bootstrap ever attempted on such a host
    // died inside claimDirectory() itself, telling the reader to run the very command that
    // was failing. This proves the escalation now happens, and happens BEFORE the lock is
    // claimed.
    const home = "/srv/openclaw/data-locks";
    const lockPath = `${home}/operation.lock`;
    let lockHomeCreated = false;
    let lockHomeWritable = false;
    let mutationGuardHeld = false;
    const freshExecCalls: string[][] = [];

    const freshCtx = {
      settings: {
        dataDir: DATA_DIR,
        env: { OPENCLAW_GATEWAY_TOKEN: "test-token" },
        image: "ghcr.io/openclaw/openclaw:extended-stable",
        bindAddress: "127.0.0.1",
        gatewayPort: "18789",
        serviceUrl: "http://127.0.0.1:18789",
      },
      transport: {
        description: "stub",
        async exists(path: string): Promise<boolean> {
          if (path === `${DATA_DIR}/clawwright-declared.json`) return false;
          if (path === home) return lockHomeCreated;
          // A fresh host: the data directory and its standard layout do not exist yet —
          // ensureDataDirs creates (and then narrowly owns) them in this run. The secrets
          // file stays absent so ensureSecretsFile attempts its write; the config file
          // itself stays present so bootstrap's later config reads see a live instance.
          if (path === DATA_DIR || path.startsWith(`${DATA_DIR}/`)) return path.endsWith("openclaw.json");
          if (path.endsWith("config/.env")) return false;
          return true;
        },
        async readFile(path: string): Promise<string> {
          if (path === `${DATA_DIR}/clawwright-declared.json`) {
            const error = new Error(`ENOENT: no such file: ${path}`) as NodeJS.ErrnoException;
            error.code = "ENOENT";
            throw error;
          }
          if (path.endsWith("holder.json")) throw new Error("no holder recorded");
          // A live config that parses: bootstrap runs to its summary here, and the summary
          // is what the token assertions below are about.
          if (path.endsWith("openclaw.json")) return "{}";
          return "";
        },
        async writeFile(): Promise<void> {},
        async remove(): Promise<void> {},
        async mkdirp(): Promise<void> {},
        async exec(rawCommand: string, rawArgs: string[], options: { allowFailure?: boolean } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
          const { command, args } = asDirectTest(rawCommand, rawArgs);
          freshExecCalls.push([command, ...args]);

          if (command === "mkdir" && args[0] === "-p" && args[1] === home) {
            return { code: lockHomeCreated ? 0 : 1, stdout: "", stderr: "" };
          }
          if (command === "mkdir" && args[0] === `${home}/operation.mutation`) {
            if (mutationGuardHeld) return { code: 1, stdout: "", stderr: "File exists" };
            mutationGuardHeld = true;
            return { code: 0, stdout: "", stderr: "" };
          }
          if (command === "mkdir" && args[0] === lockPath) {
            // The lock claim itself: succeeds once the home exists and is owned.
            return { code: lockHomeCreated && lockHomeWritable ? 0 : 1, stdout: "", stderr: "" };
          }
          if (command === "test" && args[0] === "-d") {
            return { code: args[1] === `${home}/operation.mutation` && mutationGuardHeld ? 0 : 1, stdout: "", stderr: "" };
          }
          if (command === "rmdir" && args[0] === `${home}/operation.mutation`) {
            mutationGuardHeld = false;
            return { code: 0, stdout: "", stderr: "" };
          }
          if (command === "test" && args[0] === "-L") {
            // A fresh host's data directory is a real directory, never a link — ensureDataDirs'
            // own symlink-root guard must see that and continue, not fall through to the
            // generic "everything else succeeds" default below (which would misread this as
            // "yes, it is a symlink").
            return { code: 1, stdout: "", stderr: "" };
          }
          if (command === "readlink" && args[0] === "-f") {
            // The canonical-ancestry check resolves through the ancestors; a fresh
            // host has no links, so every path resolves to itself.
            return { code: 0, stdout: `${args[1] ?? ""}\n`, stderr: "" };
          }
          if (command === "stat" && args[0] === "-c" && args[1] === "%u:%g") {
            // The operator here runs as uid 1000 (see the id handler below), so the
            // directories this run creates are already owned by the fixed identity.
            return { code: 0, stdout: "1000:1000\n", stderr: "" };
          }
          if (command === "stat" && args[0] === "-c" && args[1] === "%a") {
            return { code: 0, stdout: "700\n", stderr: "" };
          }
          if (command === "test" && args[0] === "-w") {
            const target = args[1];
            return { code: target === home && lockHomeWritable ? 0 : 1, stdout: "", stderr: "" };
          }
          if (command === "sh" && args.join(" ").includes("command -v sudo")) {
            return { code: 0, stdout: "/usr/bin/sudo\n", stderr: "" };
          }
          if (command === "sudo" && args[0] === "-n") {
            if (args[1] === "true") return { code: 0, stdout: "", stderr: "" };
            if (args.includes("mkdir")) {
              lockHomeCreated = true;
              return { code: 0, stdout: "", stderr: "" };
            }
            if (args.includes("chown")) {
              lockHomeWritable = true;
              return { code: 0, stdout: "", stderr: "" };
            }
            return { code: 0, stdout: "", stderr: "" };
          }
          if (command === "id") return { code: 0, stdout: "1000\n", stderr: "" };
          const code = 0;
          if (code !== 0 && options.allowFailure !== true) throw new Error(`${command} failed`);
          return { code, stdout: "", stderr: "" };
        },
      },
      paths: { toContainer: (path: string) => path },
      runtime: {
        async portConflict(): Promise<string | undefined> { return undefined; },
        // preflightPort also probes raw listening sockets unless the
        // deployment's own gateway is already running. A fresh host is not, so this must
        // answer false rather than be missing — undefined-as-a-function threw here before
        // ss/netstat were even asked, well short of the summary this test checks for.
        async isRunning(): Promise<boolean> { return false; },
        async pullImage(): Promise<void> {},
        async runOneOff(): Promise<{ code: number; stdout: string; stderr: string }> {
          return { code: 0, stdout: "", stderr: "" };
        },
        async start(): Promise<void> {},
        async waitForHealth(): Promise<void> {},
        async imageReference(): Promise<string | undefined> {
          return undefined;
        },
      },
    } as unknown as Context;

    let freshError = "";
    let said = "";
    try {
      await withOutputSink(
        (chunk: string) => {
          said += chunk;
        },
        () => openclawCommands.bootstrap.run(freshCtx, ["--no-pull"]),
      );
    } catch (error) {
      freshError = error instanceof Error ? error.message : String(error);
    }

    // The summary bootstrap prints is not always read by a person at a terminal: control-mcp
    // runs this very command for an agent and returns everything it wrote, so a token printed
    // here is a token in a transcript that outlives the run.
    check("the gateway token is never printed by a successful bootstrap", said.includes("test-token"), false);
    check("and the reader is told how to get it when they want it", said.includes("mcp-creds --token"), true);

    check(
      "a fresh host does not die inside the lock claim telling the reader to run bootstrap",
      freshError.includes("./clawwright bootstrap prepares it"),
      false,
    );
    const homeMkdirIndex = freshExecCalls.findIndex((call) => call[0] === "sudo" && call.includes("mkdir") && call.includes(home));
    const homeChownIndex = freshExecCalls.findIndex((call) => call[0] === "sudo" && call.includes("chown") && call.includes(home));
    const lockClaimIndex = freshExecCalls.findIndex((call) => call[0] === "mkdir" && call[1] === lockPath);
    check("the lock home is created via sudo before the lock is claimed", homeMkdirIndex !== -1 && lockClaimIndex !== -1 && homeMkdirIndex < lockClaimIndex, true);
    check("and made writable via sudo before the lock is claimed", homeChownIndex !== -1 && lockClaimIndex !== -1 && homeChownIndex < lockClaimIndex, true);
  }
} finally {
  await rm(deployment, { recursive: true, force: true });
}

// ensureDataDirs' own guard against a symlinked data root: `chown -R` dereferences a symlink
// named directly on its command line before recursing, so a data directory that is actually
// a link would hand the recursive chown to whatever it points at instead of this
// deployment's own tree. No real chown happens on
// either path below — the stub transport records every exec call, and the check is that
// "chown" never appears among them once the symlink is reported.
{
  const symlinkDataDir = "/srv/openclaw/data";
  const execCalls: string[][] = [];

  const symlinkCtx = {
    settings: { dataDir: symlinkDataDir },
    transport: {
      description: "stub",
      async exists(): Promise<boolean> {
        return false;
      },
      async exec(command: string, args: string[], options: { allowFailure?: boolean } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
        execCalls.push([command, ...args]);
        if (command === "test" && args[0] === "-L" && args[1] === symlinkDataDir) {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "readlink" && args[0] === "-f" && args[1] === symlinkDataDir) {
          return { code: 0, stdout: "/somewhere-else\n", stderr: "" };
        }
        const code = 0;
        if (code !== 0 && options.allowFailure !== true) throw new Error(`${command} failed`);
        return { code, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;

  let refused = "";
  try {
    await ensureDataDirs(symlinkCtx);
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
  }

  check(
    "ensureDataDirs refuses a symlinked data root",
    refused.includes(symlinkDataDir) && refused.includes("/somewhere-else"),
    true,
  );
  check(
    "and never reaches chown — the symlink check runs first",
    execCalls.some((call) => call[0] === "chown"),
    false,
  );
  check(
    "nor mkdir — nothing under the link is touched either",
    execCalls.some((call) => call[0] === "mkdir"),
    false,
  );
}

// The root-symlink guard above sees only the FINAL component. A symlink one level
// up redirects an externally-deep-looking path into a different tree entirely; the
// canonical-ancestry check must catch it before any mkdir/chown runs. The stub reports the
// data directory itself as not-a-link (and absent), but its deepest existing ancestor
// resolves elsewhere.
{
  const dataDir = "/srv/openclaw/data";
  const redirected = "/mnt/elsewhere";
  const execCalls: string[][] = [];

  const ancestorLinkCtx = {
    settings: { dataDir },
    transport: {
      description: "stub",
      async exists(path: string): Promise<boolean> {
        return path === "/srv" || path === "/srv/openclaw";
      },
      async exec(command: string, args: string[], options: { allowFailure?: boolean } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
        execCalls.push([command, ...args]);
        if (command === "test" && args[0] === "-L") return { code: 1, stdout: "", stderr: "" };
        if (command === "readlink" && args[0] === "-f" && args[1] === "/srv/openclaw") {
          return { code: 0, stdout: `${redirected}\n`, stderr: "" };
        }
        if (command === "readlink" && args[0] === "-f") return { code: 0, stdout: `${args[1] ?? ""}\n`, stderr: "" };
        const code = 0;
        if (code !== 0 && options.allowFailure !== true) throw new Error(`${command} failed`);
        return { code, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;

  let refused = "";
  try {
    await ensureDataDirs(ancestorLinkCtx);
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
  }

  check(
    "ensureDataDirs refuses a data root reached through a symlinked ANCESTOR",
    refused.includes(dataDir) && refused.includes(redirected),
    true,
  );
  check(
    "and never mkdirs or chowns through the redirected path",
    execCalls.some((call) => call[0] === "mkdir" || call[0] === "chown"),
    false,
  );
}

// The central "do not auto-adopt" clause — a pre-existing standard tree with the
// wrong owner and no provenance marker must be refused outright, never silently re-owned.
// A tree that merely LOOKS like a data directory (someone else's /srv/openclaw/data) must
// not be handed to the fixed uid just because bootstrap happened to point at it.
{
  const dataDir = "/srv/openclaw/data";
  const execCalls: string[][] = [];
  const foreignOwnerCtx = {
    settings: { dataDir },
    transport: {
      description: "stub",
      async exists(path: string): Promise<boolean> {
        // The root and its standard subdirectories are already there; the marker is not —
        // nothing on this tree claims clawwright set it up.
        if (path === `${dataDir}/${DATA_DIR_MARKER}`) return false;
        return path === dataDir || path === `${dataDir}/config` || path === `${dataDir}/workspace` || path === `${dataDir}/auth-secrets`;
      },
      async exec(command: string, args: string[], options: { allowFailure?: boolean } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
        execCalls.push([command, ...args]);
        if (command === "test" && args[0] === "-L") return { code: 1, stdout: "", stderr: "" };
        if (command === "readlink" && args[0] === "-f") return { code: 0, stdout: `${args[1] ?? ""}\n`, stderr: "" };
        // Every standard path is owned by someone else — a foreign tree, not a wrong-owner
        // one this deployment already created.
        if (command === "stat" && args[0] === "-c" && args[1] === "%u:%g") return { code: 0, stdout: "0:0\n", stderr: "" };
        const code = 0;
        if (code !== 0 && options.allowFailure !== true) throw new Error(`${command} failed`);
        return { code, stdout: "", stderr: "" };
      },
      async writeFile(): Promise<void> {
        throw new Error("must not write the marker — the run must refuse before recording provenance");
      },
    },
  } as unknown as Context;

  let refused = "";
  try {
    await ensureDataDirs(foreignOwnerCtx);
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
  }

  check(
    "ensureDataDirs refuses to adopt a pre-existing tree with no provenance marker",
    refused.includes(DATA_DIR_MARKER) && refused.includes(dataDir),
    true,
  );
  check(
    "naming the explicit adoption command as the way out",
    refused.includes(`chown -R`) && refused.includes(dataDir),
    true,
  );
  check(
    "and never mkdirs or chowns the markerless tree",
    execCalls.some((call) => call[0] === "mkdir" || call[0] === "chown"),
    false,
  );
}

finish("bootstrap lock");

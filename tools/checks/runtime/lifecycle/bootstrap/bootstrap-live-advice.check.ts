// R33-11: re-running `bootstrap` on a LIVE instance applies desired-state while the gateway
// keeps running — `compose up --detach` leaves an unchanged container untouched. The run
// must therefore NOT suppress apply-config's "restart to pick it up" advice (it did before:
// the suppression was justified by "the gateway starts a few lines below", which is false
// for a live instance). A fresh instance — the gateway this run really starts — must keep
// the advice suppressed, and neither case may restart the gateway itself.

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { asDirectTest } from "#checks/kit/deployment-fixture.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";

const DATA_DIR = "/srv/openclaw/data";
const CONFIG_PATH = `${DATA_DIR}/config/openclaw.json`;
const LOCK_HOME = "/srv/openclaw/data-locks";

/** A stub context whose bootstrap run succeeds end to end. `live` decides whether the
 *  gateway answers isRunning() with true (an instance already up) or false (fresh). */
function liveOrFreshContext(live: boolean): { ctx: Context; runtimeCalls: string[]; patchCalls: string[][] } {
  const runtimeCalls: string[] = [];
  const files = new Map<string, string>();
  const patchCalls: string[][] = [];
  const dirs = new Set<string>();
  const ctx = {
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
        if (path === DATA_DIR || path.startsWith(`${DATA_DIR}/`)) return path === CONFIG_PATH || path === `${DATA_DIR}/clawwright-declared.json`;
        return true;
      },
      async readFile(path: string): Promise<string> {
        if (path === `${DATA_DIR}/clawwright-declared.json`) {
          const error = new Error(`ENOENT: no such file: ${path}`) as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        if (path === CONFIG_PATH) return JSON.stringify({ gateway: { bind: "all" } });
        if (path.endsWith("holder.json")) throw new Error("no holder recorded");
        return files.get(path) ?? "";
      },
      async writeFile(path: string, content: string): Promise<void> {
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
        // The lock home exists, is writable, and the claim/guard protocol succeeds.
        if (command === "test" && args[0] === "-d") return { code: 0, stdout: "", stderr: "" };
        if (command === "test" && args[0] === "-w") return { code: 0, stdout: "", stderr: "" };
        if (command === "test" && args[0] === "-L") return { code: 1, stdout: "", stderr: "" };
        if (command === "mkdir" && args[0] === `${LOCK_HOME}/operation.mutation`) {
          if (dirs.has(args[0])) return { code: 1, stdout: "", stderr: "File exists" };
          dirs.add(args[0]);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "rmdir" && args[0] === `${LOCK_HOME}/operation.mutation`) {
          dirs.delete(args[0]);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "readlink" && args[0] === "-f") return { code: 0, stdout: `${args[1] ?? ""}\n`, stderr: "" };
        if (command === "stat") return { code: 0, stdout: "1000:1000\n", stderr: "" };
        if (command === "id") return { code: 0, stdout: "1000\n", stderr: "" };
        const code = 0;
        if (code !== 0 && options.allowFailure !== true) throw new Error(`${command} failed`);
        return { code, stdout: "", stderr: "" };
      },
    },
    paths: { toContainer: (path: string) => path },
    runtime: {
      async portConflict(): Promise<string | undefined> {
        return undefined;
      },
      async isRunning(): Promise<boolean> {
        runtimeCalls.push("isRunning");
        return live;
      },
      async runOneOff(_service: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
        patchCalls.push(args);
        runtimeCalls.push("runOneOff");
        return { code: 0, stdout: "", stderr: "" };
      },
      async start(): Promise<void> {
        runtimeCalls.push("start");
      },
      async restart(): Promise<void> {
        runtimeCalls.push("restart");
      },
      async waitForHealth(): Promise<void> {
        runtimeCalls.push("waitForHealth");
      },
      async imageReference(): Promise<string | undefined> {
        return undefined;
      },
    },
  } as unknown as Context;
  return { ctx, runtimeCalls, patchCalls };
}

const deployment = await mkdtemp(join(tmpdir(), "clawwright-bootstrap-live-"));
try {
  await mkdir(resolve(deployment, "config"), { recursive: true });
  await writeFile(
    resolve(deployment, "config", "desired-state.json"),
    JSON.stringify([{ path: "gateway.bind", value: "loopback" }]),
  );
  await writeFile(resolve(deployment, "config", "openclaw.json"), "{}");
  useDeployment(deployment);

  {
    const { ctx, runtimeCalls, patchCalls } = liveOrFreshContext(true);
    let said = "";
    await withOutputSink((chunk: string) => {
      said += chunk;
    }, () => openclawCommands.bootstrap.run(ctx, ["--no-pull"]));

    check(
      "a live instance hears that the applied desired state needs a restart",
      said.includes("restart to pick it up"),
      true,
    );
    check("live config drift really invokes the config patch", patchCalls.length, 1);
    check("bootstrap still starts (not restarts) the gateway service", runtimeCalls.includes("start") && !runtimeCalls.includes("restart"), true);
  }

  {
    const { ctx, runtimeCalls } = liveOrFreshContext(false);
    let said = "";
    await withOutputSink((chunk: string) => {
      said += chunk;
    }, () => openclawCommands.bootstrap.run(ctx, ["--no-pull"]));

    check(
      "a fresh instance keeps the advice suppressed — this run starts the gateway itself",
      said.includes("restart to pick it up"),
      false,
    );
    check("and the gateway was started once", runtimeCalls.filter((call) => call === "start").length, 1);
  }
} finally {
  await rm(deployment, { recursive: true, force: true });
}

finish("bootstrap live-instance restart advice");

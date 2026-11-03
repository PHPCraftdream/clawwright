import assert from "node:assert/strict";
import { join } from "node:path";
import { DockerRuntime } from "#framework/runtime/docker/runtime-docker.ts";
import { mcpServe } from "#framework/commands/management/configuration/credentials/mcp.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import type { Settings } from "#framework/core/env.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { PathBridge } from "#framework/core/paths.ts";
import { ShimTransport } from "./shim-transport.ts";

const [shim, root, branch] = process.argv.slice(2);
useDeployment(root);
const transport = new ShimTransport(root, shim, branch);
const settings = { env: {}, dataDir: join(root, "data"), serviceUrl: "http://shim" } as Settings;
const paths = { toTarget: async (path: string) => path } as PathBridge;
const runtime = new DockerRuntime(transport, settings, paths, { service: "gateway" });
// A progress sink must not intercept protocol bytes or merge stderr into stdout.
await withOutputSink(() => { throw new Error("protocol reached progress sink"); }, async () => {
  if (branch === "finite") {
    const result = await transport.exec("finite", [], { input: "" });
    assert.deepEqual(result, { code: 0, stdout: "finite-eof", stderr: "" });
  } else {
    await mcpServe({ runtime, settings, transport, paths }, []);
  }
});

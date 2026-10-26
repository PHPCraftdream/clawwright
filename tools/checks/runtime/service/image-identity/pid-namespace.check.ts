import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frameworkRoot } from "#framework/core/env.ts";
import { spawnLocal } from "#framework/runtime/transport/transport.ts";
import { requires } from "#checks/kit/harness.ts";

await requires("docker", "CLI state-owner PID identity", async () => {
  const image = "alpine:3.20";
  const available = await spawnLocal("docker", ["image", "inspect", image], { allowFailure: true });
  assert.equal(available.code, 0, "cache alpine:3.20 before running Docker namespace checks");
  const scratch = await mkdtemp(join(tmpdir(), "clawwright-pid-"));
  const project = `pid-${randomBytes(6).toString("hex")}`;
  const file = join(scratch, "compose.json");
  const compose = ["compose", "--project-name", project, "--file", file, "--profile", "cli"];
  try {
    const data = join(scratch, "data");
    await mkdir(data);
    const definition = await spawnLocal("docker", [
      "compose", "--project-name", project, "--file", join(frameworkRoot, "docker-compose.yml"),
      "--profile", "cli", "config", "--format", "json",
    ], { env: { OC_DATA_DIR: data.replaceAll("\\", "/"), OPENCLAW_GATEWAY_TOKEN: "synthetic-pid-fixture" } });
    const parsed = JSON.parse(definition.stdout) as {
      services: Record<string, { pid?: string; network_mode?: string }>;
    };
    const services: Record<string, object> = {
      gateway: { image, command: ["sleep", "300"] },
    };
    for (const name of ["cli", "cli-helper"]) {
      const source = parsed.services[name];
      assert.ok(source, `${name} is declared`);
      assert.equal(source.pid, "service:gateway", `${name} must see the gateway's owner PIDs`);
      assert.equal(source.network_mode, "service:gateway");
      services[name] = {
        image, profiles: ["cli"], pid: source.pid, network_mode: source.network_mode,
        depends_on: ["gateway"],
        ...(name === "cli" ? { entrypoint: ["sh"] } : { command: ["sleep", "300"] }),
      };
    }
    await writeFile(file, JSON.stringify({ services }));
    await spawnLocal("docker", [...compose, "up", "--detach", "gateway", "cli-helper"]);
    const namespace = async (service: string): Promise<string> => {
      const result = await spawnLocal("docker", [...compose, "exec", "-T", service, "readlink", "/proc/1/ns/pid"]);
      return result.stdout.trim();
    };
    const gateway = await namespace("gateway");
    assert.match(gateway, /^pid:\[\d+\]$/);
    assert.equal(await namespace("cli-helper"), gateway, "persistent helper shares gateway PID identity");
    const oneOff = await spawnLocal("docker", [
      ...compose, "run", "--rm", "--no-deps", "-T", "cli", "-c", "readlink /proc/1/ns/pid",
    ]);
    assert.equal(oneOff.stdout.trim(), gateway, "one-shot CLI shares gateway PID identity");
  } finally {
    await spawnLocal("docker", [...compose, "down", "--volumes", "--remove-orphans"], { allowFailure: true });
    await rm(scratch, { recursive: true, force: true });
  }
});

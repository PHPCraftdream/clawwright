// Deployment template shared by scaffold.ts (monorepo `new-app`) and init.ts (installed `init`):
// the .env a fresh deployment starts from, its port, and the .gitignore lines.

import { readFile, writeFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { resolve } from "node:path";
import { frameworkRoot, parseEnvLenient, projectPort, deploymentEnvText, type DeploymentEnv } from "../../core/env.ts";

/** Ports claimed by sibling deployments (each subdirectory's own .env) under `scanDir`. */
export async function usedPorts(scanDir: string): Promise<Set<number>> {
  const ports = new Set<number>();

  let entries: Dirent[];
  try {
    entries = await readdir(scanDir, { withFileTypes: true });
  } catch {
    return ports;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      // Deliberately lenient: one deployment's broken .env must not break port listing for all.
      const env = parseEnvLenient(await readFile(resolve(scanDir, entry.name, ".env"), "utf8"));
      const port = Number.parseInt(env.OPENCLAW_GATEWAY_PORT ?? "", 10);
      if (Number.isFinite(port)) ports.add(port);
    } catch {
      // A deployment without a readable .env claims no port.
    }
  }
  return ports;
}

/** The template .env with a data path and a port that do not collide with siblings under `scanDir`. */
export async function deploymentEnv(name: string, scanDir: string, portStart?: number): Promise<DeploymentEnv> {
  const template = await readFile(resolve(frameworkRoot, ".env.example"), "utf8");
  const taken = await usedPorts(scanDir);
  const port = projectPort(taken, portStart);

  return deploymentEnvText(template
    .split("\n")
    .map((line) => {
      if (line.startsWith("OC_DATA_DIR=")) return `OC_DATA_DIR=/srv/${name}/data`;
      if (line.startsWith("OC_BACKUP_DIR=")) return `OC_BACKUP_DIR=/srv/${name}/backups`;
      if (line.startsWith("OC_SNAPSHOT_DIR=")) return `OC_SNAPSHOT_DIR=/srv/${name}/snapshots`;
      if (line.startsWith("OPENCLAW_GATEWAY_PORT=")) return `OPENCLAW_GATEWAY_PORT=${port}`;
      return line;
    })
    .join("\n"));
}

/** Ordered .gitignore lines; `nodeModules` adds the installed-mode `node_modules/`. */
export function gitignoreLines(nodeModules: boolean): string[] {
  return [
    ...(nodeModules
      ? [
          "",
          "# @phpcraftdream/clawwright: installed, not vendored — the whole point of installing it as a",
          "# dependency instead of copying it in is that it never has to be committed.",
          "node_modules/",
        ]
      : []),
    "",
    "# OpenClaw deployment state — the gateway token and provider secrets, never framework",
    "# config. MCP client files (.mcp.json, .codex/) are excluded separately.",
    ".env",
    "secrets/",
    "# Machine-local watch state and built set artifacts, both regenerated every cycle —",
    "# config/, recipes/ and deployment.lock.json stay trackable.",
    "state/",
    "sets/",
  ];
}

/** Whether a data directory sits under /srv — the template's own default (`deploymentEnv`
 *  above), and the one place a fresh host is most often root-owned before first bootstrap. */
export function isUnderSrv(dataDir: string): boolean {
  return dataDir === "/srv" || dataDir.startsWith("/srv/");
}

/** The "next:" block printed once a deployment directory is written — shared by
 *  scaffold.ts's `new-app` and init.ts's `init`, differing only in how bootstrap is
 *  invoked. Names the data directory rather than pointing at the file and leaving the
 *  reader to find it in a troubleshooting table. Points at `bootstrap --check` rather than
 *  guessing a `sudo install -d` line here: this runs before any target exists to ask. */
/** The /srv hint: a fresh host keeps those directories out of the operator's hands. */
export const ROOT_OWNED = "usually root-owned";

export function nextStepsLines(envFile: string, dataDir: string, bootstrapCommand: string): string[] {
  const lines = [`  1. data directory: ${dataDir}  (also check ${envFile} for the port and image)`];
  if (isUnderSrv(dataDir)) {
    lines.push(
      `     it is under /srv, ${ROOT_OWNED} on a fresh host — ${bootstrapCommand} --check reports ` +
        "exactly what it needs, including the sudo install -d line if one is needed",
    );
  }
  lines.push(`  2. ${bootstrapCommand} --check   (read-only: docker, compose v2, this directory, the gateway port, disk space)`);
  lines.push(`  3. ${bootstrapCommand}`);
  return lines;
}

/** Appends the lines missing from the directory's .gitignore, one by one; a repeat run is a no-op.
 *  Existing bytes stay as they are and the file's own line ending is reused. */
export async function updateGitignore(directory: string, lines: readonly string[]): Promise<void> {
  const file = resolve(directory, ".gitignore");
  let existing = "";
  try {
    existing = await readFile(file, "utf8");
  } catch {
    // No .gitignore yet — start from nothing.
  }

  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const present = new Set(existing === "" ? [] : existing.split(/\r\n|\n/));
  const missing = lines.filter((line) => !present.has(line));
  if (missing.length === 0) return;

  const needsBreak = existing !== "" && !existing.endsWith("\n");
  await writeFile(file, `${existing}${needsBreak ? eol : ""}${missing.join(eol)}${eol}`, "utf8");
}

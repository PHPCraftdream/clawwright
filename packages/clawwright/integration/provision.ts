// Preparing a deployment's environment before anything reads it.
//
// This must run before the context is built: building the context first parses .env and
// constructs the runtime around it, so on a deployment without a .env yet, bootstrap would
// fail in the parser before it could create one — and even once bootstrap wrote a token, a
// context built earlier would still carry stale settings, so compose would run without it.
//
// So this runs first, on its own, and the context is built afterwards from the finished
// file. Commands opt in by declaring preparesEnvironment.

import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { log, registerSecret } from "../core/io/log.ts";
import { readEnvFileText, readEnvValue, upsertEnvLine } from "../core/env.ts";
import { envFile, deploymentName } from "../runtime/deployment.ts";
import { deploymentEnv } from "./deployment/scaffold.ts";
import { createPrivateFile, protectPrivateFile, replacePrivateFile } from "../security/privacy/private-file.ts";

/** A fresh OPENCLAW_GATEWAY_TOKEN: 32 random bytes, hex. Bootstrap and incident rotation share it. */
export function generateGatewayToken(): string {
  return randomBytes(32).toString("hex");
}

/** Creates .env on first run, with this deployment's own paths and port rather than the
 *  template's — a copied template would put two deployments on the same data directory. */
async function ensureEnvFile(): Promise<boolean> {
  const exists = await access(envFile()).then(
    () => true,
    () => false,
  );
  if (exists) {
    await protectPrivateFile(envFile());
    return false;
  }

  log(`creating ${envFile()}`);
  try {
    await createPrivateFile(envFile(), await deploymentEnv(deploymentName()));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await protectPrivateFile(envFile());
    return false;
  }
}

/** Generates the gateway token once and keeps it: regenerating would break every client
 *  that already stored it. */
async function ensureToken(): Promise<{ token: string; wrote: boolean }> {
  const content = await readEnvFileText();
  const current = readEnvValue(content, "OPENCLAW_GATEWAY_TOKEN", envFile());
  if (current !== undefined && current.trim() !== "") return { token: current.trim(), wrote: false };

  log("generating a gateway token");
  const token = generateGatewayToken();
  try {
    await replacePrivateFile(envFile(), upsertEnvLine(content, "OPENCLAW_GATEWAY_TOKEN", token));
  } catch (error) {
    let persisted = false;
    try {
      persisted = readEnvValue(await readEnvFileText(), "OPENCLAW_GATEWAY_TOKEN", envFile())?.trim() === token;
    } catch { /* retain the original persistence error */ }
    if (persisted && error !== null && typeof error === "object") provisioningWrites.set(error, true);
    throw error;
  }
  return { token, wrote: true };
}

/** Makes the deployment's environment file complete enough to build a context from.
 *  Idempotent: an existing file keeps its values, including the token. */
export async function ensureEnvironment(): Promise<{ token: string; wrote: boolean }> {
  const fileWrote = await ensureEnvFile();
  try {
    const ensured = await ensureToken();
    registerSecret(ensured.token);
    return { token: ensured.token, wrote: fileWrote || ensured.wrote };
  } catch (error) {
    if (fileWrote && error !== null && typeof error === "object") provisioningWrites.set(error, true);
    throw error;
  }
}

const provisioningWrites = new WeakMap<object, boolean>();
export function provisioningWrote(error: unknown): boolean {
  return error !== null && typeof error === "object" && provisioningWrites.get(error) === true;
}

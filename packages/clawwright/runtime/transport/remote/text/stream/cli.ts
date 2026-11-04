import { UserError } from "#src/core/io/log.ts";
import { ssjackTextEnvironment } from "#src/runtime/transport/remote/ssjack-contract.ts";
import { ssjackTextBootstrap, type SsjackTextStatus } from "#src/runtime/transport/remote/text/client.ts";
import { SsjackTextStreamClient } from "./client.ts";
import { TextStreamTemplate } from "./files.ts";

const fail = (): UserError => new UserError("SSJACK_TEXT_OPERATION_FAILED");

export function validateTextStreamArguments(stream: boolean, references: string | undefined): void {
  if (stream !== (references !== undefined)) throw fail();
}

async function readReferences(path: string): Promise<readonly string[]> {
  const source = await TextStreamTemplate.open(path);
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of source.read()) {
      if (chunk.length > 16384 - size) throw fail();
      size += chunk.length;
      chunks.push(chunk);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
    if (!Array.isArray(value) || value.length < 1 || value.length > 16 || !value.every((item) => typeof item === "string" && item.length <= 1024)) throw fail();
    return Object.freeze(value.slice() as string[]);
  } finally { await source.close(); }
}

export async function deploySsjackTextStream(
  input: { file: string; template: string; profile: string; references: string },
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<SsjackTextStatus> {
  try {
    const bootstrap = ssjackTextBootstrap(ssjackTextEnvironment(env));
    if (bootstrap === undefined || bootstrap.profile !== input.profile) throw fail();
    const references = await readReferences(input.references);
    return await new SsjackTextStreamClient(bootstrap, "text_hydrate_stream_v2").deploy({
      file: input.file, profile: input.profile, references, template: input.template,
    });
  } catch { throw fail(); }
}

export async function backupSsjackTextStream(
  input: { file: string; output: string; profile: string; references: string },
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<SsjackTextStatus> {
  try {
    const bootstrap = ssjackTextBootstrap(ssjackTextEnvironment(env));
    if (bootstrap === undefined || bootstrap.profile !== input.profile) throw fail();
    const references = await readReferences(input.references);
    return await new SsjackTextStreamClient(bootstrap, "text_reverse_copy_stream_v2").backup({
      file: input.file, profile: input.profile, references, output: input.output,
    });
  } catch { throw fail(); }
}

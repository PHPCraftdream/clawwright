// The MCP envelope must describe an apply dry-run as read-only, while an ordinary apply
// remains a mutating call. This exercises the JSON-RPC path with the real apply declaration;
// the command body is replaced with a tiny stateful fixture so no instance is started.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnLocal } from "#framework/runtime/transport/transport.ts";
import { useLinuxHost } from "#checks/foundation/hygiene/linux-host.ts";
import { CHILD_NODE_DEADLINE_MS } from "#checks/kit/spawn.ts";

useLinuxHost();

const root = await mkdtemp(join(tmpdir(), "clawwright-mcp-apply-report-"));
try {
  await mkdir(join(root, "config"));
  const token = 'synthetic-mcp-"failure' + String.fromCharCode(92) + "token";
  await writeFile(join(root, ".env"), `OC_DATA_DIR=${join(root, "data")}\nOC_TARGET_LOCATION=local\nOPENCLAW_GATEWAY_TOKEN=${token}\n`);
  const moduleUrl = (path: string): string => new URL(`../../../framework/${path}.ts`, import.meta.url).href;
  const script = `
    const {serveMcp}=await import(${JSON.stringify(moduleUrl("integration/mcp/server"))});
    const {useDeployment}=await import(${JSON.stringify(moduleUrl("runtime/deployment"))});
    const {openclawCommands}=await import(${JSON.stringify(moduleUrl("commands/interface/index"))});
    const {emit}=await import(${JSON.stringify(moduleUrl("core/io/output"))});
    const {registerSecret}=await import(${JSON.stringify(moduleUrl("core/io/log"))});
    let target=0;
    // Replacing run drops the spread onto the legacy path, so the fixture carries the
    // dry-run predicate the migration removed from the real declaration.
    const apply={...openclawCommands.apply,changedWhen:(args)=>!args.includes("--dry-run"),run:async(_ctx,args)=>{
      if (args.includes("--dry-run")) {
        emit(JSON.stringify({deployment:"fixture",target,healthy:true,problems:[],actions:[]})+"\\n");
        return;
      }
      target+=1;
      emit(JSON.stringify({deployment:"fixture",operationId:"fixture",changed:true,target,healthy:true,problems:[],nextActions:[]})+"\\n");
    }};
    useDeployment(${JSON.stringify(root)});
    const explode={summary:"fixture failure",structured:true,run:async(ctx)=>{
      const token=ctx.settings.env.OPENCLAW_GATEWAY_TOKEN;
      const secondToken="synthetic-mcp-unicode-token";
      registerSecret(secondToken);
      const payload=JSON.stringify({operationId:"explode",changed:true,problems:[{detail:token}],warnings:[token,secondToken],nextActions:[token],result:{detail:token,diagnostics:{[token]:"first",[secondToken]:"second","***":"third"}}});
      emit(payload.replace(secondToken,String.fromCharCode(92)+"u0073"+secondToken.slice(1))+"\\n");
      throw new Error("failure "+token+" "+secondToken);
    }};
    await serveMcp({name:"fixture",commands:{apply,explode}});
  `;
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "apply", arguments: { confirm: true, "dry-run": true, json: true } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "apply", arguments: { confirm: true, json: true } } },
    { jsonrpc: "2.0", id: 3, method: "tools/list" },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "explode", arguments: {} } },
  ].map((request) => JSON.stringify(request)).join("\n");

  const result = await spawnLocal(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    input: `${requests}\n`,
    timeoutMs: CHILD_NODE_DEADLINE_MS,
  });
  assert.equal(result.code, 0);
  const responses = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as {
      id: number;
      result?: {
        isError?: boolean;
        content?: Array<{ type?: string; text?: string }>;
        structuredContent?: Record<string, unknown>;
      };
    });
  const byId = new Map(responses.map((response) => [response.id, response]));
  const dryRun = byId.get(1)?.result?.structuredContent;
  const ordinary = byId.get(2)?.result?.structuredContent;
  const listed = byId.get(3)?.result;
  const failed = byId.get(4)?.result;
  const escapedToken = JSON.stringify(token).slice(1, -1);
  const escapedUnicodeToken = String.fromCharCode(92) + "u0073" + "synthetic-mcp-unicode-token".slice(1);
  const failedText = (failed?.content ?? [])
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text ?? "")
    .join("\n");
  const failedPayload = JSON.parse(failedText.split("\n\n")[0]) as { result?: { diagnostics?: Record<string, unknown> } };

  assert.equal(dryRun?.changed, false, "MCP apply --dry-run must be reported as read-only");
  assert.equal((dryRun?.result as { target?: number } | undefined)?.target, 0, "dry-run must leave the target unchanged");
  assert.equal(ordinary?.changed, true, "ordinary MCP apply remains mutating");
  assert.equal(ordinary?.operationId, "fixture", "MCP envelope reuses the command operation id");
  assert.equal((ordinary?.result as { target?: number } | undefined)?.target, 1, "ordinary apply must update the target");
  assert.equal(failed?.isError, true, "failed MCP commands report an error");
  assert.equal(JSON.stringify(failed).includes(token), false, "MCP failures mask registered secrets");
  assert.equal(failedText.includes(escapedToken), false, "MCP text failures mask JSON-escaped registered secrets");
  assert.equal(failedText.includes(escapedUnicodeToken), false, "MCP text failures mask Unicode-escaped registered secrets");
  assert.equal(JSON.stringify(failed?.structuredContent).includes(escapedToken), false, "structured MCP failures mask JSON-escaped registered secrets in values and keys");
  const diagnostics = ((failed?.structuredContent?.result as { result?: { diagnostics?: Record<string, unknown> } } | undefined)?.result?.diagnostics) ?? {};
  assert.equal(Object.keys(diagnostics).length, 3, "masked diagnostic keys remain unique");
  assert.deepEqual(new Set(Object.values(diagnostics)), new Set(["first", "second", "third"]), "masked diagnostics preserve every value");
  const textDiagnostics = failedPayload.result?.diagnostics ?? {};
  assert.equal(Object.keys(textDiagnostics).length, 3, "masked text diagnostic keys remain unique");
  assert.deepEqual(new Set(Object.values(textDiagnostics)), new Set(["first", "second", "third"]), "masked text diagnostics preserve every value");
  const tool = ((listed as { tools?: Array<{ name: string; outputSchema?: unknown }> } | undefined)?.tools ?? [])
    .find((entry) => entry.name === "apply");
  assert.notEqual(tool?.outputSchema, undefined, "apply keeps its structured output schema");
  process.stderr.write("all MCP apply report checks passed\n");
} finally {
  await rm(root, { recursive: true, force: true });
}

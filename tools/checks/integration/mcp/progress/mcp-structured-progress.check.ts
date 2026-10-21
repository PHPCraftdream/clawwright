import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnLocal } from "#framework/runtime/transport/transport.ts";
import { useLinuxHost } from "#checks/foundation/hygiene/linux-host.ts";
import { CHILD_NODE_DEADLINE_MS } from "#checks/kit/spawn.ts";
import { frameworkVersion } from "#framework/commands/management/lock.ts";

useLinuxHost();

const root = await mkdtemp(join(tmpdir(), "clawwright-mcp-structured-"));
try {
  await mkdir(join(root, "config"));
  await writeFile(join(root, ".env"), "OC_DATA_DIR=/tmp/fixture\nOC_TARGET_LOCATION=local\n");
  const modulePath: Record<string, string> = {
    "mcp-server": "integration/mcp/server",
    deployment: "runtime/deployment",
    output: "core/io/output",
    log: "core/io/log",
  };
  const moduleUrl = (name: string) => new URL(`../../../framework/${modulePath[name]}.ts`, import.meta.url).href;
  const script = `
    const {serveMcp}=await import(${JSON.stringify(moduleUrl("mcp-server"))});
    const {useDeployment}=await import(${JSON.stringify(moduleUrl("deployment"))});
    const {emit}=await import(${JSON.stringify(moduleUrl("output"))});
    const {log,warn}=await import(${JSON.stringify(moduleUrl("log"))});
    useDeployment(${JSON.stringify(root)});
    await serveMcp({name:"fixture",service:{name:"gateway"},commands:{check:{summary:"fixture",structured:true,readOnlyWhen:()=>true,run:async()=>{
      log("progress before JSON"); emit(JSON.stringify({healthy:true,changed:true,marker:"result"})+"\\n"); warn("progress after JSON");
    }}}});
  `;
  const result = await spawnLocal(process.execPath, ["--input-type=module", "-e", script], {
    input: `${JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"check",arguments:{}}})}\n`,
    timeoutMs: CHILD_NODE_DEADLINE_MS,
  });
  const response = JSON.parse(result.stdout.trim());
  assert.equal(response.result.structuredContent.result.marker, "result");
  assert.equal(response.result.structuredContent.healthy, true);
  assert.equal(response.result.structuredContent.changed, false);
  assert.equal(response.result.structuredContent.result.changed, true);
  assert.match(response.result.content[0].text, /progress before JSON/);
  assert.match(response.result.content[0].text, /progress after JSON/);
  process.stderr.write("all structured MCP progress checks passed\n");
} finally {
  await rm(root, { recursive: true, force: true });
}

// --- ping, serverInfo.version, and the read loop staying responsive around a queued call ---
//
// `tools/call` used to be awaited inline in the read loop, so a slow call blocked `ping` and
// every call queued behind it, `ping` itself was unimplemented, and `serverInfo.version` was
// a hardcoded "1". This drives one server through: a slow call, a ping sent right behind it
// (must answer before the slow call finishes), two more calls sent back to back (must not
// interleave their captured output — they share one process-global sink, so they still run
// one at a time), and a cancellation of a fourth call still waiting in that queue (must
// answer "cancelled" immediately rather than waiting for its turn, and must not answer twice
// once its turn actually comes).
{
  const expectedVersion = await frameworkVersion();
  const root2 = await mkdtemp(join(tmpdir(), "clawwright-mcp-concurrency-"));
  try {
    await mkdir(join(root2, "config"));
    await writeFile(join(root2, ".env"), "OC_DATA_DIR=/tmp/fixture\nOC_TARGET_LOCATION=local\n");
    const modulePath: Record<string, string> = {
      "mcp-server": "integration/mcp/server",
      deployment: "runtime/deployment",
      log: "core/io/log",
    };
    const moduleUrl = (name: string) => new URL(`../../../framework/${modulePath[name]}.ts`, import.meta.url).href;
    const script = `
      const {serveMcp}=await import(${JSON.stringify(moduleUrl("mcp-server"))});
      const {useDeployment}=await import(${JSON.stringify(moduleUrl("deployment"))});
      const {log}=await import(${JSON.stringify(moduleUrl("log"))});
      const sleep=(ms)=>new Promise((r)=>setTimeout(r,ms));
      useDeployment(${JSON.stringify(root2)});
      await serveMcp({name:"fixture",service:{name:"gateway"},commands:{
        slow:{summary:"test-only: pauses before finishing",run:async()=>{await sleep(200);log("slow done");}},
        "slow-cancel":{summary:"test-only: pauses before finishing, cancellation target",run:async()=>{process.stderr.write("RAN slow-cancel\\n");await sleep(200);log("slow-cancel done");}},
        "chatty-a":{summary:"test-only: staggered output A",run:async()=>{log("A1");await sleep(30);log("A2");await sleep(30);log("A3");}},
        "chatty-b":{summary:"test-only: staggered output B",run:async()=>{log("B1");await sleep(30);log("B2");await sleep(30);log("B3");}},
      }});
    `;
    const requests = [
      { jsonrpc: "2.0", id: 101, method: "initialize" },
      { jsonrpc: "2.0", id: 102, method: "ping" },
      { jsonrpc: "2.0", id: 103, method: "tools/call", params: { name: "slow", arguments: {} } },
      { jsonrpc: "2.0", id: 104, method: "ping" },
      { jsonrpc: "2.0", id: 105, method: "tools/call", params: { name: "chatty-a", arguments: {} } },
      { jsonrpc: "2.0", id: 106, method: "tools/call", params: { name: "chatty-b", arguments: {} } },
      { jsonrpc: "2.0", id: 107, method: "tools/call", params: { name: "slow-cancel", arguments: {} } },
      { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 107 } },
    ];
    const result = await spawnLocal(process.execPath, ["--input-type=module", "-e", script], {
      input: `${requests.map((r) => JSON.stringify(r)).join("\n")}\n`,
      timeoutMs: CHILD_NODE_DEADLINE_MS,
    });
    if (result.code !== 0) process.stderr.write(`concurrency server exited ${result.code}:\n${result.stderr}\n`);
    const responses = result.stdout.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
    const byId = (id: number) => responses.find((r) => r.id === id);
    const indexOf = (id: number) => responses.findIndex((r) => r.id === id);

    assert.equal(byId(101)?.result?.serverInfo?.version, expectedVersion, "initialize reports the framework's own version");
    assert.deepEqual(byId(102)?.result, {}, "ping answers with an empty result");
    assert.deepEqual(byId(104)?.result, {}, "a second ping still answers with an empty result");

    assert.ok(indexOf(104) !== -1 && indexOf(103) !== -1, "both the slow call and the ping sent right after it were answered");
    assert.ok(indexOf(104) < indexOf(103), "ping (104) is answered before the slow call (103) that was already queued finishes");

    const textOf = (id: number): string => String(byId(id)?.result?.content?.[0]?.text ?? "");
    assert.match(textOf(105), /A1/); assert.match(textOf(105), /A2/); assert.match(textOf(105), /A3/);
    assert.doesNotMatch(textOf(105), /B1|B2|B3/, "chatty-a's captured output does not carry chatty-b's lines");
    assert.match(textOf(106), /B1/); assert.match(textOf(106), /B2/); assert.match(textOf(106), /B3/);
    assert.doesNotMatch(textOf(106), /A1|A2|A3/, "chatty-b's captured output does not carry chatty-a's lines");

    const cancelReplies = responses.filter((r) => r.id === 107);
    assert.equal(cancelReplies.length, 1, "the cancelled call's id is answered exactly once, not once for the cancellation and again for its real completion");
    assert.equal(cancelReplies[0]?.result?.isError, true);
    assert.equal(cancelReplies[0]?.result?.content?.[0]?.text, "cancelled");
    assert.ok(indexOf(107) < indexOf(103), "the cancellation reply does not wait for the calls still queued ahead of it");

    assert.doesNotMatch(result.stderr, /RAN slow-cancel/, "a call cancelled while still queued never starts");
    assert.equal(responses.length, 7, "exactly one reply per request id, and none for the suppressed post-cancellation completion");
    process.stderr.write("all MCP concurrency/cancellation checks passed\n");
  } finally {
    await rm(root2, { recursive: true, force: true });
  }
}

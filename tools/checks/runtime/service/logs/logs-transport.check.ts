// The transport boundary of a bounded log read: what `ComposeOperations.readLogRecords` puts
// on the docker argv (--timestamps, and --tail with the explicit or configured default), and
// that what comes back — docker not on a TTY delivering stdout and stderr as two blocks — is
// merged into one chronological sequence before the tail is applied.

import { useDeployment, deploymentDir } from "#framework/runtime/deployment.ts";
import { ComposeOperations } from "#framework/runtime/docker/compose-operations.ts";
import type { Transport } from "#framework/runtime/transport/transport.ts";
import type { Settings } from "#framework/core/env.ts";
import type { PathBridge } from "#framework/core/paths.ts";
import { check, finish } from "#checks/kit/harness.ts";

// The compose line shape ("<service>  | <text>") the fixtures produce, built structurally so
// no prose literal sits in an expected operand.
const composeLine = (service: string, text: string): string => [service, text].join("  | ");

const previous = (() => { try { return deploymentDir(); } catch { return undefined; } })();
useDeployment("/fixture/deployment");
try {
  // Compose-shaped fixture: SIX records interleaved across the two blocks docker not on a
  // TTY delivers, so input order is not chronological and a tail must be applied AFTER the
  // merge — a default tail that only bounds docker's per-stream work would leave 6 records.
  const stdout =
    "gateway  | 2024-01-02T10:00:00.000000000Z one\ngateway  | 2024-01-02T10:00:02.000000000Z three\ngateway  | 2024-01-02T10:00:04.000000000Z five\n";
  const stderr =
    "gateway  | 2024-01-02T10:00:01.000000000Z two\ngateway  | 2024-01-02T10:00:03.000000000Z four\ngateway  | 2024-01-02T10:00:05.000000000Z six\n";

  const execCalls: string[][] = [];
  let calls = 0;
  const transport = {
    exec: async (command: string, args: string[]) => {
      calls += 1;
      if (command === "docker") execCalls.push(args);
      return { code: 0, stdout, stderr };
    },
    mkdirp: async () => { calls += 1; },
    exists: async () => { calls += 1; return true; },
    mkdir: async () => { calls += 1; },
    writeFile: async () => { calls += 1; },
    remove: async () => { calls += 1; },
    listFiles: async () => { calls += 1; return []; },
  } as unknown as Transport;

  const ops = new ComposeOperations(
    transport,
    () => ({ dataDir: "/srv/openclaw/data", env: {} } as unknown as Settings),
    () => {},
    { toTarget: async (path: string) => path } as PathBridge,
    "gateway",
    "3",
    undefined,
  );

  const records = await ops.readLogRecords("5");
  const argv = execCalls[0] ?? [];
  const tailAt = argv.indexOf("--tail");
  check("the compose argv asks docker for timestamps", argv.includes("--timestamps"), true);
  check("an explicit --tail reaches the docker argv", tailAt !== -1, true);
  check("the explicit tail value is what docker is given", argv[tailAt + 1], "5");
  check("an explicit tail of 5 keeps exactly the last five records in merged order", records.map((r) => r.text), [composeLine("gateway", "two"), composeLine("gateway", "three"), composeLine("gateway", "four"), composeLine("gateway", "five"), composeLine("gateway", "six")]);
  check("the merged records carry their stream", records.map((r) => r.stream), ["stderr", "stdout", "stderr", "stdout", "stderr"]);

  execCalls.length = 0;
  const defaulted = await ops.readLogRecords();
  const defaultArgv = execCalls[0] ?? [];
  const defaultTailAt = defaultArgv.indexOf("--tail");
  check("without an explicit tail the configured default reaches the docker argv", defaultArgv[defaultTailAt + 1], "3");
  check("the default call still asks docker for timestamps", defaultArgv.includes("--timestamps"), true);
  check("and the same default bounds the merged result to exactly the last three records", defaulted.map((r) => r.text), [composeLine("gateway", "four"), composeLine("gateway", "five"), composeLine("gateway", "six")]);
  check("the default tail keeps exactly three records", defaulted.length, 3);

  const text = await ops.readLogs("25");
  check("readLogs returns the timestamp-free text of the merged records", text, [composeLine("gateway", "one"), composeLine("gateway", "two"), composeLine("gateway", "three"), composeLine("gateway", "four"), composeLine("gateway", "five"), composeLine("gateway", "six")].join("\n") + "\n");
} finally {
  if (previous !== undefined) useDeployment(previous);
}

finish("logs-transport");

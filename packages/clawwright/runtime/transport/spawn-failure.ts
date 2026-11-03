// Shortens a failed local command's headline and filters Compose's own progress noise out
// of the detail beneath it. Pure string processing, split out of runtime/transport/transport.ts
// so spawnLocal's own machinery stays the file that owns process spawning; lives beside it in
// runtime/transport/.

// Compose's own progress noise, sometimes the only thing on stderr; matched loosely (wording
// can change between point releases). The container/network lifecycle lines are anchored at
// both ends (against the already-trimmed line) so a real error that merely mentions a
// container in passing is never dropped alongside them.
const COMPOSE_NOISE = [
  /msg="No services to build"/,
  /^Container \S+ (?:Creating|Created|Starting|Started|Running|Stopping|Stopped|Removing|Removed|Waiting|Healthy)$/,
  /^Network \S+ (?:Creating|Created|Removing|Removed)$/,
];

/** True for a line of Compose's own progress noise. Shared by meaningfulLines() (a
 *  rejection's detail) and spawnLocal's live streaming forwarder, so a failure's detail and
 *  what the operator watched agree on what counts as noise. Trims its input: a raw chunk
 *  line may still carry a trailing \r Compose wrote for a TTY's cursor control. */
export function isComposeNoiseLine(line: string): boolean {
  return COMPOSE_NOISE.some((pattern) => pattern.test(line.trim()));
}

/** Non-empty, non-noise lines: the candidate lines for a rejection's detail. */
export function meaningfulLines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !isComposeNoiseLine(line));
}

/** Line-buffers a live stream's chunks so a noise line split across two chunks is still
 *  recognized whole, and drops only complete lines that are Compose's progress noise before
 *  handing the rest to `write` exactly as received. flush() forwards whatever incomplete
 *  trailing text never reached a newline, so nothing is silently lost, only reordered by at
 *  most one buffered line. */
export function noiseFilteredForwarder(write: (chunk: string) => void): { push: (chunk: string) => void; flush: () => void } {
  let pending = "";
  return {
    push(chunk: string): void {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      const kept = lines.filter((line) => !isComposeNoiseLine(line));
      if (kept.length > 0) write(`${kept.join("\n")}\n`);
    },
    flush(): void {
      if (pending !== "") write(pending);
      pending = "";
    },
  };
}

// #composeArgs() (runtime/docker/compose-operations.ts) always inserts these right after "compose": real,
// but never the reason a call failed.
const COMPOSE_IDENTITY_FLAGS = new Set(["--env-file", "--project-name", "--file", "--project-directory"]);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Shortens an invocation to the part naming *what* was run, for a failure's headline: peels
 *  `wsl.exe -d <distro> --exec` (WslTransport.exec), withEnvPrefix's `env -u NAME...` wrapper,
 *  then — once what's left starts with "docker compose" — the identity flags above. The
 *  unshortened argv is never lost: spawnLocal keeps it on CommandFailure.fullCommand for
 *  OC_DEBUG=1. */
export function describeInvocation(command: string, args: string[]): string {
  let tokens = [command, ...args];
  const execAt = tokens[0] === "wsl.exe" ? tokens.indexOf("--exec") : -1;
  if (execAt !== -1) tokens = tokens.slice(execAt + 1);

  if (tokens[0] === "env") {
    let at = 1;
    while (tokens[at] === "-u") at += 2;
    while (ENV_ASSIGNMENT.test(tokens[at] ?? "")) at += 1;
    tokens = tokens.slice(at);
  }

  if (tokens[0] === "docker" && tokens[1] === "compose") {
    tokens = tokens.filter((token, index) =>
      index < 2 || (!COMPOSE_IDENTITY_FLAGS.has(token) && !COMPOSE_IDENTITY_FLAGS.has(tokens[index - 1])));
  }

  // This framework's own `sh -c <script>` staging invocations must never paste their
  // multi-statement body into a headline — OC_DEBUG=1 still gets the untouched command via
  // CommandFailure.fullCommand. Two shapes reach here: the plain array form (local/WSL) and
  // SSH's, where the whole invocation is already one shell-quoted string by the time this
  // runs (SshTransport.exec joins before spawnLocal ever sees it).
  if (tokens[0] === "sh" && tokens[1] === "-c") {
    tokens = [tokens[0], tokens[1], "…"];
  } else {
    tokens = tokens.map((token) => {
      const at = token.indexOf("'sh' '-c' ");
      return at === -1 ? token : `${token.slice(0, at)}sh -c …`;
    });
  }

  return tokens.join(" ");
}

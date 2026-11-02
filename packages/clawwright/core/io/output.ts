// Where a command's output goes.
//
// On a terminal it goes to the terminal, and child processes stream straight through so
// progress is visible. Under the MCP server neither works: stdout carries JSON-RPC, and an
// inherited child process writes a container table into the middle of a protocol message.
//
// So there is a mode — a module-level sink, not a threaded parameter, because the thing
// that must not write to stdout is arbitrarily deep: a command, a helper, a spawned process.
//
// Nothing here rewrites what it is given: emit() is the framework's own document path and
// emitRaw() carries byte streams that belong to someone else (a container's output, a token,
// a completion script). Both print the text exactly as it was built.

type Sink = (chunk: string) => void;

let sink: Sink | undefined;
let machineSink: Sink | undefined;
let machineWrites = 0;
let stdoutBytes = 0;

/** Runs `body` with every line of output handed to `collect` instead of the terminal. */
export async function withOutputSink<T>(collect: Sink, body: () => Promise<T>, collectMachine?: Sink): Promise<T> {
  const previous = sink;
  const previousMachine = machineSink;
  sink = collect;
  machineSink = collectMachine;
  try {
    return await body();
  } finally {
    sink = previous;
    machineSink = previousMachine;
  }
}

/** The active sink, or undefined when output belongs to the terminal. */
export function outputSink(): Sink | undefined {
  return sink;
}

/** True while output is being captured — for the few operations that only make sense on a
 *  terminal, such as following a log. */
export function isCaptured(): boolean {
  return sink !== undefined;
}

/** True only when a human is actually watching a real terminal — not merely "not the MCP
 *  server". A follow-forever call read through a plain pipe or subprocess (a script, `...
 *  | less`) has no MCP sink either, so isCaptured() alone would still say "follow" and hang
 *  a caller that owes its invoker a return. stdout.isTTY is undefined off a terminal, hence === true. */
export function shouldFollow(): boolean {
  return !isCaptured() && process.stdout.isTTY === true;
}

/** Machine-readable output: JSON, a token, a path. Goes to stdout on a terminal so it can
 *  be piped, and into the sink when captured — the framework's own documents, written the
 *  way they were built. */
export function emit(text: string): void {
  emitRaw(text);
}

/** How many chunks of machine-readable output (emit/emitRaw) have been produced so far.
 *  entry/cli.ts uses the delta to keep its one --json failure contract honest: an error
 *  document is printed only when the command printed no document of its own first. */
export function machineWritesCount(): number {
  return machineWrites;
}

/** A foreign byte stream: a container's stdout, a secret, a log, a shell completion
 *  script — data that must arrive byte for byte, which is also why emit() and this are the
 *  same write and differ only in what a caller puts through them. */
export function emitRaw(text: string): void {
  machineWrites += 1;
  machineSink?.(text);
  if (sink !== undefined) sink(text);
  else {
    stdoutBytes += Buffer.byteLength(text);
    process.stdout.write(text);
  }
}

/** Bytes a streaming child wrote straight to the real stdout (transport/exec.ts's forwarders
 *  and protocol relay), recorded here so entry/cli.ts's --json failure contract can tell
 *  "the command already produced output" even when nothing went through emit/emitRaw. */
export function recordStreamedStdout(bytes: number): void {
  stdoutBytes += bytes;
}

/** Bytes that really reached process.stdout so far — emitRaw without a sink plus the
 *  recorded stream forwards. Real stdout only: output captured into a sink (MCP, a test)
 *  never competes with the failure contract's document on stdout. */
export function stdoutBytesWritten(): number {
  return stdoutBytes;
}

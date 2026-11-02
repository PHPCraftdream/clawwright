// The one POSIX shell quoting rule every transport, staging script and CLI batcher
// depends on for argument safety. A second copy that drifts from this one is a shell
// injection waiting on whichever caller kept the stale version.

/** Quotes one value for a POSIX shell command. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

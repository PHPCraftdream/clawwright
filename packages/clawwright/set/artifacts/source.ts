// Where the set-owned files are read from, which is not always the deployment directory.
//
// A deployment directory holds two unlike things side by side: the set (recipes, config
// declaration) and the instance (.env, secret stores, lock, built artifacts). Installing
// from an artifact means reading the first from somewhere else while the second stays put
// — swapping the whole deployment directory instead would be wrong: `secrets --apply`
// would look for its store inside the unpacked artifact, and the lock would be written there.
//
// Process-wide, like the active deployment itself: the alternative is threading a source
// through every function that reads a recipe, including ones that have no idea a set exists.

let active: string | undefined;

/** Reads the set from `directory` until `clearSetSource()`. */
export function useSetSource(directory: string): void {
  active = directory;
}

export function clearSetSource(): void {
  active = undefined;
}

/** The directory the set is being read from, or undefined when it is the deployment's own. */
export function setSourceDir(): string | undefined {
  return active;
}

/** Runs `body` with the set read from `directory`, restoring whatever was in force
 *  afterwards — even on throw, since a stale source pointing at a deleted temp directory
 *  would break every later read. */
export async function withSetSource<T>(directory: string, body: () => Promise<T>): Promise<T> {
  const previous = active;
  active = directory;
  try {
    return await body();
  } finally {
    active = previous;
  }
}

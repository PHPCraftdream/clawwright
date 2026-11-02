// Names that become paths.
//
// A deployment, a recipe and a secret store are all chosen by the caller and then turned
// into a file path. Without a check, `--store ../../other/local` reads another deployment's
// credentials, and `--app ..` escapes apps/ entirely. The rule is deliberately narrow: these
// names also become compose project names, which accept a short alphabet anyway. The grammars
// are split by who mints the name: readName is the reader grammar (everything already on disk
// stays readable), createName the creator grammar (device names refused with their own reason).
// The branded constructors readName/createName are the only way to mint a NameOf<K>; the
// untyped wrappers safeName/newName delegate to them for call sites not yet migrated.

const PATTERN = /^[a-z][a-z0-9-]*$/;
const MAX_LENGTH = 64;

// These names are refused when a name is MINTED (newName), never when one is read (safeName):
// a deployment, record or artifact named before the device rule must stay addressable.
const DEVICE_NAMES = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

/** Returns the name if it is safe to use as a path segment, throws otherwise. */
export function invalidNameMessage(kind: string, value: string): string {
  return `invalid ${kind} name "${value}" — use lowercase letters, digits and dashes, starting with a letter`;
}

/** The creator-side refusal: the pattern accepts this name, Windows does not. */
export function reservedNameMessage(kind: string, value: string): string {
  return `${kind} name "${value}" is reserved on Windows (con, prn, aux, nul, com1-9, lpt1-9) — choose a name every host can open`;
}

/** The kinds of names that become path segments. */
export type NameKind = "deployment" | "recipe" | "set" | "store" | "agent" | "owned-object";

type Branded<K extends NameKind> = { readonly __name: K };
export type NameOf<K extends NameKind> = string & Branded<K>;

// readName/createName below are the only constructors of these brands.
export type DeploymentName = NameOf<"deployment">;
export type RecipeName = NameOf<"recipe">;
export type SetName = NameOf<"set">;
export type StoreName = NameOf<"store">;
export type AgentName = NameOf<"agent">;
export type OwnedObjectName = NameOf<"owned-object">;

/** Returns the name if it is safe to use as a path segment, throws otherwise. */
export function readName<K extends NameKind>(kind: K, value: string): NameOf<K> {
  if (value.length > MAX_LENGTH) {
    throw new Error(`${kind} name is too long (max ${MAX_LENGTH} characters)`);
  }
  if (!PATTERN.test(value)) {
    throw new Error(invalidNameMessage(kind, value));
  }
  return value as NameOf<K>;
}

/** A name about to be minted — a new deployment, recipe, set, store, agent: readName, plus
 *  the Windows device names. Readers keep readName, so names that predate the device rule
 *  stay readable. */
export function createName<K extends NameKind>(kind: K, value: string): NameOf<K> {
  const safe = readName(kind, value);
  if (DEVICE_NAMES.has(safe.toLowerCase())) {
    throw new Error(reservedNameMessage(kind, value));
  }
  return safe;
}

/** Untyped wrapper over readName (reader grammar). */
export function safeName(kind: string, value: string): string {
  return readName(kind as NameKind, value);
}

/** Untyped wrapper over createName — reader grammar plus the Windows device names. */
export function newName(kind: string, value: string): string {
  return createName(kind as NameKind, value);
}

/** True when the text holds a C0/C1 control character or DEL (checked by code unit, not by regex). */
export function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit <= 0x1f || (unit >= 0x7f && unit <= 0x9f)) return true;
  }
  return false;
}

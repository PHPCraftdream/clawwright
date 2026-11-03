// Recipe actions: operator-facing operations a recipe.json may declare, each backed by a
// file inside the recipe directory. Declaration-only parsing here; the later action-running
// chunks consume the map.

import { resolve, sep } from "node:path";

export interface RecipeActionArgument {
  readonly name: string;
  readonly kind: "text" | "integer" | "choice" | "flag";
  readonly optional?: boolean;
  readonly choices?: readonly string[];
  readonly description?: string;
}

export interface RecipeActionDeclaration {
  readonly file: string;
  readonly effect: "read" | "change" | "destroy";
  readonly description?: string;
  readonly arguments: readonly RecipeActionArgument[];
}

const ACTION_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const ARGUMENT_NAME = /^[a-z][a-zA-Z0-9]*$/;
const EFFECTS = ["read", "change", "destroy"] as const;
const KINDS = ["text", "integer", "choice", "flag"] as const;
const MAX_CHOICE_ENTRIES = 32;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], at: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${at} has an unknown key ${key}`);
  }
}

function optionalString(value: unknown, at: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "") throw new Error(`${at} must be a non-empty string`);
  if (value.length > 200) throw new Error(`${at} must be at most 200 characters`);
  return value;
}

function parseArgument(recipe: string, action: string, value: unknown, index: number): RecipeActionArgument {
  const at = `recipes/${recipe}/recipe.json: actions.${action}.arguments[${index}]`;
  if (!isPlainObject(value)) throw new Error(`${at} must be an object`);
  exactKeys(value, ["name", "kind", "optional", "choices", "description"], at);
  const { name, kind, optional, choices, description } = value;
  if (typeof name !== "string" || !ARGUMENT_NAME.test(name) || name.length > 40) {
    throw new Error(`${at}.name must match ^[a-z][a-zA-Z0-9]*$ and be at most 40 characters`);
  }
  if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) {
    throw new Error(`${at}.kind must be one of text, integer, choice, flag`);
  }
  if (optional !== undefined && typeof optional !== "boolean") throw new Error(`${at}.optional must be a boolean`);
  if (kind === "choice") {
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new Error(`${at}.choices must be a non-empty array for kind choice`);
    }
    const seen = new Set<string>();
    if (choices.length > MAX_CHOICE_ENTRIES) {
      throw new Error(`${at}.choices must have at most 32 entries`);
    }
    for (const entry of choices) {
      if (typeof entry !== "string" || entry === "" || entry.length > 64) {
        throw new Error(`${at}.choices entries must be non-empty strings of at most 64 characters`);
      }
      if (seen.has(entry)) throw new Error(`${at}.choices contains the duplicate entry ${entry}`);
      seen.add(entry);
    }
  } else if (choices !== undefined) {
    throw new Error(`${at}.choices is only allowed for kind choice`);
  }
  const parsed: RecipeActionArgument = {
    name,
    kind: kind as RecipeActionArgument["kind"],
    ...(optional === true ? { optional: true } : {}),
    ...(Array.isArray(choices) ? { choices: Object.freeze([...choices] as string[]) } : {}),
    ...(description === undefined ? {} : { description: optionalString(description, `${at}.description`) }),
  };
  return parsed;
}

function parseAction(recipe: string, name: string, value: unknown): RecipeActionDeclaration {
  const at = `recipes/${recipe}/recipe.json: actions.${name}`;
  if (!isPlainObject(value)) throw new Error(`${at} must be an object`);
  exactKeys(value, ["file", "effect", "description", "arguments"], at);
  const { file, effect, description, arguments: args } = value;
  if (typeof file !== "string" || file === "") throw new Error(`${at}.file must be a non-empty string`);
  if (file.length > 200) throw new Error(`${at}.file must be at most 200 characters`);
  if (file.startsWith("/") || file.includes("\\") || /^[a-zA-Z]:/.test(file)) {
    throw new Error(`${at}.file must be a relative path without drive letters or backslashes`);
  }
  const segments = file.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${at}.file must stay inside the recipe directory`);
  }
  if (!file.endsWith(".ts")) throw new Error(`${at}.file must end with .ts`);
  if (typeof effect !== "string" || !(EFFECTS as readonly string[]).includes(effect)) {
    throw new Error(`${at}.effect must be one of read, change, destroy`);
  }
  if (!Array.isArray(args)) throw new Error(`${at}.arguments must be an array`);
  if (args.length > 16) throw new Error(`${at}.arguments must have at most 16 entries`);
  const seen = new Set<string>();
  const parsedArguments = args.map((entry, index) => {
    const argument = parseArgument(recipe, name, entry, index);
    if (seen.has(argument.name)) throw new Error(`${at}.arguments contains the duplicate name ${argument.name}`);
    seen.add(argument.name);
    return argument;
  });
  const declaration: RecipeActionDeclaration = {
    file,
    effect: effect as RecipeActionDeclaration["effect"],
    ...(description === undefined ? {} : { description: optionalString(description, `${at}.description`) }),
    arguments: Object.freeze(parsedArguments),
  };
  return declaration;
}

export function parseRecipeActions(recipe: string, value: unknown): ReadonlyMap<string, RecipeActionDeclaration> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new Error(`recipes/${recipe}/recipe.json: actions must be an object`);
  }
  const names = Object.keys(value);
  if (names.length > 16) {
    throw new Error(`recipes/${recipe}/recipe.json: actions must declare at most 16 actions`);
  }
  const actions = new Map<string, RecipeActionDeclaration>();
  for (const name of names) {
    if (name.length > 40 || !ACTION_NAME.test(name)) {
      throw new Error(`recipes/${recipe}/recipe.json: actions key ${name} must match ^[a-z][a-z0-9]*(-[a-z0-9]+)*$ and be at most 40 characters`);
    }
    actions.set(name, parseAction(recipe, name, value[name]));
  }
  for (const [name, declaration] of actions) actions.set(name, Object.freeze(declaration));
  return actions;
}

/** Containment check the loader cannot do before it knows the directory: the resolved file
 *  must stay inside it, with a segment boundary so a sibling prefix cannot pass. */
export function resolveRecipeActionFile(directory: string, file: string): string {
  const root = resolve(directory);
  const resolved = resolve(root, file);
  const inside = resolved === root || resolved.startsWith(root + sep);
  if (!inside) throw new Error(`recipe action file ${file} resolves outside the recipe directory`);
  return resolved;
}

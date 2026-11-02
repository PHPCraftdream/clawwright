// What a call does to state, derived from the declaration: the confirmation an MCP call
// owes, whether it changed anything, the markers help and the tool schema print.
//
// A legacy command (run + the three argv predicates) is read exactly as the surfaces always
// read it; a spec shape (effect on the body, an action or a flag) by the rules of the model.

import type { AppCommand, CommandArgument } from "#src/core/app.ts";
import { parseCall, parseDeclaredArgs } from "#src/core/command/parse/index.ts";
import { specOf, specShape } from "#src/core/command/spec.ts";
import type { ArgumentSpec, Effect } from "#src/core/command/spec.ts";

/** The per-call effect resolver an EffectShape or one action may declare: returns the call's
 *  actual effect once its values are known, or undefined to keep the static facts. */
export interface EffectResolverResult {
  readonly effect: Effect;
  /** Set only by the per-call resolver: this call owes an MCP confirmation even though its effect is not destroy. */
  readonly confirm?: boolean;
}
export type EffectOf = (values: Readonly<Record<string, unknown>>, given: readonly string[]) => Promise<EffectResolverResult | undefined>;

/** `changed` is only what a command's own `changedWhen` says; absent otherwise.
 *  `confirm` is set only by the per-call resolver: the call owes an MCP confirmation even
 *  though its effect is not destroy. */
export interface CallFacts {
  readonly effect: Effect;
  readonly changed?: boolean;
  readonly confirm?: boolean;
}

/** `alwaysDestroys`: every call destroys (no read form). `byAction`: the effect depends on the action word. */
export interface EffectProfile {
  readonly destructive: boolean;
  readonly alwaysDestroys: boolean;
  readonly byAction: boolean;
}

const RANK: Readonly<Record<Effect, number>> = { read: 0, change: 1, destroy: 2 };

function strongest(effects: readonly Effect[]): Effect {
  return effects.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
}

/** One entry point for the surfaces. A spec command: its argv is parsed (a refusal throws) and
 *  the model's rules apply. A legacy command: `read` when it is readOnly or readOnlyWhen says
 *  so; `destroy` when it is destructive and requiresConfirmationWhen (else: not read) says so. */
export function callFactsFor(command: AppCommand, argv: readonly string[]): CallFacts {
  const entry = specOf(command);
  if (entry !== undefined) return callFacts(specShape(entry), parseCall(specShape(entry), argv));
  const args = [...argv];
  const read = command.readOnly === true || command.readOnlyWhen?.(args) === true;
  const destroy = command.destructive === true && (command.requiresConfirmationWhen?.(args) ?? !read);
  const effect: Effect = destroy ? "destroy" : read ? "read" : "change";
  const changed = command.changedWhen?.(args);
  return changed === undefined ? { effect } : { effect, changed };
}

/** The effect-relevant part of a command declaration — an AppCommand and the MCP tool's
 *  Declared all satisfy it. `run` is only a marker: specOf answers a body only while the
 *  command's run is a materialized one (gate commands included, design D6 — no second
 *  `effect` field: the facade's body is the one declaration). */
export interface EffectDeclaration {
  readonly destructive?: boolean;
  readonly readOnlyWhen?: (args: string[]) => boolean;
  readonly requiresConfirmationWhen?: (args: string[]) => boolean;
  readonly arguments?: readonly CommandArgument[];
  readonly run?: unknown;
}

/** The static profile, as the list markers, the `--help` note and the `confirm` schema field read it. */
export function effectProfile(command: EffectDeclaration): EffectProfile {
  const entry = specOf(command);
  if (entry !== undefined) return shapeProfile(specShape(entry));
  const destructive = command.destructive === true;
  return {
    destructive,
    alwaysDestroys: destructive && command.readOnlyWhen === undefined && command.requiresConfirmationWhen === undefined,
    byAction: (command.arguments ?? []).some((argument) => argument.actions !== undefined),
  };
}

/** The effect-relevant part of a spec: the body's effect, per-action effects, flag effects. */
export interface EffectShape {
  readonly effect: Effect;
  /** Single bodies only: the per-call resolver (a multi-action body puts one on each action). */
  readonly effectOf?: EffectOf;
  readonly arguments?: readonly ArgumentSpec[];
  readonly actions?: Readonly<Record<string, { readonly effect?: Effect; readonly arguments?: readonly ArgumentSpec[]; readonly effectOf?: EffectOf }>>;
}

function flagEffects(args: readonly ArgumentSpec[] | undefined): Effect[] {
  return (args ?? []).flatMap((argument) => (argument.kind === "flag" && argument.effect !== undefined ? [argument.effect] : []));
}

/** One call's effect: the action's (else the body's) base, `read` if a flag declared `read`
 *  was given, otherwise the strongest of the base and the given flags' effects. */
export function callFacts(shape: EffectShape, call: { readonly action?: string; readonly given: readonly string[] }): CallFacts {
  const own = call.action === undefined ? undefined : shape.actions?.[call.action];
  const base = own?.effect ?? shape.effect;
  const args = own === undefined ? shape.arguments : own.arguments;
  const given = (args ?? []).flatMap((argument) => (argument.kind === "flag" && argument.effect !== undefined && call.given.includes(argument.name) ? [argument.effect] : []));
  return { effect: given.includes("read") ? "read" : strongest([base, ...given]) };
}

/** A spec's static profile: `destructive` if some action's base or some flag is destroy,
 *  `alwaysDestroys` if every action's base is destroy and no flag offers a read form. */
export function shapeProfile(shape: EffectShape): EffectProfile {
  const parts = shape.actions === undefined ? [shape] : Object.values(shape.actions);
  const bases = parts.map((part) => part.effect ?? shape.effect);
  const flags = parts.flatMap((part) => flagEffects(part.arguments));
  return {
    destructive: bases.includes("destroy") || flags.includes("destroy"),
    alwaysDestroys: bases.every((base) => base === "destroy") && !flags.includes("read"),
    byAction: shape.actions !== undefined,
  };
}

/** Whether a `preparesEnvironment` command's preparation (writing .env, generating the token)
 *  should run for `args`: false for a read-only call (readOnlyWhen, e.g. `bootstrap --check`).
 *  Argv the command's parser refuses throws here, before anything is written, so an invalid
 *  flag is reported as such and creates nothing. */
export function legacyPreparesEnvironment(command: AppCommand, args: readonly string[]): boolean {
  if (command.preparesEnvironment !== true) return false;
  if (command.readOnlyWhen?.([...args]) === true) return false;
  parseDeclaredArgs(command.arguments ?? [], args);
  return true;
}

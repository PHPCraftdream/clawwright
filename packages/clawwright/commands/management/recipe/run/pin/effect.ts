import type { EffectOf } from "#src/core/command/effect.ts";
export const resolveRecipePinEffectOf: EffectOf = async (values) =>
  values.apply === true ? { effect: "change", confirm: true } : { effect: "read" };

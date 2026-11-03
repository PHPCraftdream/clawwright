// ARGUMENT_ERROR_TOKEN stays here: the private token ArgumentError's constructor demands,
// so only the command layer's own modules (the binder, prepare's refuse/derive, the pipeline)
// can build one; the classes stay exported for instanceof.
export {
  CONFIRM_REQUIRED, ConfirmationRequiredError, LateArgumentError, UNKNOWN_ARGUMENT,
  UnknownActionError, UnknownArgumentError, ArgumentError, closestCommand,
  dieUnknownAction, dieUnknownArgument, didYouMeanSuffix, unknownArgumentMessage,
} from "#src/core/command/errors.ts";
export * from "#src/core/command/parse/index.ts";
export * from "#src/core/command/parse/scan.ts";
export * from "#src/core/command/view.ts";
export * from "#src/core/command/effect.ts";
// spec.ts's surface is re-exported EXPLICITLY (stage 7 S2.5): `export *` leaked `prepared`,
// the prepare-phase internal, to every importer of the barrel. New spec symbols must be
// added here by hand — the architecture ratchet `preparedOutsideCommand` backs this up.
export {
  CommandDeclarationError,
  type ArgumentRule, type ArgumentSpec, type DeploymentScope, type Effect, type ExitCode,
  type LocalScope, type NothingScope, type PrepareCall, type Values,
  commandBody, defineAction, materializeCommands, materializeGateRun, multiActionBody, NOTHING,
  runOnContext,
  specData, specOf, specShape,
} from "#src/core/command/spec.ts";

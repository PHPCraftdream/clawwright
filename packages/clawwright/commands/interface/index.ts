// The command set the framework offers for an OpenClaw-style service.
//
// A deployment lists these under its own name; it does not reimplement them. Argument
// descriptions live here too — they are what `--help`, MCP tool schemas and MCP call argv
// are all generated from, so every entry must match what the command's own parser accepts.
// An argument the parser knows and this list does not is invisible over MCP; the reverse is
// a call that fails.
//
// `details` is optional longer text for `help <command>` and the MCP tool
// description — used only when the name and summary do not already say everything.
//
// Split by command family so no one file holds every entry; each fragment owns its own
// imports, merged back into one object below.

import type { AppCommand } from "#src/core/app.ts";
import { lifecycleCommands } from "./groups/openclawCommands.lifecycle.ts";
import { orchestrationCommands } from "./groups/openclawCommands.orchestration.ts";
import { operateCommands } from "./groups/openclawCommands.operate.ts";
import { managementCommands } from "./groups/openclawCommands.management.ts";
import { setsCommands } from "./groups/openclawCommands.sets.ts";

export const openclawCommands: Record<string, AppCommand> = {
  ...lifecycleCommands,
  ...orchestrationCommands,
  ...operateCommands,
  ...managementCommands,
  ...setsCommands,
};

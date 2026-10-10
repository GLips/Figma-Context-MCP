import type { Command } from "cleye";
import { executeCommand } from "~/commercial/commands/execute.js";
import { referenceCommand } from "~/commercial/commands/reference.js";
import { commentsCommand } from "./comments.js";
import { fetchCommand } from "./fetch.js";

export const CLI_COMMANDS: Command[] = [
  fetchCommand,
  commentsCommand,
  executeCommand,
  referenceCommand,
];

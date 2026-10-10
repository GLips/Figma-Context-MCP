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

type CliCounterpart = { command: string; via?: string } | { exempt: string };

/**
 * Policy: the CLI does every job the MCP server does, so an agent with only a shell loses nothing.
 * Every MCP tool, code-mode ones included, needs an entry here; a test fails on a tool with no entry,
 * an entry for a tool that no longer exists, or a command that isn't registered.
 */
export const MCP_TOOL_CLI_COUNTERPARTS: Record<string, CliCounterpart> = {
  get_figma_data: { command: "fetch" },
  get_figma_comments: { command: "comments" },
  download_figma_images: {
    exempt: "No CLI command yet; whether image downloads need one is an open product decision.",
  },
  figma_execute_code: { command: "execute" },
  get_screenshot: { command: "execute", via: "--screenshot" },
  get_flcm_reference: { command: "reference" },
};

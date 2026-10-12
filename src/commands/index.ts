import type { Command } from "cleye";
import { executeCommand } from "~/commercial/commands/execute.js";
import { referenceCommand } from "~/commercial/commands/reference.js";
import { uploadCommand } from "~/commercial/commands/upload.js";
import { commentsCommand } from "./comments.js";
import { fetchCommand } from "./fetch.js";

export const CLI_COMMANDS: Command[] = [
  fetchCommand,
  commentsCommand,
  executeCommand,
  referenceCommand,
  uploadCommand,
];

/**
 * A tool's CLI counterpart, capability by capability: every input the tool takes names the flag
 * (`--kebab-case`) or positional (as the command declares it, e.g. `<script>`) that carries it.
 * `figmaRest` marks a tool whose server-side run spends the server's Figma credential, so its
 * command must accept one too.
 */
type CliCounterpart =
  | { command: string; inputs: Record<string, string>; figmaRest?: true }
  | { exempt: string };

/**
 * Policy: the CLI does every job the MCP server does, so an agent with only a shell loses nothing.
 * Every MCP tool, code-mode ones included, needs an entry here; a test fails on a tool with no entry,
 * an entry for a tool that no longer exists, a tool input with no CLI carrier, or a carrier the
 * command doesn't declare.
 */
export const MCP_TOOL_CLI_COUNTERPARTS: Record<string, CliCounterpart> = {
  get_figma_data: {
    command: "fetch",
    inputs: { fileKey: "--file-key", nodeId: "--node-id", depth: "--depth" },
    figmaRest: true,
  },
  get_figma_comments: {
    command: "comments",
    inputs: {
      fileKey: "--file-key",
      scope: "--node-id",
      include: "--full",
      status: "--all",
      since: "--since",
    },
    figmaRest: true,
  },
  download_figma_images: {
    exempt: "No CLI command yet; whether image downloads need one is an open product decision.",
  },
  // Inline code has no shell form worth having: a shell writes the file and passes it.
  figma_execute_code: {
    command: "execute",
    inputs: { code: "<script>", scriptPath: "<script>" },
    figmaRest: true,
  },
  get_screenshot: {
    command: "execute",
    inputs: {
      nodeId: "--node-id",
      key: "--key",
      context: "--context",
      margin: "--margin",
      scale: "--scale",
    },
  },
  get_flcm_reference: { command: "reference", inputs: { sections: "[sections...]" } },
};

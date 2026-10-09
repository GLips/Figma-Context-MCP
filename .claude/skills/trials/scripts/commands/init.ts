import { defineCommand } from "citty";
import { DEFAULT_MCP_URL, SCRATCH_DIR } from "../lib/paths.ts";
import { scratchTrusted, TRUST_INSTRUCTIONS, writeScratchDir } from "../lib/scratch.ts";

export default defineCommand({
  meta: {
    name: "init",
    description: `Write the trial agent's scratch dir (${SCRATCH_DIR}): a .mcp.json with only the framelink server and settings that switch every other MCP server off. Idempotent; re-run after adding user-scope servers.`,
  },
  args: {
    "mcp-url": {
      type: "string",
      description: "Framelink MCP endpoint to put in .mcp.json",
      default: DEFAULT_MCP_URL,
    },
  },
  run({ args }) {
    writeScratchDir(args["mcp-url"] as string);
    process.stderr.write(`Wrote ${SCRATCH_DIR}/.mcp.json and .claude/settings.json\n`);
    if (scratchTrusted()) {
      process.stderr.write("Scratch dir is trusted — runs are prompt-free.\n");
    } else {
      process.stderr.write(TRUST_INSTRUCTIONS + "\n");
    }
  },
});

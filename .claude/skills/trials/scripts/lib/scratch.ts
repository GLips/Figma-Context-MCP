import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MCP_SERVER_NAME, RENDERS_DIR, SCRATCH_DIR } from "./paths.ts";

// claude.ai connectors don't appear in ~/.claude.json's mcpServers, so they're
// named here; the user-scope servers are read from that file at write time.
const CLAUDE_AI_CONNECTORS = [
  "claude.ai Gmail",
  "claude.ai Google Drive",
  "claude.ai Google Calendar",
];

export function writeScratchDir(mcpUrl: string): void {
  mkdirSync(join(SCRATCH_DIR, ".claude"), { recursive: true });
  mkdirSync(RENDERS_DIR, { recursive: true });

  writeFileSync(
    join(SCRATCH_DIR, ".mcp.json"),
    JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: "http", url: mcpUrl } } }, null, 2) +
      "\n",
  );

  // Once Graham trusts the folder, these are honored: the .mcp.json server is
  // approved without a prompt and every user-scope server is switched off, so
  // the trial agent's tools/list is framelink's and nothing else.
  const settings = {
    enableAllProjectMcpServers: true,
    disabledMcpServers: [...userScopeMcpServerNames(), ...CLAUDE_AI_CONNECTORS],
    permissions: { allow: [`mcp__${MCP_SERVER_NAME}__*`] },
  };
  writeFileSync(
    join(SCRATCH_DIR, ".claude", "settings.json"),
    JSON.stringify(settings, null, 2) + "\n",
  );
}

// Read-only look at Claude Code's state: has the trust dialog been accepted for
// the scratch dir? Keyed by realpath because that's how Claude records it.
export function scratchTrusted(): boolean {
  const statePath = join(homedir(), ".claude.json");
  if (!existsSync(statePath) || !existsSync(SCRATCH_DIR)) return false;
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const entry = state.projects?.[realpathSync(SCRATCH_DIR)];
  return entry?.hasTrustDialogAccepted === true;
}

function userScopeMcpServerNames(): string[] {
  const statePath = join(homedir(), ".claude.json");
  if (!existsSync(statePath)) return [];
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  return Object.keys(state.mcpServers ?? {});
}

export const TRUST_INSTRUCTIONS = `The scratch dir is not trusted yet. Once, by hand:
  cd ${SCRATCH_DIR} && claude
then accept the trust dialog and approve the ${MCP_SERVER_NAME} server. After that every run is prompt-free.`;

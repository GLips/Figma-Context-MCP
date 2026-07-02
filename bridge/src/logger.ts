// In stdio mode, stdout is reserved for the MCP protocol stream — any stray write
// there corrupts the JSON-RPC framing. All human-facing logging goes to stderr.
export function log(message: string): void {
  process.stderr.write(`[bridge] ${message}\n`);
}

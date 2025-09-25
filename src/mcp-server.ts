// Re-export server-related functionality for users who want MCP server capabilities
export { createServer } from "./mcp/index.js";
export type { FigmaService } from "./services/figma.js";
export { getServerConfig } from "./config.js";
export { startServer, startHttpServer, stopHttpServer } from "./server.js";

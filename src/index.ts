// Re-export the server and its types
export { FigmaMcpServer } from "./server.js";
export type { SimplifiedDesign } from "./services/simplify-node-response.js";
export type { FigmaService } from "./services/figma.js";
export { getServerConfig } from "./config.js";
export { startServer } from "./cli.js";

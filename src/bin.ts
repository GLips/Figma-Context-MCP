#!/usr/bin/env node

import { config } from "dotenv";
import { resolve } from "path";
import { startServer } from "./server.js";

// Load .env from the current working directory
config({ path: resolve(process.cwd(), ".env") });

// Start the server immediately - this file is only for execution
startServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});

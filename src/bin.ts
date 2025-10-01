#!/usr/bin/env node

import { startServerConfigurable } from "./server.js";
import { executeOnce } from "./exec-mode.js";
import { getParsedArgs, getServerConfig } from "./config.js";

const argv = getParsedArgs();

// Route to exec mode or server mode
const execUrl = argv.exec || argv.e;

if (execUrl) {
  // Exec mode: one-off data fetch, then exit
  const config = getServerConfig(argv, false, true);
  executeOnce(execUrl, config.auth, config.outputFormat).catch((error) => {
    console.error("Failed to execute:", error);
    process.exit(1);
  });
} else {
  // Server mode (stdio or HTTP)
  const isStdioMode = process.env.NODE_ENV === "cli" || argv.stdio === true;

  startServerConfigurable(argv, isStdioMode).catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
  });
}

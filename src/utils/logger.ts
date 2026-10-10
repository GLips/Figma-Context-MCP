import fs from "fs";

/* eslint-disable @typescript-eslint/no-explicit-any -- logging accepts arbitrary values */
// Silent until a composition root turns it on: the embeddable read entry must print nothing (log
// lines carry endpoints and file keys) unless its host asks. The CLI and `createServer` enable it.
export const Logger = {
  enabled: false,
  isHTTP: false,
  log: (...args: any[]) => {
    if (!Logger.enabled) return;
    if (Logger.isHTTP) {
      console.log("[INFO]", ...args);
    } else {
      console.error("[INFO]", ...args);
    }
  },
  error: (...args: any[]) => {
    if (!Logger.enabled) return;
    console.error("[ERROR]", ...args);
  },
};
/* eslint-enable @typescript-eslint/no-explicit-any */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- writes arbitrary debug data
export function writeLogs(name: string, value: any): void {
  if (process.env.NODE_ENV !== "development" || !Logger.enabled) return;

  try {
    const logsDir = "logs";
    const logPath = `${logsDir}/${name}`;

    // Check if we can write to the current directory
    fs.accessSync(process.cwd(), fs.constants.W_OK);

    // Create logs directory if it doesn't exist
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    fs.writeFileSync(logPath, JSON.stringify(value, null, 2));
    Logger.log(`Debug log written to: ${logPath}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    Logger.log(`Failed to write logs to ${name}: ${errorMessage}`);
  }
}

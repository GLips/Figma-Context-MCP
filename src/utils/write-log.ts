import { Logger } from "./logger.js";
import path from "path";
import fs from "fs";
import yaml from "js-yaml";

export function writeJSON2YamlLogs(name: string, value: Record<string, any>) {
  if (process.env.NODE_ENV !== "development") return;
  const result = yaml.dump(value);
  writeLogs(name, result);
}

export function writeLogs(name: string, value: any) {
  try {
    if (process.env.NODE_ENV !== "development") return;

    const logsCWD = process.env.LOG_DIR || process.cwd();
    const logsDir = path.resolve(logsCWD, "logs");

    try {
      fs.accessSync(logsCWD, fs.constants.W_OK);
    } catch (error) {
      Logger.log("Failed to write logs:", error);
      return;
    }

    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir);
    }
    const filePath = path.resolve(logsDir, `${name}`);
    fs.writeFileSync(filePath, value);
    console.log(`Wrote ${name} to ${filePath}`);
  } catch (error) {
    console.debug("Failed to write logs:", error);
  }
}

/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// A saved flcm script: the body of an async function in a .js file, run by `execute <file>` and by
// figma_execute_code's scriptPath. A script with an address lets a caller fix one line and resend a
// path, instead of resending the whole script after every rejection.
import { extname } from "node:path";
import type { ContainedFileReader } from "./contained-file.js";

// Far above any hand-authored script (a 9k-token script is ~40KB); the cap bounds the read buffer.
const MAX_SCRIPT_BYTES = 1024 * 1024;

/** Both entry points accept only `.js`, so a mistyped path to some other file is refused before it is read. */
export function isSavedScriptPath(path: string): boolean {
  return extname(path) === ".js";
}

/**
 * The MCP reader. Unlike the CLI, whose operator names the file on their own command line, a
 * scriptPath comes from whatever can call the server's tools, so it is contained under the same asset
 * root as flcm.image paths. Relative paths resolve against that root.
 */
export function createSavedScriptReader(
  readContained: ContainedFileReader,
): (scriptPath: string) => Promise<string> {
  return async function readSavedScript(scriptPath: string): Promise<string> {
    try {
      if (!isSavedScriptPath(scriptPath)) throw new Error("only .js files are run");
      const bytes = await readContained(scriptPath, { maxBytes: MAX_SCRIPT_BYTES });
      return Buffer.from(bytes).toString("utf8");
    } catch (err) {
      // Trailing period dropped so callers can continue the sentence.
      const reason = (err instanceof Error ? err.message : String(err)).replace(/\.$/, "");
      throw new Error(`could not read scriptPath ${JSON.stringify(scriptPath)}: ${reason}`);
    }
  };
}

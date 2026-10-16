/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// When a plugin link last authenticated with any server on this state dir. The only cross-process
// evidence a starting server has that a plugin is around: every other signal is per-process state a
// restart clears to "no plugin has ever been here", indistinguishable from a cold start.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Logger } from "~/utils/logger.js";
import { resolveStateDir, writePrivateFileAtomic } from "~/commercial/state-dir.js";

const SIGHTING_FILE = "plugin-sighting.json";

// Sized to span the quiet gaps inside one working session while expiring long before "closed Figma
// and moved on". Too generous only shows a few extra tools; too strict reports a live capability as
// absent — so it leans long.
const RECENT_SIGHTING_MS = 30 * 60 * 1000;

/** Record that a plugin link authenticated now. Best effort: a lost sighting only hides tools. */
export function recordPluginSighting(now = Date.now()): void {
  try {
    writePrivateFileAtomic(join(resolveStateDir(), SIGHTING_FILE), JSON.stringify({ at: now }));
  } catch (error) {
    Logger.log(`Couldn't record the plugin sighting: ${(error as Error).message}`);
  }
}

/** Whether a plugin authenticated with a server on this state dir within the recent window. */
export function pluginSeenRecently(now = Date.now()): boolean {
  try {
    const { at } = JSON.parse(readFileSync(join(resolveStateDir(), SIGHTING_FILE), "utf8")) as {
      at?: unknown;
    };
    return typeof at === "number" && now - at <= RECENT_SIGHTING_MS;
  } catch {
    return false;
  }
}

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { SceneNodeLike } from "@framelink/plugin/node-to-snapshot";

/**
 * Committed plugin-native fixtures — one <name>.json per parity case that has one, each a
 * `SceneNodeLike[]` of root nodes exactly as the plugin API shapes them (RGB solids with paint-level
 * opacity, `gradientTransform` matrices, `imageHash`). The `scene` producer feeds these through the
 * REAL `sceneNodeToSnapshot`, so the adapter's decode — not a stand-in — is what parity gates.
 *
 * A case without a fixture returns null and the producer skips it (the harness's documented
 * light-up-as-they-land contract); fixtures accrete as the adapter grows (TEXT lands in slice 2b).
 */
const SCENES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "scenes");

export function loadScene(name: string): SceneNodeLike[] | null {
  const file = path.join(SCENES_DIR, `${name}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as SceneNodeLike[];
}

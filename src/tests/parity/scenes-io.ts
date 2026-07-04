import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type {
  SceneNodeLike,
  SceneStyleResolver,
  SceneTextSegment,
} from "@framelink/plugin/node-to-snapshot";

/**
 * Committed plugin-native fixtures — one <name>.json per parity case, each a
 * `{ styles?, nodes }` file whose nodes are shaped exactly as the plugin API shapes them (RGB solids
 * with paint-level opacity, `gradientTransform` matrices, `imageHash`). The `scene` producer feeds
 * these through the REAL `sceneNodeToSnapshot`, so the adapter's decode — not a stand-in — is what
 * parity gates.
 *
 * JSON can't carry the parts of the plugin surface that aren't data, so the loader revives them:
 *   - `styledTextSegments` (an array in the file) becomes the node's `getStyledTextSegments` method
 *   - `mainComponentId` (a string) becomes `getMainComponentAsync`
 *   - the literal string "figma:mixed" becomes a symbol, the adapter's `figma.mixed` signal
 *   - the top-level `styles` table (id → { name }) backs the returned style resolver
 *
 * A case without a fixture returns null and the producer skips it (the harness's documented
 * light-up-as-they-land contract).
 */
const SCENES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "scenes");

const MIXED_SENTINEL = "figma:mixed";
const MIXED = Symbol("figma.mixed");

interface SceneFixtureNode {
  [key: string]: unknown;
  children?: SceneFixtureNode[];
  styledTextSegments?: SceneTextSegment[];
  mainComponentId?: string;
}

interface SceneFixtureFile {
  styles?: Record<string, { name: string }>;
  nodes: SceneFixtureNode[];
}

export interface LoadedScene {
  roots: SceneNodeLike[];
  resolveStyle: SceneStyleResolver;
}

function reviveNode(raw: SceneFixtureNode): SceneNodeLike {
  const { styledTextSegments, mainComponentId, children, ...rest } = raw;
  const node: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    node[key] = value === MIXED_SENTINEL ? MIXED : value;
  }
  if (children) node.children = children.map(reviveNode);
  if (styledTextSegments) node.getStyledTextSegments = () => styledTextSegments;
  if (mainComponentId) node.getMainComponentAsync = async () => ({ id: mainComponentId });
  return node as unknown as SceneNodeLike;
}

export function loadScene(name: string): LoadedScene | null {
  const file = path.join(SCENES_DIR, `${name}.json`);
  if (!existsSync(file)) return null;
  const fixture = JSON.parse(readFileSync(file, "utf8")) as SceneFixtureFile;
  const styles = fixture.styles ?? {};
  return {
    roots: fixture.nodes.map(reviveNode),
    resolveStyle: async (styleId) => styles[styleId] ?? null,
  };
}

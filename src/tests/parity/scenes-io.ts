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
 *   - `mainComponentId` (a string) becomes `getMainComponentAsync`, resolved to that node
 *     in the same fixture — the live node is what the real API returns
 *   - `parent` back-links, non-enumerably — the adapter reads a parent's type (is this COMPONENT
 *     a set variant?) and, through the main component, the enclosing set's own id/name/key
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

function reviveNode(
  raw: SceneFixtureNode,
  byId: Map<string, Record<string, unknown>>,
  parent: Record<string, unknown> | null,
): SceneNodeLike {
  const { styledTextSegments, mainComponentId, children, ...rest } = raw;
  const node: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    node[key] = value === MIXED_SENTINEL ? MIXED : value;
  }
  // `parent` is non-enumerable so the revived node still JSON-stringifies (the fixtures are
  // compared and dumped by id elsewhere) and so the cycle it creates can't be walked into.
  Object.defineProperty(node, "parent", { value: parent, enumerable: false });
  if (children) node.children = children.map((child) => reviveNode(child, byId, node));
  if (styledTextSegments) node.getStyledTextSegments = () => styledTextSegments;
  if (mainComponentId) {
    // The real `getMainComponentAsync` hands back the LIVE component node — name, key and the
    // COMPONENT_SET it sits in included — which is where the plugin adapter reads an instance's
    // provenance. Resolve through the fixture so it does, falling back to a bare id for a
    // component the fixture doesn't hold (a published library one, off-tree by definition).
    node.getMainComponentAsync = async () => byId.get(mainComponentId) ?? { id: mainComponentId };
  }
  if (typeof node.id === "string") byId.set(node.id, node);
  return node as unknown as SceneNodeLike;
}

export function loadScene(name: string): LoadedScene | null {
  const file = path.join(SCENES_DIR, `${name}.json`);
  if (!existsSync(file)) return null;
  const fixture = JSON.parse(readFileSync(file, "utf8")) as SceneFixtureFile;
  const styles = fixture.styles ?? {};
  // Two passes: revive registers every node by id, then the main-component links resolve — a
  // fixture may name a component that appears after the instance referencing it.
  const byId = new Map<string, Record<string, unknown>>();
  return {
    roots: fixture.nodes.map((raw) => reviveNode(raw, byId, null)),
    resolveStyle: async (styleId) => styles[styleId] ?? null,
  };
}

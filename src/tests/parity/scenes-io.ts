import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type {
  SceneNodeLike,
  SceneTokenResolver,
  SceneTextSegment,
} from "@framelink/plugin/node-to-snapshot";

/**
 * Committed plugin-native fixtures — one <name>.json per parity case, each a
 * `{ styles?, variables?, nodes }` file whose nodes are shaped exactly as the plugin API shapes them (RGB solids
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
 *   - the top-level `styles` and `variables` tables (id → { name }) back the returned token
 *     resolver; an id missing from its table resolves to null, as a deleted token does live
 *
 * Variable bindings (`boundVariables` on nodes, solid paints and text segments) are plain data
 * on the live API too, so they ride through unrevived.
 *
 * Every golden needs a scene: a missing one throws, so a new golden can't pass parity with no
 * plugin check at all.
 */
import type { SceneTokenIds } from "./shared-subset.js";

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
  styles?: Record<string, { name: string; key?: string }>;
  variables?: Record<string, { name: string }>;
  nodes: SceneFixtureNode[];
}

export interface LoadedScene {
  roots: SceneNodeLike[];
  resolveToken: SceneTokenResolver;
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

export function loadScene(name: string): LoadedScene {
  const file = path.join(SCENES_DIR, `${name}.json`);
  if (!existsSync(file))
    throw new Error(`No plugin scene fixture for golden "${name}": add parity/scenes/${name}.json`);
  const fixture = JSON.parse(readFileSync(file, "utf8")) as SceneFixtureFile;
  const tables = { style: fixture.styles ?? {}, variable: fixture.variables ?? {} };
  // The fixture's tables are everything its file can reach. Stricter than live, which tells kinds
  // and tiers apart: here any shared name keeps the id, a superset of the cases live keeps it.
  const shared = (table: Record<string, { name: string }>) => {
    const names = Object.values(table).map((token) => token.name);
    return new Set(names.filter((name, i) => names.indexOf(name) !== i));
  };
  const sharedNames = { style: shared(tables.style), variable: shared(tables.variable) };
  // Two passes: revive registers every node by id, then the main-component links resolve — a
  // fixture may name a component that appears after the instance referencing it.
  const byId = new Map<string, Record<string, unknown>>();
  return {
    roots: fixture.nodes.map((raw) => reviveNode(raw, byId, null)),
    resolveToken: async (kind, id) => {
      const token = tables[kind][id];
      return token ? { ...token, nameSuffices: !sharedNames[kind].has(token.name) } : null;
    },
  };
}

/** The scene's token ids by name — how parity reads a reference the plugin spelled by bare name. */
export function loadSceneTokenIds(name: string): SceneTokenIds {
  const file = path.join(SCENES_DIR, `${name}.json`);
  const fixture = JSON.parse(readFileSync(file, "utf8")) as SceneFixtureFile;
  return {
    variable: Object.fromEntries(
      Object.entries(fixture.variables ?? {}).map(([id, token]) => [token.name, id]),
    ),
    style: Object.fromEntries(
      Object.entries(fixture.styles ?? {}).map(([id, token]) => [token.name, token.key ?? id]),
    ),
  };
}

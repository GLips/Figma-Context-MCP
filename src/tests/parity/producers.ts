import type { GetFileResponse, GetFileNodesResponse } from "@figma/rest-api-spec";
import type { SceneNodeLike } from "@framelink/plugin/node-to-snapshot";
import { readSceneDesign } from "@framelink/plugin/scene-read";
import type { NodeSnapshot } from "@framelink/core/snapshot";
import type { SimplifiedDesign, SimplifyResult } from "@framelink/core";
import { simplify, project } from "@framelink/core";
import { readRestFixture } from "../rest-fixture-source.js";
import type { LoadedScene } from "./scenes-io.js";

/**
 * One case in the parity harness: a shared golden and the per-producer inputs
 * that must all reduce to it. `rest` is the REST wire response; `snapshot` is the
 * committed `NodeSnapshot[]` the REST adapter decodes it to (see snapshots/), for
 * a whole-file read only; `scene` is the plugin-native fixture (roots + its token
 * resolver) fed through the plugin's composed read (see scenes-io.ts).
 */
export interface ParityCase {
  /** Golden basename in ../goldens/expected and the snapshots/ fixture name. */
  name: string;
  rest: GetFileResponse | GetFileNodesResponse;
  /** A targeted read of this node; a whole-file read without one. */
  nodeId?: string;
  snapshot?: NodeSnapshot[];
  scene: LoadedScene;
}

/**
 * A producer turns a case into a `SimplifiedDesign` via the ONE shared core. The
 * only thing that varies between producers is how the `NodeSnapshot`s reach the
 * core; everything downstream is identical, which is the whole point of the
 * harness. `undefined`: the producer can't model this case.
 */
export interface ParityProducer {
  id: string;
  produce(parityCase: ParityCase): Promise<SimplifiedDesign | undefined>;
}

/** The wire form both producers egress: compressed projection of a full simplify result. */
function compressed(full: SimplifyResult): SimplifiedDesign {
  const { nodes, styles, templates, components } = project(full, { compress: true });
  // `name` is scoped out of the parity view — no source name in a snapshot.
  return { name: "", nodes, components, styles, templates };
}

/**
 * REST producer — the shipped path: `readRestDesign`, the same composed read
 * get_figma_data runs, with Figma served from the recorded response (a targeted
 * read ids-filtered, supplementary fetches answered from the same file). It is
 * independently gated byte-exact against the goldens by goldens.test.ts.
 */
const restProducer: ParityProducer = {
  id: "rest",
  produce: ({ rest, nodeId }) => readRestFixture(rest, { nodeId }),
};

/**
 * Snapshot producer — feeds the committed plan-neutral `NodeSnapshot[]` straight
 * into the same core. It proves the core turns a neutral snapshot into the
 * shared output independent of any adapter, so a `scene` failure localizes to
 * the adapter's decode rather than the core. A targeted case has no committed
 * snapshot: its placement and definitions are the composed reads' to assemble.
 */
const snapshotProducer: ParityProducer = {
  id: "snapshot",
  produce: async ({ snapshot }) => snapshot && compressed(await simplify(snapshot)),
};

/**
 * Scene producer — the plugin path proper: `readSceneDesign`, the composed read
 * the flcm read verbs run, over the plugin-native fixture. Its token resolver
 * reads the fixture's styles and variables tables, standing in for
 * `figma.getStyleByIdAsync` and `figma.variables.getVariableByIdAsync`.
 */
const sceneProducer: ParityProducer = {
  id: "scene",
  produce: async ({ scene, nodeId }) => {
    const target = nodeId === undefined ? undefined : findScene(scene.roots, nodeId);
    if (nodeId !== undefined && !target) throw new Error(`Scene has no node ${nodeId}.`);
    const full = await readSceneDesign(target ? [target] : scene.roots, {
      // Revived fixtures carry the live parent (scenes-io.ts).
      parent: (target?.parent as SceneNodeLike | null | undefined) ?? undefined,
      resolveToken: scene.resolveToken,
      annotationCategories: new Map(),
    });
    return compressed(full);
  },
};

function findScene(nodes: readonly SceneNodeLike[], id: string): SceneNodeLike | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findScene(node.children ?? [], id);
    if (found) return found;
  }
  return undefined;
}

/** The registered producers; the harness fans over whatever is here. */
export const PARITY_PRODUCERS: ParityProducer[] = [restProducer, snapshotProducer, sceneProducer];

import type { GetFileResponse, GetFileNodesResponse } from "@figma/rest-api-spec";
import { sceneNodeToSnapshot } from "@framelink/plugin/node-to-snapshot";
import type { NodeSnapshot } from "@framelink/core/snapshot";
import type { SimplifiedDesign } from "@framelink/core";
import { simplify } from "@framelink/core";
import { simplifyRestResponse } from "~/adapters/rest/rest.js";
import type { LoadedScene } from "./scenes-io.js";

/**
 * One case in the parity harness: a shared golden and the per-producer inputs
 * that must all reduce to it. `rest` is the REST wire response; `snapshot` is the
 * plan-neutral `NodeSnapshot[]` the plugin adapter produces (committed as the
 * read plan's concrete target — see snapshots/); `scene` is the plugin-native
 * fixture (roots + its style resolver) fed through the real `sceneNodeToSnapshot`
 * (null until a case's fixture lands — see scenes-io.ts).
 */
export interface ParityCase {
  /** Golden basename in ../goldens/expected and the snapshots/ fixture name. */
  name: string;
  rest: GetFileResponse | GetFileNodesResponse;
  snapshot: NodeSnapshot[];
  scene: LoadedScene | null;
}

/**
 * A producer turns a case into a `SimplifiedDesign` via the ONE shared core. The
 * only thing that varies between producers is how the `NodeSnapshot`s reach the
 * core; everything downstream is identical, which is the whole point of the
 * harness. Returns null when a case carries no input for this producer (the
 * plugin producer will return null until scene fixtures land).
 */
export interface ParityProducer {
  id: string;
  produce(parityCase: ParityCase): Promise<SimplifiedDesign> | null;
}

/**
 * REST producer — the shipped path, verbatim: raw response → `restNodeToSnapshot`
 * → core (compressed) → assembled design. This is the reference producer; it is
 * independently gated byte-exact against the goldens by goldens.test.ts.
 */
const restProducer: ParityProducer = {
  id: "rest",
  produce: (parityCase) => simplifyRestResponse(parityCase.rest),
};

/**
 * Assemble a `SimplifiedDesign` from snapshots the way the plugin path does: the
 * one shared core and nothing else. The component tables stay empty — they are
 * REST response-envelope provenance the plugin has no source for, and the
 * comparator scopes them out (pin 2). Property definitions travel on the defining
 * NODE, so they are compared as part of `nodes` like every other field.
 */
async function designFromSnapshots(snapshots: NodeSnapshot[]): Promise<SimplifiedDesign> {
  const { nodes, styles, templates } = await simplify(snapshots, { compress: true });
  return {
    // `name` is scoped out of the parity view — no source name in a snapshot.
    name: "",
    nodes,
    components: {},
    componentSets: {},
    styles,
    templates,
  };
}

/**
 * Snapshot producer — feeds the committed plan-neutral `NodeSnapshot[]` straight
 * into the same core. It proves the core turns a neutral snapshot into the
 * shared output independent of any adapter, so a `scene` failure localizes to
 * the adapter's decode rather than the core.
 */
const snapshotProducer: ParityProducer = {
  id: "snapshot",
  produce: (parityCase) => designFromSnapshots(parityCase.snapshot),
};

/**
 * Scene producer — the plugin path proper: a committed plugin-native fixture
 * through the REAL `sceneNodeToSnapshot`, then the same core. The style resolver
 * reads the fixture's styles table, standing in for `figma.getStyleByIdAsync`.
 * Returns null (case skipped) until a case's fixture exists.
 */
const sceneProducer: ParityProducer = {
  id: "scene",
  produce: ({ scene }) => {
    if (!scene) return null;
    return Promise.all(
      scene.roots.map((root) => sceneNodeToSnapshot(root, scene.resolveStyle)),
    ).then(designFromSnapshots);
  },
};

/** The registered producers; the harness fans over whatever is here. */
export const PARITY_PRODUCERS: ParityProducer[] = [restProducer, snapshotProducer, sceneProducer];

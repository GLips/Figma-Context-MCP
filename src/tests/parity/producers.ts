import type { GetFileResponse, GetFileNodesResponse } from "@figma/rest-api-spec";
import type { NodeSnapshot } from "~/core/snapshot.js";
import type { SimplifiedDesign } from "~/core/types.js";
import { canonicalize } from "~/core/canonicalize.js";
import { simplifyRawFigmaObject } from "~/adapters/rest/design-extractor.js";

/**
 * One case in the parity harness: a shared golden and the per-producer inputs
 * that must all reduce to it. `rest` is the REST wire response; `snapshot` is the
 * plan-neutral `NodeSnapshot[]` the plugin adapter will one day produce (committed
 * as the read plan's concrete target — see snapshots/). A `scene` input is the
 * read-plan slot: when `sceneNodeToSnapshot` exists, add the plugin's native
 * fixture here and a producer that consumes it.
 */
export interface ParityCase {
  /** Golden basename in ../goldens/expected and the snapshots/ fixture name. */
  name: string;
  rest: GetFileResponse | GetFileNodesResponse;
  snapshot: NodeSnapshot[];
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
  produce: (parityCase) => simplifyRawFigmaObject(parityCase.rest),
};

/**
 * Snapshot producer — the plugin STAND-IN. It skips the REST wire entirely and
 * feeds the committed plan-neutral `NodeSnapshot[]` straight into the same core,
 * exactly as the plugin's `sceneNodeToSnapshot` output will. Until that adapter
 * exists, the committed snapshot plays its role: it proves the core turns a
 * neutral snapshot into the shared output, so "one output, two producers" is
 * enforced today over the REST decode AND a pre-decoded snapshot.
 *
 * It assembles the component tables from the WALK's `componentDefinitions` only
 * (no published-library metadata to read), which is precisely the shared subset
 * the comparator scopes to — so the REST producer's richer tables and this one's
 * lean tables reduce to the same parity view.
 */
const snapshotProducer: ParityProducer = {
  id: "snapshot",
  produce: async (parityCase) => {
    const { nodes, globalVars, elements, componentDefinitions } = await canonicalize(
      parityCase.snapshot,
      { compress: true },
    );
    return {
      // `name` is scoped out of the parity view — no source name in a snapshot.
      name: "",
      nodes,
      components: Object.fromEntries(
        Object.entries(componentDefinitions).map(([id, propertyDefinitions]) => [
          id,
          { id, propertyDefinitions },
        ]),
      ),
      componentSets: {},
      globalVars,
      elements,
    } as SimplifiedDesign;
  },
};

/**
 * The registered producers. The read plan adds a `plugin` producer here that
 * reads a `scene` fixture off the case through `sceneNodeToSnapshot`; the harness
 * fans over whatever is registered, so no harness change is needed — the plugin
 * row lights up as soon as it returns non-null.
 */
export const PARITY_PRODUCERS: ParityProducer[] = [restProducer, snapshotProducer];

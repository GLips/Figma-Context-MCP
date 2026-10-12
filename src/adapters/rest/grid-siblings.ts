import type { PlacementContext } from "@framelink/core";
import { Logger } from "~/utils/logger.js";
import { parseRestResponse } from "./decode/response.js";
import type { RestDesignSource } from "./read-rest-design.js";
import type { FigmaFileKey } from "~/utils/figma-url.js";

/**
 * A targeted read's placement with every sibling, when its parent is a GRID.
 *
 * Grid cell placement (packed or explicit, z-order) is read against every in-flow sibling, and an
 * ids-filtered response lists only the child on the path. So a grid parent costs one more call for
 * its children, one level deep; every other parent needs none. Supplementary, like the component
 * definition fetch: on failure the read keeps the path-only siblings, placing the node against itself.
 */
export async function withGridSiblings(
  source: RestDesignSource,
  fileKey: FigmaFileKey,
  placement: PlacementContext | undefined,
): Promise<PlacementContext | undefined> {
  if (placement?.parent.layoutMode !== "GRID") return placement;
  const { parent } = placement;
  try {
    const response = await source.getRawNodes(fileKey, [parent.id], 1);
    const [fetched] = parseRestResponse(response).snapshots;
    return { parent, siblings: fetched.children ?? [] };
  } catch (error) {
    // Access, rate limit, network. Expected enough to be a fallback rather than a failure.
    Logger.log(
      `Grid siblings of ${parent.id} in ${fileKey} are unreachable — placing the node ` +
        `against itself: ${error instanceof Error ? error.message : String(error)}`,
    );
    return placement;
  }
}

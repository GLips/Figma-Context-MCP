import type { NodeSnapshot } from "@framelink/core/snapshot";
import type { FigmaService } from "~/services/figma.js";
import { Logger } from "~/utils/logger.js";
import { restResponseToSnapshots } from "./rest.js";

/**
 * A targeted read's context parent with its siblings, when it is a GRID.
 *
 * Grid cell placement (packed or explicit, z-order) is read against every in-flow sibling, and an
 * ids-filtered response lists only the child on the path. So a grid parent costs one more call for
 * its children, one level deep; every other parent needs none. Supplementary, like the component
 * definition fetch: on failure the read keeps the path-only parent, placing the node against itself.
 */
export async function withGridSiblings(
  figmaService: FigmaService,
  fileKey: string,
  contextParent: NodeSnapshot | undefined,
): Promise<NodeSnapshot | undefined> {
  if (contextParent?.layoutMode !== "GRID") return contextParent;
  try {
    const response = await figmaService.getRawNodes(fileKey, [contextParent.id], 1);
    const [parent] = restResponseToSnapshots(response).snapshots;
    return { ...contextParent, children: parent.children };
  } catch (error) {
    // Access, rate limit, network. Expected enough to be a fallback rather than a failure.
    Logger.log(
      `Grid siblings of ${contextParent.id} in ${fileKey} are unreachable — placing the node ` +
        `against itself: ${error instanceof Error ? error.message : String(error)}`,
    );
    return contextParent;
  }
}

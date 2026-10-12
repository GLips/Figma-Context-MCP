import type { GetFileNodesResponse, GetFileResponse } from "@figma/rest-api-spec";
import type { SimplifiedDesign } from "@framelink/core";
import { readRestDesign } from "~/adapters/rest/read-rest-design.js";
import { recordedRestSource } from "~/adapters/rest/recorded-source.js";
import { figmaFileKey, figmaNodeId } from "~/utils/figma-url.js";

/** The composed REST read over a recorded response: what get_figma_data simplifies it to. */
export async function readRestFixture(
  response: GetFileResponse | GetFileNodesResponse,
  { nodeId, depth }: { nodeId?: string; depth?: number } = {},
): Promise<SimplifiedDesign> {
  const { design } = await readRestDesign(recordedRestSource(response), {
    fileKey: figmaFileKey("fixture"),
    nodeId: nodeId === undefined ? undefined : figmaNodeId(nodeId),
    depth,
  });
  return design;
}

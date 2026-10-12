import type {
  GetFileNodesResponse,
  GetFileResponse,
  Node as FigmaNode,
} from "@figma/rest-api-spec";
import type { SimplifiedDesign } from "@framelink/core";
import { readRestDesign, type RestDesignSource } from "~/adapters/rest/read-rest-design.js";
import { figmaFileKey, figmaNodeId } from "~/utils/figma-url.js";

/**
 * A recorded response served as a one-file Figma. A targeted read gets the recording ids-filtered
 * the way the API filters it — each ancestor listing only the child on the path — and a
 * supplementary `?ids=` call is answered from the same document, as the live API answers a
 * same-file definition or a grid's children. A published library is unreachable, so library
 * components land on the donor floor — exactly where a 403 on the library puts them live.
 */
export function restFixtureSource(
  response: GetFileResponse | GetFileNodesResponse,
): RestDesignSource {
  // A golden may record a nodes response; the read decodes either shape, the API types only one.
  const recorded = { data: response as GetFileResponse, rawSize: JSON.stringify(response).length };
  const document = "nodes" in response ? undefined : response.document;
  return {
    getRawFile: async () => recorded,
    getRawNodeInContext: async (_fileKey, nodeId) =>
      document
        ? {
            ...recorded,
            data: { ...recorded.data, document: pathTo(document, nodeId) ?? document },
          }
        : recorded,
    getRawNodes: async (_fileKey, nodeIds) => ({
      name: response.name,
      lastModified: "",
      thumbnailUrl: "",
      version: "",
      role: "viewer",
      editorType: "figma",
      nodes: Object.fromEntries(
        nodeIds.map((id) => {
          const node = document && findNode(document, id);
          return [
            id,
            node
              ? {
                  document: node,
                  components: "nodes" in response ? {} : response.components,
                  componentSets: "nodes" in response ? {} : response.componentSets,
                  styles: "nodes" in response ? {} : response.styles,
                  schemaVersion: 0,
                }
              : null,
          ];
        }),
      ),
    }),
    getPublishedComponentSite: async (key) => {
      throw new Error(`Library component ${key} is not reachable from a one-file fixture.`);
    },
  } as RestDesignSource;
}

/** The composed REST read over a recorded response: what get_figma_data simplifies it to. */
export async function readRestFixture(
  response: GetFileResponse | GetFileNodesResponse,
  { nodeId, depth }: { nodeId?: string; depth?: number } = {},
): Promise<SimplifiedDesign> {
  const { design } = await readRestDesign(restFixtureSource(response), {
    fileKey: figmaFileKey("fixture"),
    nodeId: nodeId === undefined ? undefined : figmaNodeId(nodeId),
    depth,
  });
  return design;
}

/** `node` cut down to the chain that leads to `nodeId`, the target's own subtree whole. */
function pathTo<T extends FigmaNode>(node: T, nodeId: string): T | undefined {
  if (node.id === nodeId) return node;
  for (const child of "children" in node ? node.children : []) {
    const kept = pathTo(child, nodeId);
    if (kept) return { ...node, children: [kept] };
  }
  return undefined;
}

function findNode(node: FigmaNode, id: string): FigmaNode | undefined {
  if (node.id === id) return node;
  for (const child of "children" in node ? node.children : []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return undefined;
}

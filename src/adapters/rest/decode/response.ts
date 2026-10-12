import type {
  GetFileNodesResponse,
  GetFileResponse,
  Node as FigmaDocumentNode,
  Style,
} from "@figma/rest-api-spec";
import type { PlacementContext } from "@framelink/core";
import type { NodeSnapshot } from "@framelink/core/snapshot";
import { tagError } from "~/utils/error-meta.js";
import { componentTablesOf, type RestComponentTables } from "./component-tables.js";
import { restNodeToSnapshot } from "./node-to-snapshot.js";

/**
 * A REST response decoded once: everything later stages need, so none of them parses it again.
 * Nothing REST-shaped reaches the core (Invariant 2) — the tables stay here, for the off-tree
 * definition fetch to read where each referenced component lives.
 */
export interface ParsedRestResponse {
  name: string;
  /** The read's roots: a whole file's pages, or the one node a targeted read asked for. */
  snapshots: NodeSnapshot[];
  /**
   * A targeted node's parent, without siblings: an ids-filtered response lists the node alone,
   * which is all every parent but a GRID reads. A GRID's siblings the read fetches.
   */
  placement?: PlacementContext;
  tables: Required<RestComponentTables>;
}

/**
 * Decode a raw response. `nodeId` reads one node out of an ids-filtered file response
 * (`getRawNodeInContext`), whose ancestor chain becomes the node's placement context.
 */
export function parseRestResponse(
  response: GetFileResponse | GetFileNodesResponse,
  nodeId?: string,
): ParsedRestResponse {
  if ("nodes" in response) {
    const [id, entry] = Object.entries(response.nodes)[0];
    if (entry === null) throwNodeNotFound(id);
    const tables = componentTablesOf(entry);
    return {
      name: response.name,
      snapshots: [restNodeToSnapshot(entry.document, entry.styles ?? {}, tables)],
      tables,
    };
  }

  const tables = componentTablesOf(response);
  const styles = response.styles ?? {};
  if (!nodeId) {
    return {
      name: response.name,
      snapshots: response.document.children.map((page) => restNodeToSnapshot(page, styles, tables)),
      tables,
    };
  }
  return {
    name: response.name,
    tables,
    ...decodeInContext(response.document, nodeId, styles, tables),
  };
}

/**
 * Decode a targeted node with its ancestors, from the frame on the canvas down, so the node's own
 * box is solved in its parent's real space rather than assumed unrotated at the page origin. Each
 * ancestor in an ids-filtered response lists only the child on the path, so this costs the chain's
 * own bodies, not their siblings. A node on the canvas, or a page, has no parent to give context.
 */
function decodeInContext(
  document: FigmaDocumentNode,
  nodeId: string,
  styles: Record<string, Style>,
  tables: RestComponentTables,
): Pick<ParsedRestResponse, "snapshots" | "placement"> {
  // [document, page, frame on the canvas, …, target]
  const path = restTargetPath(document, nodeId);
  const target = path[path.length - 1];
  if (path.length < 4) return { snapshots: [restNodeToSnapshot(target, styles, tables)] };

  let parent = restNodeToSnapshot(path[2], styles, tables);
  for (const ancestor of path.slice(3, -1)) {
    parent = parent.children!.find((child) => child.id === ancestor.id)!;
  }
  const { children = [], ...parentFields } = parent;
  const snapshot = children.find((child) => child.id === nodeId)!;
  return { snapshots: [snapshot], placement: { parent: parentFields } };
}

/** The chain from the document root to `nodeId`, or a not-found error. */
function restTargetPath(document: FigmaDocumentNode, nodeId: string): FigmaDocumentNode[] {
  const search = (node: FigmaDocumentNode): FigmaDocumentNode[] | undefined => {
    if (node.id === nodeId) return [node];
    for (const child of "children" in node ? node.children : []) {
      const below = search(child);
      if (below) return [node, ...below];
    }
    return undefined;
  };
  const path = search(document);
  if (!path) throwNodeNotFound(nodeId);
  return path;
}

function throwNodeNotFound(nodeId: string): never {
  tagError(
    new Error(
      `Node ${nodeId} was not found in the Figma file. Likely causes: ` +
        `(1) The source URL was a /proto/, /figjam/, /slides/, /board/, or /deck/ link — ` +
        `only /design/ and /file/ URLs are supported by the Figma REST API. ` +
        `(2) The node is inside a Figma branch — branches have their own fileKey ` +
        `(the value after /branch/ in the URL), use that instead of the parent file's key. ` +
        `(3) The link is stale or the node was deleted. ` +
        `Ask the user for a fresh /design/ URL pointing to the specific frame.`,
    ),
    { category: "not_found" },
  );
}

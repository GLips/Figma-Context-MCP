import type {
  GetFileResponse,
  GetFileNodesResponse,
  Node as FigmaDocumentNode,
  Component,
  ComponentSet,
  Style,
} from "@figma/rest-api-spec";
import { tagError } from "~/utils/error-meta.js";
import type { TraversalOptions, SimplifiedDesign } from "@framelink/core";
import type { NodeSnapshot } from "@framelink/core/snapshot";
import { simplify, project } from "@framelink/core";
import { restNodeToSnapshot, type RestComponentTables } from "./node-to-snapshot.js";

// Yield to the Node event loop between walk batches so progress heartbeats,
// SIGINT, and overlapping HTTP requests stay live during large files. Injected
// here — not hardcoded in the walk — because the core must stay free of Node
// builtins (Invariant 4).
const eventLoopYield = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * The REST adapter entry: a complete SimplifiedDesign from a raw Figma API
 * response.
 */
export async function simplifyRestResponse(
  apiResponse: GetFileResponse | GetFileNodesResponse,
  options: RestSimplifyOptions = {},
): Promise<SimplifiedDesign> {
  return simplifyRestRead(restResponseToSnapshots(apiResponse), options);
}

export type RestSimplifyOptions = TraversalOptions & { componentDefinitions?: NodeSnapshot[] };

/** A decoded read: the snapshots to simplify, and the parent a targeted node sits in. */
export interface RestRead {
  name: string;
  snapshots: NodeSnapshot[];
  /** Layout context only (see core's `SimplifyOptions.contextParent`). */
  contextParent?: NodeSnapshot;
}

/** Simplify an already-decoded read — the targeted path, which may enrich its context parent first. */
export async function simplifyRestRead(
  { name, snapshots, contextParent }: RestRead,
  options: RestSimplifyOptions = {},
): Promise<SimplifiedDesign> {
  const { maxDepth, ...readOptions } = options;

  // Run the core with egress compression on: this is the shipped REST tool's
  // output form (ref-deduplicated styles + templates).
  const full = await simplify(snapshots, {
    ...readOptions,
    contextParent,
    scheduler: eventLoopYield,
  });

  const { nodes, styles, templates, components, elided } = project(full, {
    compress: true,
    maxDepth,
  });
  return { name, nodes, components, styles, templates, ...(elided ? { elided } : {}) };
}

/**
 * The REST producer's adapter half: a raw API response in, plan-neutral
 * `NodeSnapshot`s out. This is the one seam where REST wire encodings are unpacked —
 * `restNodeToSnapshot` decodes each node's structures, and `parseAPIResponse`
 * unwraps the response envelope and the top-level `styles`/component tables — so
 * nothing REST-shaped reaches the core (Invariant 2).
 *
 * `nodeId` reads one node out of an ids-filtered file response (`getRawNodeInContext`),
 * whose ancestor chain becomes the read's context parent.
 *
 * Split out from `simplifyRestResponse` so the parity harness and its snapshot
 * regenerator feed the identical decode the shipped tool uses, rather than
 * re-deriving it and drifting.
 */
export function restResponseToSnapshots(
  apiResponse: GetFileResponse | GetFileNodesResponse,
  nodeId?: string,
): RestRead {
  const { name, rawNodes, components, componentSets, extraStyles } = parseAPIResponse(
    apiResponse,
    nodeId,
  );
  const tables = { components, componentSets };
  if (nodeId && !("nodes" in apiResponse)) {
    return { name, ...decodeInContext(apiResponse.document, nodeId, extraStyles, tables) };
  }

  // restNodeToSnapshot is the single place REST wire encodings are unpacked, including the
  // named-style join against the top-level `styles` table and the component tables' fold onto
  // the nodes that reference them.
  const snapshots = rawNodes.map((node) => restNodeToSnapshot(node, extraStyles, tables));

  return { name, snapshots };
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
  extraStyles: Record<string, Style>,
  tables: RestComponentTables,
): Pick<RestRead, "snapshots" | "contextParent"> {
  // [document, page, frame on the canvas, …, target]
  const path = restTargetPath(document, nodeId);
  const target = path[path.length - 1];
  if (path.length < 4) return { snapshots: [restNodeToSnapshot(target, extraStyles, tables)] };

  let parent = restNodeToSnapshot(path[2], extraStyles, tables);
  for (const ancestor of path.slice(3, -1)) {
    parent = parent.children!.find((child) => child.id === ancestor.id)!;
  }
  const snapshot = parent.children!.find((child) => child.id === nodeId)!;
  return { snapshots: [snapshot], contextParent: parent };
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

/**
 * Parse the raw Figma API response to extract metadata, nodes, and components. Exported for the
 * off-tree definition fetch, which reads the same tables to learn which referenced components the
 * response didn't carry and where each one actually lives. With `nodeId`, an ids-filtered file
 * response yields that one node, not the pages its ancestor chain hangs from.
 */
export function parseAPIResponse(data: GetFileResponse | GetFileNodesResponse, nodeId?: string) {
  const aggregatedComponents: Record<string, Component> = {};
  const aggregatedComponentSets: Record<string, ComponentSet> = {};
  let extraStyles: Record<string, Style> = {};
  let nodesToParse: Array<FigmaDocumentNode>;

  if ("nodes" in data) {
    // GetFileNodesResponse
    const [nodeId, nodeData] = Object.entries(data.nodes)[0];
    if (nodeData === null) throwNodeNotFound(nodeId);

    Object.assign(aggregatedComponents, nodeData.components);
    Object.assign(aggregatedComponentSets, nodeData.componentSets);
    if (nodeData.styles) {
      Object.assign(extraStyles, nodeData.styles);
    }
    nodesToParse = [nodeData.document];
  } else {
    // GetFileResponse
    Object.assign(aggregatedComponents, data.components);
    Object.assign(aggregatedComponentSets, data.componentSets);
    if (data.styles) {
      extraStyles = data.styles;
    }
    nodesToParse = nodeId
      ? [restTargetPath(data.document, nodeId).at(-1)!]
      : data.document.children;
  }

  return {
    name: data.name,
    rawNodes: nodesToParse,
    extraStyles,
    components: aggregatedComponents,
    componentSets: aggregatedComponentSets,
  };
}

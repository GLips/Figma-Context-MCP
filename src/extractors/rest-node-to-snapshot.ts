import type { Node as FigmaDocumentNode } from "@figma/rest-api-spec";
import type { NodeSnapshot } from "./snapshot.js";

/**
 * REST adapter: decode a raw Figma REST node into a plan-neutral `NodeSnapshot`
 * for `canonicalize`. This is where every REST-specific structure is unpacked
 * (top-level tables, `imageRef`, override tables, `gradientHandlePositions`,
 * `node.styles` lookups) so none of it reaches the core (Invariant 2).
 *
 * Incremental carve: today this is a structural passthrough — `NodeSnapshot` is
 * a subset of the Figma node shape, so the raw node already satisfies it. As
 * each transformer migrates onto the snapshot, the corresponding wire-decode
 * moves here and this function stops being a passthrough for that concern.
 *
 * Children are left as-is; the walker recurses and they are structurally
 * snapshots too. A per-node decode (rather than a one-shot deep copy) keeps this
 * cheap and lets the walk drive traversal order.
 */
export function restNodeToSnapshot(node: FigmaDocumentNode): NodeSnapshot {
  return node as unknown as NodeSnapshot;
}

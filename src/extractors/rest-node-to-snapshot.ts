import type { Node as FigmaDocumentNode, Paint, Effect, Style } from "@figma/rest-api-spec";
import type { NodeSnapshot, SnapshotStyleRef } from "./snapshot.js";
import { decodePaint, decodeEffect } from "./rest-paint.js";
import { decodeText } from "./rest-text.js";

/**
 * REST adapter: decode a raw Figma REST node into a plan-neutral `NodeSnapshot`
 * for `canonicalize`. This is where every REST-specific structure is unpacked
 * (top-level tables, `imageRef`, override tables, `gradientHandlePositions`,
 * `node.styles` lookups) so none of it reaches the core (Invariant 2).
 *
 * Incremental carve: the ~1:1 structural fields (id, layout traits, scalar
 * appearance) still pass through untouched because `NodeSnapshot` is a subset of
 * the Figma node shape. The concerns that have migrated onto decoded snapshot
 * shapes — paints, effects, and text runs — are unpacked here; the rest
 * (component metadata, named-style resolution) is decoded in later carve slices.
 *
 * The whole subtree is decoded eagerly: children are mapped recursively so the
 * walker only ever sees decoded snapshots and never reaches back into REST
 * shapes.
 */
export function restNodeToSnapshot(
  node: FigmaDocumentNode,
  extraStyles: Record<string, Style> = {},
): NodeSnapshot {
  // Read the REST-shaped visual fields off a permissive view: they exist only on
  // some node types, and this adapter is the one place allowed to know their
  // wire shape. Everything else is carried through structurally via the spread.
  const raw = node as unknown as {
    fills?: Paint[];
    strokes?: Paint[];
    effects?: Effect[];
    children?: FigmaDocumentNode[];
  };

  const snapshot = { ...node } as unknown as NodeSnapshot;

  if (raw.fills) snapshot.fills = raw.fills.map(decodePaint);
  if (raw.strokes) snapshot.strokes = raw.strokes.map(decodePaint);
  if (raw.effects) snapshot.effects = raw.effects.map(decodeEffect);
  if (raw.children) snapshot.children = raw.children.map((c) => restNodeToSnapshot(c, extraStyles));

  // Text nodes: resolve the wire override tables into runs (undefined otherwise).
  snapshot.text = decodeText(node);

  // Named styles: join the node's `styles` map with the top-level table into
  // per-slot resolved names. Overwrite the spread's raw string map so the wire
  // shape never reaches the core; drop it entirely when nothing resolves.
  const styles = decodeStyles(node, extraStyles);
  if (styles) snapshot.styles = styles;
  else delete snapshot.styles;

  return snapshot;
}

/**
 * Resolve a node's REST `styles` map (style-slot → styleId) against the
 * top-level `styles` table (styleId → { name }) into per-slot resolved refs.
 * Only slots whose styleId carries a name survive — an unnamed or unknown
 * styleId is dropped, exactly as the old in-core lookup skipped it.
 */
function decodeStyles(
  node: FigmaDocumentNode,
  extraStyles: Record<string, Style>,
): Record<string, SnapshotStyleRef> | undefined {
  const styleMap = (node as unknown as { styles?: Record<string, string> }).styles;
  if (!styleMap) return undefined;

  const resolved: Record<string, SnapshotStyleRef> = {};
  for (const [slot, styleId] of Object.entries(styleMap)) {
    const name = extraStyles[styleId]?.name;
    if (name) resolved[slot] = { name, id: styleId };
  }
  return Object.keys(resolved).length ? resolved : undefined;
}

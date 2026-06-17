import type { ElementDefinition, GlobalVars, SimplifiedNode } from "./types.js";

/**
 * Post-walk deduplication pass.
 *
 * Count-gated style hoisting needs GLOBAL knowledge the single-pass extractor
 * walk can't have: you can't tell whether a style is used once or a hundred
 * times until the whole tree is built. So rather than fight the
 * composable-extractor model, we run this as a finalize pass over the
 * already-built design — mirroring FrameLink's "resolve after the full walk"
 * ordering.
 *
 * A style stays in globalVars only when 2+ nodes reference it (or it's a named
 * Figma style); single-use styles are inlined back onto their node, dropping the
 * indirection tax (a sidecar entry plus a ref) that buys nothing at one use.
 */
export function finalizeDesign(
  nodes: SimplifiedNode[],
  globalVars: GlobalVars,
  namedStyleKeys: Set<string>,
): {
  nodes: SimplifiedNode[];
  globalVars: GlobalVars;
  elements: Record<string, ElementDefinition>;
} {
  const styles = gateStyles(nodes, globalVars, namedStyleKeys);
  return { nodes, globalVars: { styles }, elements: {} };
}

// Node fields that carry a style reference (a globalVars key) and, after gating,
// may instead carry the inline style value. These are the only fields counted
// and inlined. `styles` is intentionally excluded — it's never populated.
const STYLE_REF_FIELDS = ["layout", "fills", "strokes", "effects", "textStyle"] as const;

// Inline text-style deltas live under `ts1`, `ts2`, ... and are referenced from
// inside `text` strings (`{ts1}…{/ts1}`), not from node style fields. They are
// their own indirection mechanism with no node-field reference to count, so the
// gate must leave them alone — never inline or drop them.
const INLINE_TEXT_STYLE_KEY = /^ts\d+$/;

/**
 * Inline single-use styles, returning the surviving globalVars.styles. Mutates
 * the passed nodes in place (they're owned by this call). A single-use value is
 * referenced by exactly one node, so assigning the shared value object onto that
 * node creates no aliasing.
 */
function gateStyles(
  nodes: SimplifiedNode[],
  globalVars: GlobalVars,
  namedStyleKeys: Set<string>,
): GlobalVars["styles"] {
  const counts = new Map<string, number>();
  countStyleRefs(nodes, counts);

  const inlineKeys = new Set<string>();
  for (const key of Object.keys(globalVars.styles)) {
    if (INLINE_TEXT_STYLE_KEY.test(key)) continue; // referenced from text, not gated
    if (namedStyleKeys.has(key)) continue; // design-system intent, keep hoisted
    if ((counts.get(key) ?? 0) >= 2) continue; // shared, keep hoisted
    inlineKeys.add(key);
  }

  inlineStyleRefs(nodes, globalVars.styles, inlineKeys);

  const surviving: GlobalVars["styles"] = {};
  for (const [key, value] of Object.entries(globalVars.styles)) {
    if (!inlineKeys.has(key)) surviving[key] = value;
  }
  return surviving;
}

function countStyleRefs(nodes: SimplifiedNode[], counts: Map<string, number>): void {
  for (const node of nodes) {
    for (const field of STYLE_REF_FIELDS) {
      const value = node[field];
      if (typeof value === "string") counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    if (node.children) countStyleRefs(node.children, counts);
  }
}

function inlineStyleRefs(
  nodes: SimplifiedNode[],
  styles: GlobalVars["styles"],
  inlineKeys: Set<string>,
): void {
  for (const node of nodes) {
    for (const field of STYLE_REF_FIELDS) {
      const value = node[field];
      if (typeof value === "string" && inlineKeys.has(value)) {
        // Assigning the looked-up value; widened SimplifiedNode field types make
        // this assignment legal, but TS can't narrow per-field here.
        (node as unknown as Record<string, unknown>)[field] = styles[value];
      }
    }
    if (node.children) inlineStyleRefs(node.children, styles, inlineKeys);
  }
}

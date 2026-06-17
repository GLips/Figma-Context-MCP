import { createHash } from "node:crypto";
import { stableStringify } from "~/utils/common.js";
import type { ElementDefinition, GlobalVars, SimplifiedNode } from "./types.js";

/**
 * Post-walk deduplication pass.
 *
 * Both features here need GLOBAL knowledge that the single-pass extractor walk
 * can't have: you can't tell whether a style or a subtree is used once or a
 * hundred times until the whole tree is built. So rather than fight the
 * composable-extractor model, we run this as a finalize pass over the
 * already-built design — mirroring FrameLink's "resolve after the full walk"
 * ordering.
 *
 * Two transformations, in this order (the order is load-bearing — see below):
 *   1. Count-gated style hoisting — a style stays in globalVars only when 2+
 *      nodes reference it (or it's a named Figma style); single-use styles are
 *      inlined back onto their node, dropping the indirection tax.
 *   2. Element templates — node bodies (everything except id/name/children) that
 *      appear 2+ times are emitted once into `elements` and each occurrence is
 *      replaced by a compact `{ id, name, template, children? }` reference.
 *
 * Style gating MUST run before element hashing: gating rewrites single-use refs
 * to inline values, so two structurally-identical subtrees only hash to the same
 * template once their bodies are byte-identical. Any style shared between the two
 * subtrees necessarily has count >= 2, so it stays a (shared) ref in both —
 * identical on each side. Any single-use style is inlined identically on each
 * side. Either way the post-gating bodies match. Hash before gating and the two
 * sides could differ on which refs remained, breaking dedup.
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
  const elements = deduplicateElements(nodes);
  return { nodes, globalVars: { styles }, elements };
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
 * Feature 1: inline single-use styles, returning the surviving globalVars.styles.
 * Mutates the passed nodes in place (they're owned by this call). A single-use
 * value is referenced by exactly one node, so assigning the shared value object
 * onto that node creates no aliasing.
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

/**
 * Feature 2: hash each node body and replace bodies that repeat 2+ times with a
 * template reference, returning the element table. Mutates nodes in place.
 */
function deduplicateElements(nodes: SimplifiedNode[]): Record<string, ElementDefinition> {
  const seen = new Map<string, { body: ElementDefinition; count: number }>();
  const hashByNode = new Map<SimplifiedNode, string>();
  collectElements(nodes, seen, hashByNode);

  const elements: Record<string, ElementDefinition> = {};
  for (const [hash, { body, count }] of seen) {
    if (count >= 2) elements[hash] = body;
  }

  applyTemplateRefs(nodes, hashByNode, elements);
  return elements;
}

// Per-instance keys excluded from the hashed body. Everything else (type and all
// styling) is intrinsic to the element and gets shared across instances.
const ELEMENT_OMIT_KEYS = new Set(["id", "name", "children"]);

function bodyOf(node: SimplifiedNode): ElementDefinition {
  const source = node as unknown as Record<string, unknown>;
  const body: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (!ELEMENT_OMIT_KEYS.has(key)) body[key] = source[key];
  }
  return body as ElementDefinition;
}

function collectElements(
  nodes: SimplifiedNode[],
  seen: Map<string, { body: ElementDefinition; count: number }>,
  hashByNode: Map<SimplifiedNode, string>,
): void {
  for (const node of nodes) {
    const body = bodyOf(node);
    // Skip type-only bodies. A `{type}` element would cost more than it saves —
    // a `template=EL-xxxx` ref plus a global entry, versus the bare `[TYPE]` it
    // replaces. This deviates from FrameLink (which dedupes unconditionally) on
    // purpose: dedup must never grow the payload. Bodies with any real styling
    // pay for themselves at 2+ uses and scale with repetition.
    if (Object.keys(body).length > 1) {
      const hash = hashBody(body);
      const entry = seen.get(hash);
      if (entry) entry.count += 1;
      else seen.set(hash, { body, count: 1 });
      hashByNode.set(node, hash);
    }
    if (node.children) collectElements(node.children, seen, hashByNode);
  }
}

function hashBody(body: ElementDefinition): string {
  return `EL-${createHash("sha1").update(stableStringify(body)).digest("hex").slice(0, 8)}`;
}

function applyTemplateRefs(
  nodes: SimplifiedNode[],
  hashByNode: Map<SimplifiedNode, string>,
  elements: Record<string, ElementDefinition>,
): void {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.children) applyTemplateRefs(node.children, hashByNode, elements);

    const hash = hashByNode.get(node);
    if (hash && elements[hash]) {
      const ref: SimplifiedNode = { id: node.id, name: node.name, template: hash };
      if (node.children && node.children.length > 0) ref.children = node.children;
      nodes[i] = ref;
    }
  }
}

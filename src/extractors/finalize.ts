import { createHash } from "node:crypto";
import { stableStringify } from "~/utils/common.js";
import type { ElementBody, GlobalVars, SimplifiedNode } from "./types.js";

/**
 * Post-walk deduplication pass.
 *
 * Both features here need GLOBAL knowledge that the single-pass extractor walk
 * can't have: you can't tell whether a style or a subtree is used once or a
 * hundred times until the whole tree is built. So rather than fight the
 * composable-extractor model, we run this as a finalize pass over the
 * already-built design, after the walk completes.
 *
 * Two transformations, in this order:
 *   1. Count-gated style hoisting — a style stays in globalVars only when 2+
 *      nodes reference it (or it's a named Figma style); single-use styles are
 *      inlined back onto their node, dropping the indirection tax.
 *   2. Element templates — node bodies (everything except id/name/children) that
 *      appear 2+ times are emitted once into `elements` and each occurrence is
 *      replaced by a compact `{ id, name, template, children? }` reference.
 *
 * The order is for simplicity (hash bodies that are already gated), NOT a
 * correctness requirement. Style ids are content-addressed (see findOrCreateVar),
 * so two structurally-identical subtrees already carry byte-identical refs before
 * gating — they hash to the same template with or without it. And gating only
 * rewrites single-use styles, whose lone reference necessarily sits on a unique,
 * non-repeated body (any repeated body would push the style's count to >= 2), so
 * gating never touches a node that participates in templating. Hashing before or
 * after gating yields the same templates either way.
 *
 * A final step (inlineExclusiveStyles) collapses the double indirection that
 * arises when a surviving style turns out to be used only by the instances of a
 * single deduplicated element — see below.
 */
export function finalizeDesign(
  nodes: SimplifiedNode[],
  globalVars: GlobalVars,
  namedStyleKeys: Set<string>,
): {
  nodes: SimplifiedNode[];
  globalVars: GlobalVars;
  elements: Record<string, ElementBody>;
} {
  // Per-style usage counts, taken before dedup while every node still carries
  // its own style fields. Reused by both the inlining and expansion steps.
  const styleCounts = countStyleRefs(nodes);

  const styles = inlineSingleUseStyles(nodes, globalVars.styles, namedStyleKeys, styleCounts);
  const { elements, instanceCounts } = deduplicateElements(nodes);
  inlineExclusiveStyles(elements, instanceCounts, styles, styleCounts, namedStyleKeys);

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
 * Feature 1: replace single-use style refs with their inline value, returning the
 * styles that stay hoisted in globalVars (used by 2+ nodes, or named styles).
 * Mutates the passed nodes in place (they're owned by this call). A single-use
 * value is referenced by exactly one node, so sharing the value object on inline
 * creates no aliasing.
 */
function inlineSingleUseStyles(
  nodes: SimplifiedNode[],
  styles: GlobalVars["styles"],
  namedStyleKeys: Set<string>,
  counts: Map<string, number>,
): GlobalVars["styles"] {
  const inlineKeys = new Set<string>();
  const dropKeys = new Set<string>();
  for (const key of Object.keys(styles)) {
    if (INLINE_TEXT_STYLE_KEY.test(key)) continue; // referenced from text, leave hoisted
    if (namedStyleKeys.has(key)) {
      // Named styles are design-system intent, normally kept hoisted — but only
      // while something still references them. A named style can reach zero
      // references when its only node is dropped after registration (e.g.
      // collapseSvgContainers registers a vector child's style, then folds the
      // child away). A hoisted entry nothing points to is orphan noise, so drop
      // it. (Non-named zero-count styles fall through to inlineKeys below and are
      // likewise dropped — nothing references them, so nothing gets inlined.)
      if ((counts.get(key) ?? 0) === 0) dropKeys.add(key);
      continue;
    }
    if ((counts.get(key) ?? 0) >= 2) continue; // shared, keep hoisted
    inlineKeys.add(key);
  }

  const walk = (ns: SimplifiedNode[]): void => {
    for (const node of ns) {
      for (const field of STYLE_REF_FIELDS) {
        const value = node[field];
        if (typeof value === "string" && inlineKeys.has(value)) {
          // Widened SimplifiedNode field types make this legal; TS can't narrow per-field.
          (node as unknown as Record<string, unknown>)[field] = styles[value];
        }
      }
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);

  const surviving: GlobalVars["styles"] = {};
  for (const [key, value] of Object.entries(styles)) {
    if (!inlineKeys.has(key) && !dropKeys.has(key)) surviving[key] = value;
  }
  return surviving;
}

function countStyleRefs(nodes: SimplifiedNode[]): Map<string, number> {
  const counts = new Map<string, number>();
  const walk = (ns: SimplifiedNode[]): void => {
    for (const node of ns) {
      for (const field of STYLE_REF_FIELDS) {
        const value = node[field];
        if (typeof value === "string") counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return counts;
}

/**
 * Feature 2: hash each node body and replace bodies that repeat 2+ times with a
 * template reference, returning the element table and each element's instance
 * count. Mutates nodes in place.
 */
function deduplicateElements(nodes: SimplifiedNode[]): {
  elements: Record<string, ElementBody>;
  instanceCounts: Map<string, number>;
} {
  const bodiesByHash = new Map<string, { body: ElementBody; str: string; count: number }>();
  const hashByNode = new Map<SimplifiedNode, string>();
  collectElements(nodes, bodiesByHash, hashByNode);

  const elements: Record<string, ElementBody> = {};
  const instanceCounts = new Map<string, number>();
  for (const [hash, { body, count }] of bodiesByHash) {
    if (count >= 2) {
      elements[hash] = body;
      instanceCounts.set(hash, count);
    }
  }

  applyTemplateRefs(nodes, hashByNode, elements);
  return { elements, instanceCounts };
}

/**
 * Stretch optimization: collapse double indirection. When a surviving style is
 * referenced only by the instances of a single deduplicated element, the output
 * pays twice — `template → style ref → value`. Inline the value into the element
 * body and drop the global entry so it's just `template → value`.
 *
 * The test: a style whose total pre-dedup reference count equals an element's
 * instance count, and which appears in that element's body, can only have come
 * from that element's instances (any other use would push the count higher).
 * Named styles are left hoisted — surfacing design-system intent is worth the
 * indirection. A style appearing on two fields of the same body (count = 2×
 * instances) simply won't match and stays hoisted; safe, if not optimal.
 */
function inlineExclusiveStyles(
  elements: Record<string, ElementBody>,
  instanceCounts: Map<string, number>,
  styles: GlobalVars["styles"],
  counts: Map<string, number>,
  namedStyleKeys: Set<string>,
): void {
  for (const [hash, body] of Object.entries(elements)) {
    const instanceCount = instanceCounts.get(hash);
    if (instanceCount === undefined) continue;
    const writable = body as Record<string, unknown>;
    for (const field of STYLE_REF_FIELDS) {
      const ref = writable[field];
      if (typeof ref !== "string") continue;
      if (namedStyleKeys.has(ref) || INLINE_TEXT_STYLE_KEY.test(ref)) continue;
      if (!(ref in styles)) continue;
      if (counts.get(ref) === instanceCount) {
        writable[field] = styles[ref];
        delete styles[ref];
      }
    }
  }
}

// Per-instance keys excluded from the hashed body. Everything else (type and all
// styling) is intrinsic to the element and gets shared across instances.
const ELEMENT_OMIT_KEYS = new Set(["id", "name", "children"]);

function bodyOf(node: SimplifiedNode): ElementBody {
  const source = node as unknown as Record<string, unknown>;
  const body: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (!ELEMENT_OMIT_KEYS.has(key)) body[key] = source[key];
  }
  return body as ElementBody;
}

function collectElements(
  nodes: SimplifiedNode[],
  bodiesByHash: Map<string, { body: ElementBody; str: string; count: number }>,
  hashByNode: Map<SimplifiedNode, string>,
): void {
  for (const node of nodes) {
    const body = bodyOf(node);
    // Skip type-only bodies. A `{type}` element would cost more than it saves —
    // a `template=EL-xxxx` ref plus a global entry, versus the bare `[TYPE]` it
    // replaces. Dedup must never grow the payload; bodies with any real styling
    // pay for themselves at 2+ uses and scale with repetition.
    if (Object.keys(body).length > 1) {
      const str = stableStringify(body);
      const id = elementId(str, bodiesByHash);
      const entry = bodiesByHash.get(id);
      if (entry) entry.count += 1;
      else bodiesByHash.set(id, { body, str, count: 1 });
      hashByNode.set(node, id);
    }
    if (node.children) collectElements(node.children, bodiesByHash, hashByNode);
  }
}

/**
 * Content-addressed element id, with a truncated-hash collision guard. The 8-hex
 * slice (32 bits) keeps template refs short but can alias two distinct bodies;
 * letting them share an id would make applyTemplateRefs merge two different
 * elements into one. On a clash we lengthen this body's id until the slot is free
 * or already holds the same body. Deterministic because the walk order is stable.
 */
function elementId(
  str: string,
  bodiesByHash: Map<string, { body: ElementBody; str: string; count: number }>,
): string {
  const fullHash = createHash("sha1").update(str).digest("hex");
  for (let length = 8; length < fullHash.length; length += 4) {
    const id = `EL-${fullHash.slice(0, length)}`;
    const entry = bodiesByHash.get(id);
    if (!entry || entry.str === str) return id;
  }
  return `EL-${fullHash}`;
}

function applyTemplateRefs(
  nodes: SimplifiedNode[],
  hashByNode: Map<SimplifiedNode, string>,
  elements: Record<string, ElementBody>,
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

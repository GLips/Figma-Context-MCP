import { stableStringify } from "./utils.js";
import { sha1Hex } from "./sha1.js";
import type { NodeDelta, SimplifiedNode, StyleValue, TemplateBody } from "./types.js";

/**
 * Post-walk compression pass.
 *
 * Both features here need GLOBAL knowledge that the single-pass walk can't
 * have: you can't tell whether a style or a subtree is used once or a hundred
 * times until the whole tree is built, so this runs over the already-built
 * design, after the walk completes.
 *
 * Two transformations, in this order:
 *   1. Count-gated style hoisting — a style stays in the top-level `styles`
 *      table only when 2+ nodes reference it (or it's a named Figma style);
 *      single-use styles are inlined back onto their node, dropping the
 *      indirection tax.
 *   2. Templates — node bodies (everything except id/name/children) that
 *      appear 2+ times are emitted once into `templates` and each occurrence is
 *      replaced by a compact `{ id, name, template, children? }` reference.
 *
 * The order is for simplicity (hash bodies that are already gated), NOT a
 * correctness requirement. Style ids are content-addressed (see the ref style
 * table's intern), so two structurally-identical subtrees already carry
 * byte-identical refs before gating — they hash to the same template with or
 * without it. And gating only rewrites single-use styles, whose lone reference
 * necessarily sits on a unique, non-repeated body (any repeated body would push
 * the style's count to >= 2), so gating never touches a node that participates
 * in templating. Hashing before or after gating yields the same templates
 * either way.
 *
 * A final step (inlineExclusiveStyles) collapses the double indirection that
 * arises when a surviving style turns out to be used only by the instances of a
 * single template — see below.
 */
export function compressDesign(
  nodes: SimplifiedNode[],
  extraSurfaces: SimplifiedNode[][],
  styles: Record<string, StyleValue>,
  namedStyleKeys: Set<string>,
): {
  nodes: SimplifiedNode[];
  styles: Record<string, StyleValue>;
  templates: Record<string, TemplateBody>;
} {
  // The components sidecar's published children are output too, so they count, inline and
  // template exactly like tree nodes — a style shared between a component's children and the
  // page must stay hoisted, and two identical bodies must template whichever surface they sit on.
  const surfaces = [nodes, ...extraSurfaces];

  // Per-style usage counts, taken before dedup while every node still carries
  // its own style fields. Reused by both the inlining and expansion steps.
  const styleCounts = countStyleRefs(surfaces.flat());

  const surviving = inlineSingleUseStyles(surfaces, styles, namedStyleKeys, styleCounts);
  const { templates, instanceCounts } = deduplicateTemplates(surfaces);
  inlineExclusiveStyles(templates, instanceCounts, surviving, styleCounts, namedStyleKeys);

  return { nodes, styles: surviving, templates };
}

/**
 * The node fields that can carry a styles-table ref (a string key) instead
 * of the inline style value (after gating). This is the authoritative list of
 * what compression hoists; the parity comparator imports it so its
 * expand-then-compare view can't drift from what this pass actually refs. Run
 * tuples inside a `text` array carry a ref the same way — visitStyleRefSlots
 * covers both.
 */
export const STYLE_REF_FIELDS = ["layout", "fill", "stroke", "effects", "textStyle"] as const;

/**
 * Visit every slot on a node (or template body) that can hold a style ref: the
 * style-valued fields plus each `[text, style]` run tuple's style slot. One
 * visitor so counting, single-use inlining, and exclusive-style expansion can't
 * disagree about what a "style slot" is.
 */
function visitStyleRefSlots(
  node: SimplifiedNode | TemplateBody | NodeDelta,
  visit: (value: unknown, set: (value: unknown) => void) => void,
): void {
  const record = node as unknown as Record<string, unknown>;
  for (const field of STYLE_REF_FIELDS) {
    visit(record[field], (value) => {
      record[field] = value;
    });
  }
  const text = record.text;
  if (Array.isArray(text)) {
    for (const run of text) {
      if (Array.isArray(run)) {
        visit(run[1], (value) => {
          run[1] = value;
        });
      }
    }
  }
}

/**
 * Feature 1: replace single-use style refs with their inline value, returning the
 * styles that stay hoisted (used by 2+ nodes, or named styles). Mutates the
 * passed nodes in place (they're owned by this call). A single-use value is
 * referenced by exactly one node, so sharing the value object on inline creates
 * no aliasing.
 */
function inlineSingleUseStyles(
  surfaces: SimplifiedNode[][],
  styles: Record<string, StyleValue>,
  namedStyleKeys: Set<string>,
  counts: Map<string, number>,
): Record<string, StyleValue> {
  const inlineKeys = new Set<string>();
  const dropKeys = new Set<string>();
  for (const key of Object.keys(styles)) {
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

  const walk = (ns: Array<SimplifiedNode | NodeDelta>): void => {
    for (const node of ns) {
      visitStyleRefSlots(node, (value, set) => {
        if (typeof value === "string" && inlineKeys.has(value)) {
          set(styles[value]);
        }
      });
      walk(styleBearingNested(node as SimplifiedNode));
    }
  };
  for (const surface of surfaces) walk(surface);

  const surviving: Record<string, StyleValue> = {};
  for (const [key, value] of Object.entries(styles)) {
    if (!inlineKeys.has(key) && !dropKeys.has(key)) surviving[key] = value;
  }
  return surviving;
}

function countStyleRefs(nodes: SimplifiedNode[]): Map<string, number> {
  const counts = new Map<string, number>();
  const walk = (ns: Array<SimplifiedNode | NodeDelta>): void => {
    for (const node of ns) {
      visitStyleRefSlots(node, (value) => {
        if (typeof value === "string") counts.set(value, (counts.get(value) ?? 0) + 1);
      });
      walk(styleBearingNested(node as SimplifiedNode));
    }
  };
  walk(nodes);
  return counts;
}

/**
 * Everything under a node that can carry a style ref: its children AND every entry of its
 * `overrides` diff.
 *
 * An override delta is a partial node — it holds the same `fill`/`layout`/`textStyle` slots as any
 * node, and a filled slot's delta republishes whole `children`. A traversal that only followed
 * `children` would count those refs as zero uses, and a zero-count ref is treated as single-use and
 * dropped from the table without ever being inlined — leaving the delta pointing at a key that no
 * longer exists. Every style pass therefore descends the same way.
 */
function styleBearingNested(node: SimplifiedNode): Array<SimplifiedNode | NodeDelta> {
  if (!node.overrides) return node.children ?? [];
  return [...(node.children ?? []), ...Object.values(node.overrides)];
}

/** A candidate template during collection: the body, its stable-serialized form, and how many nodes carry it. */
type TemplateCandidate = { body: TemplateBody; str: string; count: number };

/**
 * Feature 2: hash each node body and replace bodies that repeat 2+ times with a
 * template reference, returning the template table and each template's instance
 * count. Mutates nodes in place.
 */
function deduplicateTemplates(surfaces: SimplifiedNode[][]): {
  templates: Record<string, TemplateBody>;
  instanceCounts: Map<string, number>;
} {
  const bodiesByHash = new Map<string, TemplateCandidate>();
  const hashByNode = new Map<SimplifiedNode, string>();
  for (const surface of surfaces) collectTemplateBodies(surface, bodiesByHash, hashByNode);

  const templates: Record<string, TemplateBody> = {};
  const instanceCounts = new Map<string, number>();
  for (const [hash, { body, count }] of bodiesByHash) {
    if (count >= 2) {
      templates[hash] = body;
      instanceCounts.set(hash, count);
    }
  }

  for (const surface of surfaces) applyTemplateRefs(surface, hashByNode, templates);
  return { templates, instanceCounts };
}

/**
 * Stretch optimization: collapse double indirection. When a surviving style is
 * referenced only by the instances of a single template, the output
 * pays twice — `template → style ref → value`. Inline the value into the template
 * body and drop the global entry so it's just `template → value`.
 *
 * The test: a style whose total pre-dedup reference count equals a template's
 * instance count, and which appears in that template's body, can only have come
 * from that template's instances (any other use would push the count higher).
 * Named styles are left hoisted — surfacing design-system intent is worth the
 * indirection. A style appearing on two fields of the same body (count = 2×
 * instances) simply won't match and stays hoisted; safe, if not optimal.
 */
function inlineExclusiveStyles(
  templates: Record<string, TemplateBody>,
  instanceCounts: Map<string, number>,
  styles: Record<string, StyleValue>,
  counts: Map<string, number>,
  namedStyleKeys: Set<string>,
): void {
  for (const [hash, body] of Object.entries(templates)) {
    const instanceCount = instanceCounts.get(hash);
    if (instanceCount === undefined) continue;
    // The body's own slots and those of every override it carries — a template body keeps
    // `overrides` (it is intrinsic to the body), so its refs are part of what this collapses.
    const inlineExclusive = (target: SimplifiedNode | TemplateBody | NodeDelta): void => {
      visitStyleRefSlots(target, (ref, set) => {
        if (typeof ref !== "string") return;
        if (namedStyleKeys.has(ref)) return;
        if (!(ref in styles)) return;
        if (counts.get(ref) === instanceCount) {
          set(styles[ref]);
          delete styles[ref];
        }
      });
      for (const nested of styleBearingNested(target as SimplifiedNode)) inlineExclusive(nested);
    };
    inlineExclusive(body);
  }
}

// Per-instance keys excluded from the hashed body. Everything else (type and all
// styling) is intrinsic to the template and gets shared across instances.
const TEMPLATE_OMIT_KEYS = new Set(["id", "name", "children"]);

function bodyOf(node: SimplifiedNode): TemplateBody {
  const source = node as unknown as Record<string, unknown>;
  const body: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (!TEMPLATE_OMIT_KEYS.has(key)) body[key] = source[key];
  }
  return body as TemplateBody;
}

function collectTemplateBodies(
  nodes: SimplifiedNode[],
  bodiesByHash: Map<string, TemplateCandidate>,
  hashByNode: Map<SimplifiedNode, string>,
): void {
  for (const node of nodes) {
    const body = bodyOf(node);
    // Skip type-only bodies. A `{type}` template would cost more than it saves —
    // a `template=EL-xxxx` ref plus a global entry, versus the bare `[TYPE]` it
    // replaces. Dedup must never grow the payload; bodies with any real styling
    // pay for themselves at 2+ uses and scale with repetition.
    if (Object.keys(body).length > 1) {
      const str = stableStringify(body);
      const id = templateId(str, bodiesByHash);
      const entry = bodiesByHash.get(id);
      if (entry) entry.count += 1;
      else bodiesByHash.set(id, { body, str, count: 1 });
      hashByNode.set(node, id);
    }
    if (node.children) collectTemplateBodies(node.children, bodiesByHash, hashByNode);
  }
}

/**
 * Content-addressed template id (legacy `EL-` prefix), with a truncated-hash
 * collision guard. The 8-hex
 * slice (32 bits) keeps template refs short but can alias two distinct bodies;
 * letting them share an id would make applyTemplateRefs merge two different
 * templates into one. On a clash with a DIFFERENT body we fall back to the full
 * 40-hex hash (matching the ref style table's collision policy), which cannot
 * alias. Deterministic because the walk order is stable.
 */
function templateId(str: string, bodiesByHash: Map<string, TemplateCandidate>): string {
  const fullHash = sha1Hex(str);
  const short = `EL-${fullHash.slice(0, 8)}`;
  const entry = bodiesByHash.get(short);
  if (!entry || entry.str === str) return short;
  return `EL-${fullHash}`;
}

function applyTemplateRefs(
  nodes: SimplifiedNode[],
  hashByNode: Map<SimplifiedNode, string>,
  templates: Record<string, TemplateBody>,
): void {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.children) applyTemplateRefs(node.children, hashByNode, templates);

    const hash = hashByNode.get(node);
    if (hash && templates[hash]) {
      const ref: SimplifiedNode = { id: node.id, name: node.name, template: hash };
      if (node.children && node.children.length > 0) ref.children = node.children;
      nodes[i] = ref;
    }
  }
}

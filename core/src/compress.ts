import { stableStringify } from "./utils.js";
import { sha1Hex } from "./sha1.js";
import type { SimplifyResult } from "./simplify.js";
import type {
  NodeDelta,
  SimplifiedNode,
  StyleRefPrefix,
  StyleValue,
  TemplateBody,
} from "./types.js";

/**
 * The REST egress compression pass, run over `project()`'s expanded output. It is a separate entry
 * (`@framelink/core/compress`) and the only importer of `sha1.ts`, so the plugin preamble — which
 * never compresses — bundles neither (ADR-0004; the preamble build refuses either module).
 *
 * Every step needs GLOBAL knowledge a single-pass walk can't have: you can't tell whether a style
 * or a subtree is used once or a hundred times until the whole tree is built.
 *
 *   1. Interning — every style value is replaced by a content-addressed ref (`fill_a1b2c3d4`).
 *   2. Count-gated hoisting — a ref stays in `styles` only when 2+ slots use it; single-use
 *      values are inlined back onto their node, dropping the indirection tax.
 *   3. Templates — node bodies (everything except id/name/children/elided) that appear 2+ times
 *      are emitted once into `templates`, each occurrence replaced by a compact
 *      `{ id, name, template, children?, elided? }` reference.
 *
 * Gating before templating is for simplicity, NOT correctness: refs are content-addressed, so two
 * structurally-identical subtrees carry byte-identical refs either way, and gating only rewrites
 * single-use styles, whose lone use necessarily sits on a body that doesn't repeat.
 *
 * A final step (inlineExclusiveStyles) collapses the double indirection that arises when a
 * surviving style turns out to be used only by the instances of a single template — see below.
 */
export function compressDesign(read: SimplifyResult): SimplifyResult {
  // The components sidecar's published children are output too, so they count, inline and
  // template exactly like tree nodes — a style shared between a component's children and the
  // page must stay hoisted, and two identical bodies must template whichever surface they sit on.
  const surfaces = [
    read.nodes,
    ...Object.values(read.components).flatMap((entry) => (entry.children ? [entry.children] : [])),
  ];
  const styles = internStyleValues(surfaces);

  // Per-style usage counts, taken before dedup while every node still carries
  // its own style fields. Reused by both the inlining and expansion steps.
  const styleCounts = countStyleRefs(surfaces.flat());

  const surviving = inlineSingleUseStyles(surfaces, styles, styleCounts);
  const { templates, instanceCounts } = deduplicateTemplates(surfaces);
  inlineExclusiveStyles(templates, instanceCounts, surviving, styleCounts);

  return { ...read, styles: surviving, templates };
}

/**
 * Step 1: replace every style value in `surfaces` with a content-addressed ref, in place, and
 * return the table in first-sighting order (the order REST output shows). The same value always
 * gets the same id, so output is byte-stable across runs; a value seen under two slot kinds keeps
 * the prefix of the first.
 */
export function internStyleValues(surfaces: SimplifiedNode[][]): Record<string, StyleValue> {
  const styles: Record<string, StyleValue> = {};
  const refByValue = new Map<string, string>();
  const intern = (value: StyleValue, prefix: StyleRefPrefix): string => {
    const key = stableStringify(value);
    const existing = refByValue.get(key);
    if (existing) return existing;
    // Truncated-hash collision guard. The 8-hex slice (32 bits) keeps refs short but can alias two
    // different values; reusing a taken id would make every node referencing it resolve to the
    // wrong style. The full 40-hex hash cannot collide with a truncated id (different length), and
    // the walk order is stable, so the same file reproduces the same ids.
    const fullHash = sha1Hex(key);
    let ref = `${prefix}_${fullHash.slice(0, 8)}`;
    if (styles[ref] !== undefined) ref = `${prefix}_${fullHash}`;
    styles[ref] = value;
    refByValue.set(key, ref);
    return ref;
  };
  const walk = (nodes: Array<SimplifiedNode | NodeDelta>): void => {
    for (const node of nodes) {
      visitStyleRefSlots(node, (value, set, prefix) => {
        // "none" is a removal word (a TEXT's fill, a LINE's stroke), not a paint to share.
        if (value === undefined || value === "none") return;
        set(intern(value as StyleValue, prefix));
      });
      walk(styleBearingNested(node as SimplifiedNode));
    }
  };
  for (const surface of surfaces) walk(surface);
  return styles;
}

/**
 * The node fields that can carry a styles-table ref (a string key) instead
 * of the inline style value, with the prefix each mints refs under. This is the
 * authoritative list of what compression hoists; the parity comparator imports it so its
 * expand-then-compare view can't drift from what this pass actually refs. Run
 * tuples inside a `text` array carry a ref the same way — visitStyleRefSlots
 * covers both.
 */
const STYLE_REF_PREFIXES = {
  layout: "layout",
  textStyle: "style",
  fill: "fill",
  stroke: "fill",
  effects: "effect",
} as const satisfies Record<string, StyleRefPrefix>;

export const STYLE_REF_FIELDS = Object.keys(STYLE_REF_PREFIXES) as Array<
  keyof typeof STYLE_REF_PREFIXES
>;

/**
 * Visit every slot on a node (or template body) that can hold a style ref: the
 * style-valued fields plus each `[text, style]` run tuple's style slot. One
 * visitor so counting, single-use inlining, and exclusive-style expansion can't
 * disagree about what a "style slot" is.
 */
function visitStyleRefSlots(
  node: SimplifiedNode | TemplateBody | NodeDelta,
  visit: (value: unknown, set: (value: unknown) => void, prefix: StyleRefPrefix) => void,
): void {
  const record = node as unknown as Record<string, unknown>;
  for (const field of STYLE_REF_FIELDS) {
    if (!(field in record)) continue;
    visit(
      record[field],
      (value) => {
        record[field] = value;
      },
      STYLE_REF_PREFIXES[field],
    );
  }
  const text = record.text;
  if (Array.isArray(text)) {
    for (const run of text) {
      if (Array.isArray(run)) {
        visit(
          run[1],
          (value) => {
            run[1] = value;
          },
          "style",
        );
      }
    }
  }
}

/**
 * Step 2: replace single-use style refs with their inline value, returning the
 * styles that stay hoisted (used by 2+ nodes). Mutates the passed nodes in place
 * (they're owned by this call). A single-use value is referenced by exactly one
 * node, so sharing the value object on inline creates no aliasing. A zero-use
 * entry (its node was folded away after interning, e.g. by collapseSvgContainers)
 * lands in `inlineKeys` too: nothing references it, so it is simply dropped.
 */
function inlineSingleUseStyles(
  surfaces: SimplifiedNode[][],
  styles: Record<string, StyleValue>,
  counts: Map<string, number>,
): Record<string, StyleValue> {
  const inlineKeys = new Set<string>();
  for (const key of Object.keys(styles)) {
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
    if (!inlineKeys.has(key)) surviving[key] = value;
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
 * Step 3: hash each node body and replace bodies that repeat 2+ times with a
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
 * A style appearing on two fields of the same body (count = 2×
 * instances) simply won't match and stays hoisted; safe, if not optimal.
 */
function inlineExclusiveStyles(
  templates: Record<string, TemplateBody>,
  instanceCounts: Map<string, number>,
  styles: Record<string, StyleValue>,
  counts: Map<string, number>,
): void {
  for (const [hash, body] of Object.entries(templates)) {
    const instanceCount = instanceCounts.get(hash);
    if (instanceCount === undefined) continue;
    // The body's own slots and those of every override it carries — a template body keeps
    // `overrides` (it is intrinsic to the body), so its refs are part of what this collapses.
    const inlineExclusive = (target: SimplifiedNode | TemplateBody | NodeDelta): void => {
      visitStyleRefSlots(target, (ref, set) => {
        if (typeof ref !== "string") return;
        if (!Object.prototype.hasOwnProperty.call(styles, ref)) return;
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
// styling) is intrinsic to the template and gets shared across instances. `elided` sizes what was
// cut from THIS node, so it stays on the reference rather than splitting otherwise-equal bodies.
const TEMPLATE_OMIT_KEYS = new Set(["id", "name", "children", "elided"]);

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
      if (node.elided) ref.elided = node.elided;
      nodes[i] = ref;
    }
  }
}

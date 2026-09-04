import type { TemplateBody, SimplifiedDesign, SimplifiedNode, StyleValue } from "~/core/types.js";
// Single-sourced from the compression pass so the parity view resolves EXACTLY
// the slots the compression pass can hoist — the two can't silently diverge.
import { STYLE_REF_FIELDS } from "~/core/compress.js";
// Same reason: the comparator has to skip a group's rotation exactly where the two
// producers skip it, or it classifies a group child into the wrong band.
import { isCoordinateTransparentType } from "~/core/utils.js";

/**
 * The comparator policy for the REST↔plugin parity harness — "shared subset" as
 * code, not vibes.
 *
 * Both producers (`restNodeToSnapshot` → core, and the plugin's
 * `sceneNodeToSnapshot` → core) must emit ONE canonical output. But they can
 * legitimately differ in incidental detail while agreeing semantically. This
 * module reduces a `SimplifiedDesign` to the shared view both producers must
 * match, so a diff over the reduced views is a real parity failure — never a
 * false alarm from a difference the producers are allowed to have.
 *
 * `parityView` does two things, in order:
 *   1. EXPAND (`expandInline`) — resolve every `styles`/`templates` ref back
 *      to its inline value. This is load-bearing: the compression pass keys
 *      styles by a content hash of their value and disambiguates same-name
 *      styles with an id suffix, so two producers whose style values differ in
 *      ANY byte (e.g. an image ref buried in a hoisted fill, or a future plugin
 *      enrichment) get different keys and different node refs. Comparing keys
 *      would drown real parity in keyspace noise. After expansion there are no
 *      keys — only values — so the comparison is over what the output actually
 *      means.
 *   2. SCOPE — normalize/drop the enumerated spots where producers legitimately
 *      differ (see the per-spot pins below).
 *
 * ── The seven legitimate-difference spots (plan Phase 4), each pinned ──
 *
 *  1. IMAGE REFS (`imageRef`/`gifRef`). The two producers name the same asset
 *     with different ids (REST's file-scoped `imageRef` vs the plugin's own
 *     handle), so we compare by PRESENCE, not literal id: every image paint's
 *     ref is rewritten to a sentinel. `gifRef` goes further and is dropped
 *     entirely — the plugin API has no gif visibility at all (an ImagePaint
 *     carries only `imageHash`), so even its presence is producer-specific.
 *     Refs can hide inside a hoisted, hashed fill — hence expansion runs first,
 *     surfacing them onto the node where the rewrite reaches them.
 *     (`decodePaint`/`parsePaint`, `core/transformers/style.ts`.)
 *
 *  2. COMPONENT-TABLE METADATA. The shared part of the `components`/
 *     `componentSets` tables is exactly what the core WALK produces — an id and
 *     its `propertyDefinitions`. The table's `name`/`key`/`description`/
 *     `componentSetId` are producer-ASSEMBLY provenance: REST reads them from the
 *     published-library tables in the response envelope; the plugin assembles its
 *     own. We reduce both tables to a single id→`{propertyDefinitions}` map, which
 *     also erases the components-vs-sets split (itself an assembly choice).
 *
 *  3. SAME-NAME STYLE DISAMBIGUATION (`resolveStyleKey`, `core/style-table.ts`).
 *     The `Name (id)` suffix only exists as a styles-table KEY. Expansion resolves
 *     refs to values, so the key — and any producer disagreement about it —
 *     is gone before comparison.
 *
 *  4. ROOT CONTEXTUAL SIZING (`core/transformers/layout.ts`). A node is "root"
 *     when it has no parent in the input array; the root's spurious FIXED axis
 *     becomes `contextual`. Which node is root is a function of what each producer
 *     is handed as top-level, so this agrees BY CONSTRUCTION when both are fed the
 *     same root subtree — which the harness guarantees. No normalization; pinned
 *     here so a future producer that reads a different selection root is a known,
 *     out-of-scope divergence, not a mystery.
 *
 *  5. SVG COLLAPSE (`collapseSvgContainers`, `core/simplify.ts`) and
 *  6. HIDDEN COMPONENT-PROPERTY NODES (`shouldProcessNode`,
 *     `core/simplify.ts`) are both pure CORE behavior over the snapshot —
 *     identical for identical snapshots, so parity holds by construction. No
 *     normalization; the fixtures exercise them (the component-instance fixture's
 *     hidden Sale Ribbon is rescued by rule 6) so a regression in the shared core
 *     still fails the harness.
 *
 *  7. ROTATIONS REST CAN'T INVERT (`solveOwnBox`, `adapters/rest/own-box.ts`).
 *     The plugin READS a node's own size and origin off the live node; REST has to
 *     invert them out of the page-space AABB, and two families of angle defeat that.
 *
 *     At odd multiples of 45° the inversion has no solution at all (see
 *     `DEGENERATE_DETERMINANT` there) and REST emits the AABB numbers, so the
 *     producers disagree on `width`/`height`/`left`/`top` for the node itself.
 *
 *     At a HALF-TURN the size still inverts, but the corner doesn't: `rotation` is
 *     `atan2(-m10, m00)`, which reads a horizontally flipped node as 180° too, and
 *     the two place the origin a full height apart. REST withholds the origin rather
 *     than guess, so the producers disagree on `left`/`top` only.
 *
 *     Either way a node whose own corner REST couldn't place takes its children's
 *     `left`/`top` down with it — those are measured against that corner. We drop
 *     exactly those fields on exactly those nodes, and only where they are
 *     MEASUREMENTS: the sizing words that share the `width`/`height` slot are read
 *     off the sizing flags, not solved, so a divergence in those is real. Everything
 *     else about a rotated node, `rotation` above all, still has to match. The
 *     rotated-nodes fixture carries one of each, plus a child under each.
 *
 *     Residuals, deliberately NOT normalized — both are mirrors REST cannot see,
 *     since the payload carries no transform determinant and `rotation` alone can't
 *     betray a reflection:
 *       - a VERTICAL flip reads 0°, where REST returns the AABB corner while the
 *         plugin reads a `node.y` one full height lower (Shift+V puts the transform's
 *         translation at the visual bottom-left);
 *       - a flip COMBINED with a rotation reads as θ−180°, an ordinary-looking angle
 *         whose solved origin is wrong by the node's height.
 *     A rule keyed on `rotation` can't detect either, so pinning them would mean
 *     forgiving `left`/`top` at 0° and at every angle. A mirrored fixture is expected
 *     to fail here; that is this note, not a mystery.
 */

/** Every image paint's ref collapses to this — parity is over presence, not id. */
const IMAGE_REF_SENTINEL = "<image-ref>";

/**
 * Node fields the plugin will additively emit beyond the REST-shared CSS subset
 * (read-plan Phase 5: beyond-CSS effects, bound variables, dev-mode data).
 * Stripped from every node before comparison so plugin enrichments never fail
 * parity (plan Warning). Empty today — the REST producer emits nothing here; the
 * read plan adds an entry as each enrichment lands, and if an enrichment nests
 * inside a style value rather than a top-level node field, extend the scope in
 * `scopeStyleValue` alongside.
 */
const PLUGIN_ONLY_FIELDS = new Set<string>([]);

type Rec = Record<string, unknown>;

function resolveRef(value: unknown, styles: Record<string, StyleValue>): unknown {
  return typeof value === "string" && value in styles ? styles[value] : value;
}

/** Collapse image-paint refs to the sentinel; pass every other fill through. */
function scopeStyleValue(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((entry) => {
    if (entry && typeof entry === "object" && (entry as Rec).type === "IMAGE") {
      const fill = { ...(entry as Rec) };
      if ("imageRef" in fill) fill.imageRef = IMAGE_REF_SENTINEL;
      delete fill.gifRef;
      return fill;
    }
    return entry;
  });
}

/**
 * `|cos 2θ|` below which the REST producer refuses to invert an AABB back into
 * the node's own box — the same threshold `solveOwnBox` holds (see pin 7). Kept
 * as a literal rather than imported: the comparator states the policy the
 * producers must satisfy, and importing the adapter's constant would let a
 * widened band silently widen what parity forgives.
 */
const DEGENERATE_DETERMINANT = 0.0105;

/** Mirrors `HALF_TURN_TOLERANCE_DEG` in the adapter, for the same reason. */
const HALF_TURN_TOLERANCE_DEG = 0.01;

/**
 * Whether a node's rotation puts the REST inversion in the unsolvable band, and so
 * costs its SIZE as well as its corner. The angle is the node's PAGE rotation (its
 * own plus every ancestor's), because the AABB REST inverts is page-axis-aligned;
 * the emitted sign convention doesn't matter, `cos 2θ` is even.
 */
function inDegenerateBand(pageRotationDeg: number): boolean {
  return Math.abs(Math.cos((2 * pageRotationDeg * Math.PI) / 180)) < DEGENERATE_DETERMINANT;
}

/** Whether a rotation is the half-turn a horizontal flip forges, costing the corner. */
function isHalfTurn(pageRotationDeg: number): boolean {
  const wrapped = Math.abs(((pageRotationDeg % 360) + 360) % 360);
  return Math.abs(wrapped - 180) < HALF_TURN_TOLERANCE_DEG;
}

/**
 * Reduce one node to its shared parity view: expand its template + style refs,
 * normalize image refs, drop plugin-only fields, recurse. One pass so expansion
 * and scoping can't disagree about a node's shape.
 *
 * `space` carries what pin 7 needs from the ancestors: the accumulated page
 * rotation, and whether the immediate parent's own corner was placeable at all.
 */
function viewNode(
  node: SimplifiedNode,
  styles: Record<string, StyleValue>,
  templates: Record<string, TemplateBody>,
  space: { pageRotation: number; parentCornerUnplaceable: boolean } = {
    pageRotation: 0,
    parentCornerUnplaceable: false,
  },
): Rec {
  const source = node as unknown as Rec;

  // Templated bodies live in `templates`; the ref node keeps only id/name/children.
  let merged: Rec = source;
  if (typeof source.template === "string" && templates[source.template]) {
    merged = {
      ...(templates[source.template] as unknown as Rec),
      id: source.id,
      name: source.name,
    };
    if (source.children) merged.children = source.children;
  }

  const out: Rec = {};
  for (const [key, value] of Object.entries(merged)) {
    if (key === "template" || PLUGIN_ONLY_FIELDS.has(key)) continue;
    out[key] = value;
  }

  for (const field of STYLE_REF_FIELDS) {
    if (field in out) out[field] = scopeStyleValue(resolveRef(out[field], styles));
  }

  // Text runs carry a per-run style ref in their `[text, style]` tuple slot.
  if (Array.isArray(out.text)) {
    out.text = out.text.map((run) =>
      Array.isArray(run) ? [run[0], resolveRef(run[1], styles)] : run,
    );
  }

  // Pin 7. In the degenerate band REST substitutes the AABB for the whole own box,
  // so the SIZE goes too; at a half-turn only the corner is unrecoverable. Either
  // way a direct child's parent-relative origin goes with the parent's corner.
  // Dropped from both views — the disagreement is legitimate, and anything else
  // about these nodes (`rotation` above all) still has to match.
  //
  // Only MEASUREMENTS drop. `width`/`height` also carry the sizing words
  // ("fill"/"hug"/"contextual"), which are read off the sizing flags and owe nothing
  // to the inversion — forgiving those would let a real sizing-intent divergence hide
  // inside the band. `designedWidth`/`designedHeight` are the root's measurement in
  // string clothing, fed from the same solved size, so they go with the numbers.
  const pageRotation = space.pageRotation + (typeof out.rotation === "number" ? out.rotation : 0);
  const degenerate = inDegenerateBand(pageRotation);
  const cornerUnplaceable = degenerate || isHalfTurn(pageRotation);
  if (degenerate) {
    if (typeof out.width === "number") delete out.width;
    if (typeof out.height === "number") delete out.height;
    delete out.designedWidth;
    delete out.designedHeight;
  }
  if (cornerUnplaceable || space.parentCornerUnplaceable) {
    delete out.left;
    delete out.top;
  }

  if (Array.isArray(out.children)) {
    // A coordinate-transparent parent (GROUP/BOOLEAN_OPERATION) is not a rotation of
    // its own as far as its children are concerned — their emitted `rotation` is already
    // stated against the container above it, so accumulating the group's again would put
    // the wrong angle into the band test. The producers skip it for the same reason.
    const childPageRotation = isCoordinateTransparentType(out.type as string | undefined)
      ? space.pageRotation
      : pageRotation;
    out.children = out.children.map((child) =>
      viewNode(child as SimplifiedNode, styles, templates, {
        pageRotation: childPageRotation,
        parentCornerUnplaceable: cornerUnplaceable,
      }),
    );
  }

  return out;
}

/**
 * Reduce both component tables to the shared id→{propertyDefinitions} view.
 *
 * Only ids that carry `propertyDefinitions` survive — that set is exactly what
 * the core WALK produces (`extractComponent` records a def only for an in-tree
 * COMPONENT/COMPONENT_SET with non-empty BOOLEAN/TEXT props). REST's envelope
 * tables ALSO list components with no shared props (variant/instance-swap-only,
 * or a master on another page); those reduce to nothing shared, so we DROP them
 * rather than keep a `{}` entry the plugin producer — which builds its table from
 * the walk alone — could never match. Keeping them would fail parity on table
 * membership even when the producers agree on every shared field.
 */
function scopeComponentTables(design: SimplifiedDesign): Record<string, Rec> {
  const out: Record<string, Rec> = {};
  for (const table of [design.components, design.componentSets]) {
    for (const [id, def] of Object.entries(table ?? {})) {
      const propertyDefinitions = (def as Rec).propertyDefinitions;
      if (propertyDefinitions) out[id] = { propertyDefinitions };
    }
  }
  return out;
}

/**
 * The shared view a design reduces to for cross-producer comparison. Two
 * producers pass parity iff their views are deep-equal. Excludes the top-level
 * design `name` (file/page metadata, provenance-divergent and gated elsewhere)
 * and the now-empty `styles`/`templates` (folded inline by expansion).
 */
export function parityView(design: SimplifiedDesign): {
  nodes: Rec[];
  components: Record<string, Rec>;
} {
  const styles: Record<string, StyleValue> = design.styles ?? {};
  const templates = design.templates ?? {};
  return {
    nodes: design.nodes.map((node) => viewNode(node, styles, templates)),
    components: scopeComponentTables(design),
  };
}

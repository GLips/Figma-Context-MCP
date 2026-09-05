import type { NodeSnapshot } from "./snapshot.js";
import type { SimplifiedTextStyle, TextRun } from "./transformers/text.js";
import type { NodeGeometry, SimplifiedLayout } from "./transformers/layout.js";
import type { SimplifiedFill } from "./transformers/style.js";
import type { SimplifiedEffects } from "./transformers/effects.js";
import type { SimplifiedPropertyDefinition } from "./transformers/component.js";

export type StyleValue =
  | SimplifiedTextStyle
  | SimplifiedFill
  | SimplifiedFill[]
  | SimplifiedLayout
  | SimplifiedEffects
  | string;

/**
 * The namespaces auto-generated style ref ids are minted under
 * (`fill_a1b2c3d4`). Closed set: the four value kinds the walk interns.
 */
export type StyleRefPrefix = "layout" | "style" | "fill" | "effect";

/**
 * Where the walk sends the style values it builds. The table decides the
 * output form, which is what makes compression separable from the walk
 * (Invariant 3): the compressing table interns values under content-addressed
 * refs (hashing DURING the walk), while the inline table hands the value
 * straight back for inline emission and never touches a hash. Gating only the
 * post-walk compression pass would not be enough — refs and sha1 fire inside
 * the walk — so the table is the seam expanded mode swaps.
 */
export interface StyleTable {
  /**
   * Intern a style value for a node. Returns a ref key (compressing table) or
   * the value itself (inline table). `styleKeys` are the node style slots
   * (e.g. `["fill", "fills"]`) checked for a Figma named style; pass `[]` for
   * value kinds Figma can't name (layout).
   */
  intern<T extends StyleValue>(
    node: NodeSnapshot,
    value: T,
    styleKeys: string[],
    prefix: StyleRefPrefix,
  ): string | T;
  /**
   * Everything the table hoisted, in interning order. Compressing table: all
   * shared styles (pre-compression). Inline table: always empty — every value
   * is handed straight back for inline emission.
   */
  readonly styles: Record<string, StyleValue>;
}

/**
 * Cooperative-yield hook awaited by the walker every N nodes. Injected rather
 * than hardcoded because the core must not touch Node builtins (Invariant 4):
 * the REST server passes an event-loop yield (`setImmediate`) so heartbeats and
 * SIGINT stay live during large files; the plugin bundle omits it or supplies
 * its own.
 */
export type WalkScheduler = () => void | Promise<void>;

/**
 * Mutable progress counter passed into traversal. Callers can read `count`
 * during traversal (for live progress indicators) and after it returns
 * (as the final node-walked metric).
 */
export type NodeCounter = { count: number };

export interface TraversalOptions {
  maxDepth?: number;
  /**
   * Optional caller-supplied counter. The walker increments it as it processes
   * nodes, so callers that need a live readout (e.g. progress heartbeats) or a
   * post-call metric can read from the same object. If omitted, the walker
   * creates its own internal counter.
   */
  nodeCounter?: NodeCounter;
  /** Cooperative-yield hook, awaited every YIELD_INTERVAL nodes. No yield when omitted. */
  scheduler?: WalkScheduler;
}

/**
 * One component (or component set) the read referenced, named ONCE.
 *
 * The sidecar exists because a component's `children` are the same bytes for every instance
 * of it: emitting them here once and each instance as a diff is the whole point of the shape.
 * It is keyed by component id and sits BESIDE the node tree — it is response data, not node
 * data, which is why `flcm.get` returns `{ node, components }` rather than hanging a
 * root-only field off the node it hands back.
 *
 * Both producers fill it. REST reads provenance from its response tables; the plugin reads it
 * off the `getMainComponentAsync()` node it already resolves. That symmetry is what retired
 * the REST-only `components`/`componentSets` tables (parity pin 2) and what makes an
 * instance's variant recoverable through the plugin — `componentId` plus this `name`.
 */
export interface SimplifiedComponentEntry {
  /** COMPONENT or COMPONENT_SET. A set owns the variant axes; its variants are separate entries. */
  type: string;
  name: string;
  /** Publish key. Absent on a component that was never published. */
  key?: string;
  /** COMPONENT: the variant set it belongs to, when it is a variant. */
  componentSetId?: string;
  /** COMPONENT_SET only. */
  description?: string;
  /**
   * The properties this definition owns. Figma keeps a variant's definitions on the SET, so a
   * variant COMPONENT carries none. Lives here rather than on the defining node because an
   * off-tree component has no node to carry them.
   */
  propertyDefinitions?: Record<string, SimplifiedPropertyDefinition>;
  /**
   * The definition's subtree, emitted once. Absent when nothing in the read could supply it —
   * a component referenced only by name, with no definition fetched and no instance to donate.
   *
   * The node's OWN styling is not here: every instance already carries its own fills/layout/
   * radius on the instance node, and an in-tree definition carries them on its node.
   */
  children?: SimplifiedNode[];
  /**
   * Present ONLY when `children` were donated by an instance rather than read from the
   * definition — the id of the instance they came from. A warning with a name: that instance's
   * own edits are baked into these children, so they are a worked example rather than the
   * pristine component. Absent means the children ARE the definition's.
   */
  childrenFrom?: string;
}

export interface SimplifiedDesign {
  name: string;
  nodes: SimplifiedNode[];
  /** Every component and component set the read referenced (see SimplifiedComponentEntry). */
  components: Record<string, SimplifiedComponentEntry>;
  /** Hoisted styles: shared + named styles under ref keys. */
  styles: Record<string, StyleValue>;
  /**
   * Deduplicated node bodies, keyed by content hash (`EL-xxxxxxxx`). Populated
   * by the compression pass: when a node body (everything except id/name/children)
   * appears 2+ times, it is emitted here once and each occurrence is replaced by
   * a compact `template` reference. Empty when nothing repeats.
   */
  templates: Record<string, TemplateBody>;
}

/**
 * A node body with the per-instance keys removed. This is what gets hoisted into
 * `SimplifiedDesign.templates` and referenced by `SimplifiedNode.template`. `type`
 * is part of the body (it's intrinsic to the template), so a template reference
 * carries no `type` of its own — consumers resolve it via the template entry.
 */
export type TemplateBody = Omit<SimplifiedNode, "id" | "name" | "children" | "template">;

// Per-node geometry (width/height/position/rotation/…) sits at the node top
// level per the canonical vocabulary's hybrid structure — inherited from
// NodeGeometry so the extractor and the type can't drift.
export interface SimplifiedNode extends NodeGeometry {
  id: string;
  // Always populated during simplification, but the serialization pass drops it
  // when it is noise (auto-generated like `Rectangle 12`, or redundant with the
  // node's `text`), so the output shape treats it as optional.
  name?: string;
  type?: string; // e.g. FRAME, TEXT, INSTANCE, RECTANGLE, etc. Absent on template refs (type lives in the template body).
  /**
   * Reference into `SimplifiedDesign.templates`. When set, the node's body lives
   * in the shared template and only id/name/children/template are kept here.
   */
  template?: string;
  // container config (grouped) — a styles ref or the inline value
  layout?: string | SimplifiedLayout;
  // text — a plain string, or run segments when some span carries a style
  // markdown can't express (see TextRun)
  text?: string | TextRun[];
  textStyle?: string | SimplifiedTextStyle;
  /**
   * The numeric font weight that `**bold**` inside `text` maps to. Only emitted
   * when a text node has per-character bold overrides heavier than its base
   * `style.fontWeight`, so the consumer knows how to realize markdown bold.
   */
  boldWeight?: number;
  // appearance — each style field holds either a styles-table reference (when
  // the value is shared by 2+ nodes or is a named Figma style) or the inline
  // value itself (single-use values, after the compression pass).
  //
  // A paint slot names the SLOT, not the count (CSS `background`): ONE paint
  // when that is what a viewer sees, an array only for a genuinely stacked
  // paint that can't flatten (see foldPaintStack). A ref string and an inline
  // color are both strings — a reader tells them apart by looking the value up
  // in the design's `styles` table, never by shape.
  fill?: string | SimplifiedFill | SimplifiedFill[];
  stroke?: string | SimplifiedFill | SimplifiedFill[];
  // Non-stylable stroke properties are kept on the node when stroke uses a named color style
  strokeWidth?: string;
  strokeDashes?: number[];
  strokeAlign?: "outside" | "center";
  effects?: string | SimplifiedEffects;
  opacity?: number;
  borderRadius?: string;
  // component data — an INSTANCE names its main component and the property values it
  // resolved; the definition's own properties and children live in the components sidecar
  // (SimplifiedComponentEntry), keyed by that id, which is the one place both an in-tree and
  // an off-tree definition can be named. Any component sublayer names the property that
  // drives one of its fields, keyed by that output field
  // (`visible` / `text` / `componentId` / `slot`).
  componentId?: string;
  componentProperties?: Record<string, boolean | string>;
  componentPropertyReferences?: Record<string, string>;
  /**
   * Only ever `false`, and only ever inside an `overrides` delta: the read shape covers the
   * RENDERED document, so a visible node never says so. A layer the designer hid by hand inside
   * an instance is a real difference from the component, and dropping the node silently would
   * lose it — so the delta says the node is hidden instead of shipping the node.
   */
  visible?: boolean;
  /**
   * INSTANCE only: how this instance differs from its component's `children`, so the instance
   * itself carries none. Keyed by COMPONENT-RELATIVE PATH — the sublayer's id with its
   * enclosing instance stripped (`11:9`, `11:9;11:14`), which is the same path in every
   * instance of the component and in the definition itself. Two reconstructions, one rule each:
   * the live node is `I<instanceId>;<path>`, and the definition's node is `<path>` for a single
   * segment or `I<path>` for two or more (Figma carries exactly one leading `I`).
   *
   * Each value is a partial node: only the fields that differ. A sublayer the designer hid by
   * hand reads as `visible: false` — the definition has the node and the instance does not.
   * A sublayer whose child LIST differs (a filled slot) carries its whole `children` array
   * rather than a per-child diff, because that content is new rather than changed.
   */
  overrides?: Record<string, SimplifiedNode>;
  // children
  children?: SimplifiedNode[];
}

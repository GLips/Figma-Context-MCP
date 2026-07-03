import type { NodeSnapshot } from "./snapshot.js";
import type { SimplifiedTextStyle, TextRun } from "~/core/transformers/text.js";
import type { NodeGeometry, SimplifiedLayout } from "~/core/transformers/layout.js";
import type { SimplifiedFill } from "~/core/transformers/style.js";
import type { SimplifiedEffects } from "~/core/transformers/effects.js";
import type {
  SimplifiedComponentDefinition,
  SimplifiedComponentSetDefinition,
  SimplifiedPropertyDefinition,
} from "~/core/transformers/component.js";

export type StyleTypes =
  | SimplifiedTextStyle
  | SimplifiedFill[]
  | SimplifiedLayout
  | SimplifiedEffects
  | string;

export type GlobalVars = {
  styles: Record<string, StyleTypes>;
};

/**
 * Where extractors send the style values they build. The sink decides the
 * output form, which is what makes compression separable from the walk
 * (Invariant 3): the compressing sink registers values under content-addressed
 * refs (hashing DURING the walk), while the inline sink hands the value
 * straight back for inline emission and never touches a hash. Gating only the
 * post-walk `finalize` pass would not be enough — refs and sha1 fire inside
 * the extractors — so the sink is the seam expanded mode swaps.
 */
export interface StyleSink {
  /**
   * Register a style value for a node. Returns a globalVars ref (compressing
   * sink) or the value itself (inline sink). `styleKeys` are the node style
   * slots (e.g. `["fill", "fills"]`) checked for a Figma named style; pass `[]`
   * for value kinds Figma can't name (layout).
   */
  register<T extends StyleTypes>(
    node: NodeSnapshot,
    value: T,
    styleKeys: string[],
    prefix: string,
  ): string | T;
  /**
   * Everything the sink hoisted, in registration order. Compressing sink: all
   * shared styles (pre-finalize). Inline sink: always empty — every value is
   * handed straight back for inline emission.
   */
  readonly styles: Record<string, StyleTypes>;
}

/**
 * Cooperative-yield hook awaited by the walker every N nodes. Injected rather
 * than hardcoded because the core must not touch Node builtins (Invariant 4):
 * the REST server passes an event-loop yield (`setImmediate`) so heartbeats and
 * SIGINT stay live during large files; the plugin bundle omits it or supplies
 * its own.
 */
export type WalkScheduler = () => void | Promise<void>;

/** Per-component-id property definitions collected during the walk. */
export type ComponentDefinitionMap = Record<string, Record<string, SimplifiedPropertyDefinition>>;

export interface CanonicalizeContext {
  /** Style-registration sink — the compression seam (see StyleSink). */
  styles: StyleSink;
  /** Sink for COMPONENT/COMPONENT_SET property definitions found in the tree. */
  componentDefs: ComponentDefinitionMap;
  currentDepth: number;
  parent?: NodeSnapshot;
  insideComponentDefinition?: boolean;
  /**
   * Per-call mutable counter shared with the caller. Lives on the context so
   * walker recursion can increment it without touching module-global state —
   * concurrent extractFromDesign calls (e.g. overlapping HTTP requests) each
   * own their counter and never collide.
   */
  nodeCounter: NodeCounter;
}

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

export interface SimplifiedDesign {
  name: string;
  nodes: SimplifiedNode[];
  components: Record<string, SimplifiedComponentDefinition>;
  componentSets: Record<string, SimplifiedComponentSetDefinition>;
  globalVars: GlobalVars;
  /**
   * Deduplicated element bodies, keyed by content hash (`EL-xxxxxxxx`). Populated
   * by the finalize pass: when a node body (everything except id/name/children)
   * appears 2+ times, it is emitted here once and each occurrence is replaced by
   * a compact `template` reference. Empty when nothing repeats.
   */
  elements: Record<string, ElementBody>;
}

/**
 * A node body with the per-instance keys removed. This is what gets hoisted into
 * `SimplifiedDesign.elements` and referenced by `SimplifiedNode.template`. `type`
 * is part of the body (it's intrinsic to the element), so a template reference
 * carries no `type` of its own — consumers resolve it via the element entry.
 */
export type ElementBody = Omit<SimplifiedNode, "id" | "name" | "children" | "template">;

// Per-node geometry (width/height/position/rotation/…) sits at the node top
// level per the canonical vocabulary's hybrid structure — inherited from
// NodeGeometry so the extractor and the type can't drift.
export interface SimplifiedNode extends NodeGeometry {
  id: string;
  // Always populated during simplification, but the serialization pass drops it
  // when it is noise (auto-generated like `Rectangle 12`, or redundant with the
  // node's `text`), so the output shape treats it as optional.
  name?: string;
  type?: string; // e.g. FRAME, TEXT, INSTANCE, RECTANGLE, etc. Absent on template refs (type lives in the element).
  /**
   * Reference into `SimplifiedDesign.elements`. When set, the node's body lives
   * in the shared element and only id/name/children/template are kept here.
   */
  template?: string;
  // container config (grouped) — a globalVars ref or the inline value
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
  // appearance — each style field holds either a globalVars reference (when the
  // value is shared by 2+ nodes or is a named Figma style) or the inline value
  // itself (single-use values, after the finalize pass).
  fills?: string | SimplifiedFill[];
  strokes?: string | SimplifiedFill[];
  // Non-stylable stroke properties are kept on the node when stroke uses a named color style
  strokeWidth?: string;
  strokeDashes?: number[];
  strokeAlign?: "outside" | "center";
  effects?: string | SimplifiedEffects;
  opacity?: number;
  borderRadius?: string;
  componentId?: string;
  componentProperties?: Record<string, boolean | string>;
  componentPropertyReferences?: Record<string, string>;
  // children
  children?: SimplifiedNode[];
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

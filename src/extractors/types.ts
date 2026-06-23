import type { Node as FigmaDocumentNode, Style } from "@figma/rest-api-spec";
import type { SimplifiedTextStyle } from "~/transformers/text.js";
import type { SimplifiedLayout } from "~/transformers/layout.js";
import type { SimplifiedFill, SimplifiedStroke } from "~/transformers/style.js";
import type { SimplifiedEffects } from "~/transformers/effects.js";
import type {
  SimplifiedComponentDefinition,
  SimplifiedComponentSetDefinition,
  SimplifiedPropertyDefinition,
} from "~/transformers/component.js";

export type StyleTypes =
  | SimplifiedTextStyle
  | SimplifiedFill[]
  | SimplifiedLayout
  | SimplifiedStroke
  | SimplifiedEffects
  | string;

export type GlobalVars = {
  styles: Record<string, StyleTypes>;
};

export interface TraversalContext {
  globalVars: GlobalVars;
  extraStyles?: Record<string, Style>;
  currentDepth: number;
  parent?: FigmaDocumentNode;
  insideComponentDefinition?: boolean;
  traversalState: TraversalState;
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

export interface TraversalState {
  componentPropertyDefinitions: Record<string, Record<string, SimplifiedPropertyDefinition>>;
  /**
   * Sequential counter for inline text-style override IDs (`ts1`, `ts2`, ...).
   * Lives on the traversal state so every text node in a run shares the same
   * namespace, which lets `{tsN}…{/tsN}` references appear inline in text
   * content with short, readable identifiers.
   */
  tsCounter: number;
  /**
   * globalVars keys that correspond to named Figma styles (vs. auto-generated
   * content-hash ids). The finalize pass keeps these hoisted even at a single
   * use, because a named style encodes design-system intent worth surfacing.
   * Collected during the walk because the post-walk pass can't otherwise tell a
   * named-style key apart from an auto-generated one by inspection.
   */
  namedStyleKeys: Set<string>;
}

export interface TraversalOptions {
  maxDepth?: number;
  nodeFilter?: (node: FigmaDocumentNode) => boolean;
  /**
   * Called after children are processed, allowing modification of the parent node
   * and control over which children to include in the output.
   *
   * @param node - Original Figma node
   * @param result - SimplifiedNode being built (can be mutated)
   * @param children - Processed children
   * @returns Children to include (return empty array to omit children)
   */
  afterChildren?: (
    node: FigmaDocumentNode,
    result: SimplifiedNode,
    children: SimplifiedNode[],
  ) => SimplifiedNode[];
  /**
   * Optional caller-supplied counter. The walker increments it as it processes
   * nodes, so callers that need a live readout (e.g. progress heartbeats) or a
   * post-call metric can read from the same object. If omitted, the walker
   * creates its own internal counter.
   */
  nodeCounter?: NodeCounter;
}

/**
 * An extractor function that can modify a SimplifiedNode during traversal.
 *
 * @param node - The current Figma node being processed
 * @param result - SimplifiedNode object being built—this can be mutated inside the extractor
 * @param context - Traversal context including globalVars and parent info. This can also be mutated inside the extractor.
 */
export type ExtractorFn = (
  node: FigmaDocumentNode,
  result: SimplifiedNode,
  context: TraversalContext,
) => void;

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

export interface SimplifiedNode {
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
  // text
  text?: string;
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
  styles?: string;
  strokes?: string | SimplifiedFill[];
  // Non-stylable stroke properties are kept on the node when stroke uses a named color style
  strokeWeight?: string;
  strokeDashes?: number[];
  strokeWeights?: string;
  strokeAlign?: "INSIDE" | "OUTSIDE" | "CENTER";
  effects?: string | SimplifiedEffects;
  opacity?: number;
  borderRadius?: string;
  // layout & alignment
  layout?: string | SimplifiedLayout;
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

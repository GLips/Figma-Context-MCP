import { isRectangleCornerRadii, isVisible } from "./utils.js";
import { buildSimplifiedLayout } from "./transformers/layout.js";
import { buildSimplifiedStrokes, parsePaint } from "./transformers/style.js";
import { buildSimplifiedEffects } from "./transformers/effects.js";
import {
  buildFormattedText,
  extractTextStyle,
  hasTextStyle,
  isTextNode,
} from "./transformers/text.js";
import {
  simplifyComponentProperties,
  simplifyPropertyDefinitions,
  simplifyPropertyReferences,
} from "./transformers/component.js";
import { rememberRead, captureRead, type ReadContext } from "./read-context.js";
import {
  createComponentNotes,
  componentCatalog,
  describeInstanceChanges,
  noteComponent,
} from "./components.js";
import type { ComponentNotes } from "./components.js";
import type { NodeSnapshot } from "./snapshot.js";
import type {
  NodeCounter,
  SimplifiedComponentEntry,
  SimplifiedNode,
  StyleValue,
  TemplateBody,
  WalkScheduler,
} from "./types.js";

export interface SimplifyOptions {
  scheduler?: WalkScheduler;
  nodeCounter?: NodeCounter;
  componentDefinitions?: NodeSnapshot[];
}

export interface SimplifyResult {
  elided?: { id: string; elided: import("./types.js").Elision }[];
  nodes: SimplifiedNode[];
  /**
   * Hoisted styles. Compressed: shared + named styles under ref keys.
   * Expanded: always empty — every value (run deltas included) emits inline.
   */
  styles: Record<string, StyleValue>;
  /** Deduplicated node bodies (compression only; empty when expanded). */
  templates: Record<string, TemplateBody>;
  /** Component definitions alongside the intact runtime trees. */
  components: Record<string, SimplifiedComponentEntry>;
}

/**
 * The core entry: `NodeSnapshot`s in, canonical `SimplifiedNode`s out.
 *
 * One transform authority for every producer — the REST adapter feeds it
 * `restNodeToSnapshot` output, the plugin adapter feeds it
 * `sceneNodeToSnapshot` output — so the raw→CSS conversion can never fork.
 *
 * Deliberately async: the walk awaits an injected cooperative-yield
 * scheduler (`options.scheduler`) so the REST server can keep heartbeats and
 * SIGINT live on large files. Callers without that need (the plugin sandbox)
 * simply omit the scheduler and await the promise — QuickJS supports
 * microtasks; there is no sync variant to drift from.
 */
export async function simplify(
  snapshots: NodeSnapshot[],
  options: SimplifyOptions = {},
): Promise<SimplifyResult> {
  const notes = createComponentNotes();
  const context: ReadContext = { notes, snapshots: new Map(), definitions: [] };
  const nodes = await walkNodes(snapshots, options, notes, context);
  context.definitions = await walkNodes(
    options.componentDefinitions ?? [],
    options,
    notes,
    context,
  );
  const components = componentCatalog(nodes, notes, context.definitions);
  describeInstanceChanges(nodes, components);
  const result = { nodes, styles: {}, templates: {}, components };
  context.unchanged = captureRead(result);
  rememberRead(result, context);
  for (const node of context.snapshots.keys()) {
    rememberRead(node, context);
    if (node.children) rememberRead(node.children, context);
  }
  return result;
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/** Walker state threaded through the recursion. */
interface SimplifyContext {
  /** Component provenance sink — the components pass reads it after the walk (see ComponentNotes). */
  components: ComponentNotes;
  parent?: NodeSnapshot;
  read: ReadContext;
  /**
   * Per-call mutable counter shared with the caller. Lives on the context so
   * the recursion can increment it without touching module-global state —
   * concurrent walks (e.g. overlapping HTTP requests) each own their counter
   * and never collide.
   */
  nodeCounter: NodeCounter;
}

// Await the injected scheduler every N nodes so heartbeats, SIGINT, and other
// async work can run during large file processing — when the caller supplies
// one. The core itself never touches the event loop (Invariant 4).
const YIELD_INTERVAL = 100;

async function maybeYield(
  counter: NodeCounter,
  scheduler: WalkScheduler | undefined,
): Promise<void> {
  counter.count++;
  if (scheduler && counter.count % YIELD_INTERVAL === 0) {
    await scheduler();
  }
}

/** Preserve every node and its sibling order; projection owns traversal cuts. */
async function walkNodes(
  nodes: NodeSnapshot[],
  options: SimplifyOptions = {},
  notes: ComponentNotes = createComponentNotes(),
  read: ReadContext = { notes, snapshots: new Map(), definitions: [] },
): Promise<SimplifiedNode[]> {
  const context: SimplifyContext = {
    components: notes,
    read,
    nodeCounter: options.nodeCounter ?? { count: 0 },
  };

  const processedNodes: SimplifiedNode[] = [];
  for (const node of nodes) {
    processedNodes.push(await extractNode(node, context, options));
  }

  return processedNodes;
}

/**
 * Extract one node: base metadata, then the four domain extractions in
 * sequence, then children.
 */
async function extractNode(
  node: NodeSnapshot,
  context: SimplifyContext,
  options: SimplifyOptions,
): Promise<SimplifiedNode> {
  await maybeYield(context.nodeCounter, options.scheduler);

  const result: SimplifiedNode = {
    id: node.id,
    name: node.name,
    type: node.type,
  };

  context.read.snapshots.set(result, node);
  extractLayout(node, result, context);
  extractText(node, result);
  extractVisuals(node, result);
  extractComponent(node, result, context);

  const readOnlySource = { ...node };
  delete readOnlySource.children;
  result.readOnlySource = readOnlySource;
  if (node.visible === false) result.visible = false;
  if (node.locked) result.locked = true;
  if (
    ["FRAME", "INSTANCE", "COMPONENT", "COMPONENT_SET", "SLOT"].includes(node.type) &&
    node.clipsContent !== undefined
  )
    result.clip = node.clipsContent;
  if (node.blendMode && CSS_BLEND_MODES.has(node.blendMode))
    result.mixBlendMode = node.blendMode.toLowerCase().replace(/_/g, "-");
  if (node.constraints) {
    const x = HORIZONTAL_CONSTRAINTS[node.constraints.horizontal];
    const y = VERTICAL_CONSTRAINTS[node.constraints.vertical];
    result.pin = { ...(x ? { x } : {}), ...(y ? { y } : {}) };
  }
  if (node.vectorPaths?.length) {
    if (node.vectorPaths.length === 1 && node.vectorPaths[0].windingRule === "NONZERO")
      result.d = node.vectorPaths[0].data;
    else result.vectorPaths = node.vectorPaths;
  }
  if (node.children) {
    const childContext = { ...context, parent: node };
    result.children = [];
    for (const child of node.children)
      result.children.push(await extractNode(child, childContext, options));
  }
  return result;
}

// ---------------------------------------------------------------------------
// The four domain extractions
// ---------------------------------------------------------------------------

/**
 * Extracts layout-related properties from a node: per-node geometry onto the
 * node top level (hybrid structure) and container config as the `layout` group.
 */
function extractLayout(node: NodeSnapshot, result: SimplifiedNode, context: SimplifyContext): void {
  const { layout, geometry } = buildSimplifiedLayout(node, context.parent);
  Object.assign(result, geometry);
  // A free-form container with nothing else to say (`{ mode: "none" }`) is the default and is
  // omitted; a row/column is information even when every other word is at its default.
  if (layout.mode !== "none" || Object.keys(layout).length > 1) {
    // Layout can't be a Figma named style, so no style slots to check.
    result.layout = layout;
  }
}

/**
 * Extracts text content and text styling from a node.
 */
function extractText(node: NodeSnapshot, result: SimplifiedNode): void {
  // Decoded runs remain in readOnlySource; the authoring field uses markdown and inline run deltas.
  if (isTextNode(node)) {
    const rich = buildFormattedText(node, (delta) => delta);
    if (rich.text !== undefined) {
      result.text = rich.text;
    }
    if (rich.boldWeight !== undefined) {
      result.boldWeight = rich.boldWeight;
    }
  }

  // Extract text style
  if (hasTextStyle(node)) {
    const textStyle = extractTextStyle(node);
    if (textStyle) {
      result.textStyle = textStyle;
    }
  }
}

/**
 * Extracts visual appearance properties (fills, strokes, effects, opacity, border radius).
 */
function extractVisuals(node: NodeSnapshot, result: SimplifiedNode): void {
  // Check if node has children to determine CSS properties
  const hasChildren = !!node.children && node.children.length > 0;

  // The authoring field keeps visible paint layers in CSS order; readOnlySource also keeps disabled layers.
  const paints = node.fills
    ?.filter(isVisible)
    .map((paint) => parsePaint(paint, hasChildren))
    .reverse();
  const fill = paints?.length ? (paints.length === 1 ? paints[0] : paints) : undefined;
  if (fill !== undefined) {
    result.fill = fill;
  } else if (node.type === "TEXT") {
    // Figma paints a new TEXT black, and flcm.text keeps that default when no `fill` is passed (a text
    // with no paint is invisible), so an ABSENT fill would rebuild as black. The no-paint state is
    // stated with the removal word the write side already takes. Frames and shapes need no such word:
    // their constructors clear the default paint when `fill` is absent.
    result.fill = "none";
  }

  // stroke
  // Only the stroke paint is interned as a (potentially named) shared style.
  // Figma named styles only apply to paint, not to stroke width / dashes / per-side
  // weights, so those stay as plain sibling fields and are never deduplicated.
  const strokes = buildSimplifiedStrokes(node, hasChildren);
  if (strokes.colors.length) {
    const stroke = strokes.colors.length === 1 ? strokes.colors[0] : strokes.colors;
    result.stroke = stroke;
    if (strokes.strokeWidth) result.strokeWidth = strokes.strokeWidth;
    if (strokes.strokeDashes) result.strokeDashes = strokes.strokeDashes;
    if (strokes.strokeAlign) result.strokeAlign = strokes.strokeAlign;
  } else if (node.type === "LINE") {
    // Same as the TEXT fill above: a LINE is nothing but its stroke, so flcm.line keeps Figma's default
    // black when `stroke` is absent, and only an explicit "none" rebuilds the strokeless state.
    result.stroke = "none";
  }

  // effects
  const effects = buildSimplifiedEffects(node);
  if (Object.keys(effects).length) {
    result.effects = effects;
  }

  // opacity
  if (typeof node.opacity === "number" && node.opacity !== 1) {
    result.opacity = node.opacity;
  }

  // border radius — zero is the CSS default, so a literal cornerRadius: 0 (or
  // all-zero per-corner radii) is omitted rather than emitted as "0px".
  if (typeof node.cornerRadius === "number" && node.cornerRadius !== 0) {
    result.borderRadius = `${node.cornerRadius}px`;
  }
  if (
    isRectangleCornerRadii(node.rectangleCornerRadii) &&
    node.rectangleCornerRadii.some(Boolean)
  ) {
    result.borderRadius = `${node.rectangleCornerRadii[0]}px ${node.rectangleCornerRadii[1]}px ${node.rectangleCornerRadii[2]}px ${node.rectangleCornerRadii[3]}px`;
  }
}

/**
 * Extracts component-related properties from nodes.
 * Handles four cases: INSTANCE property values, property references on any node,
 * property definitions on COMPONENT/COMPONENT_SET nodes, and the override marker on
 * any node the enclosing instance lists.
 */
function extractComponent(
  node: NodeSnapshot,
  result: SimplifiedNode,
  context: SimplifyContext,
): void {
  // Instance nodes: componentId + simplified componentProperties. The component's own name,
  // key, set and properties go to the SIDECAR — an off-tree definition has no node to carry
  // them, so the sidecar is the one place both cases can be named.
  if (node.type === "INSTANCE") {
    if (node.isExposedInstance) result.exposed = true;
    if (node.componentId) {
      result.componentId = node.componentId;
      if (node.mainComponent) {
        noteComponent(context.components, node.componentId, {
          type: "COMPONENT",
          name: node.mainComponent.name,
          key: node.mainComponent.key,
          componentSetId: node.mainComponent.set?.id,
        });
        if (node.mainComponent.set) {
          const set = node.mainComponent.set;
          noteComponent(context.components, set.id, {
            type: "COMPONENT_SET",
            name: set.name,
            key: set.key,
            description: set.description,
          });
        }
      }
    }
    if (node.componentProperties) {
      const props = simplifyComponentProperties(node.componentProperties);
      if (Object.keys(props).length > 0) {
        result.componentProperties = props;
      }
    }
    // How hand-edited this instance is, for donor selection only (see ComponentNotes).
    let edits = 0;
    for (const entry of node.overrides ?? []) edits += entry.fields.length;
    context.components.instanceEdits.set(node.id, edits);
  }

  if (node.annotations?.length) result.annotations = node.annotations;

  // Any node with property references: annotate with simplified refs
  if (node.componentPropertyReferences) {
    const refs = simplifyPropertyReferences(node.componentPropertyReferences);
    if (Object.keys(refs).length > 0) {
      result.componentPropertyReferences = refs;
    }
  }

  // A definition in the tree names itself into the same sidecar an instance would — same entry,
  // better provenance (this is the node's own reading, not an instance's second-hand copy).
  if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
    if (node.definitionUnverified) context.components.unverifiedDefinitions.add(node.id);
    const definitions = node.componentPropertyDefinitions
      ? simplifyPropertyDefinitions(node.componentPropertyDefinitions)
      : undefined;
    noteComponent(context.components, node.id, {
      type: node.type,
      name: node.name,
      key: node.componentKey,
      description: node.componentDescription,
      propertyDefinitions:
        definitions && Object.keys(definitions).length > 0 ? definitions : undefined,
    });
    // A set names its variants' membership. The variant node itself can't: nothing on a
    // COMPONENT says which set owns it, and REST reads that from a table the plugin has no
    // equivalent of — but a set's children ARE its variants, which both producers can see.
    if (node.type === "COMPONENT_SET") {
      for (const variant of node.children ?? []) {
        if (variant.type !== "COMPONENT") continue;
        noteComponent(context.components, variant.id, {
          type: "COMPONENT",
          name: variant.name,
          key: variant.componentKey,
          componentSetId: node.id,
        });
      }
    }
  }
}

const CSS_BLEND_MODES = new Set([
  "NORMAL",
  "MULTIPLY",
  "SCREEN",
  "OVERLAY",
  "SOFT_LIGHT",
  "HARD_LIGHT",
  "COLOR_DODGE",
  "COLOR_BURN",
  "DARKEN",
  "LIGHTEN",
  "DIFFERENCE",
  "EXCLUSION",
  "HUE",
  "SATURATION",
  "COLOR",
  "LUMINOSITY",
]);
const HORIZONTAL_CONSTRAINTS: Record<string, NonNullable<SimplifiedNode["pin"]>["x"]> = {
  MIN: "left",
  CENTER: "center",
  MAX: "right",
  STRETCH: "stretch",
  SCALE: "scale",
};
const VERTICAL_CONSTRAINTS: Record<string, NonNullable<SimplifiedNode["pin"]>["y"]> = {
  MIN: "top",
  CENTER: "center",
  MAX: "bottom",
  STRETCH: "stretch",
  SCALE: "scale",
};

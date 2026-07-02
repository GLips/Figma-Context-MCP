import type { Node as FigmaDocumentNode, Paint, Effect } from "@figma/rest-api-spec";
import type {
  NodeSnapshot,
  SnapshotColor,
  SnapshotEffect,
  SnapshotPaint,
  SnapshotVector,
} from "./snapshot.js";

/**
 * REST adapter: decode a raw Figma REST node into a plan-neutral `NodeSnapshot`
 * for `canonicalize`. This is where every REST-specific structure is unpacked
 * (top-level tables, `imageRef`, override tables, `gradientHandlePositions`,
 * `node.styles` lookups) so none of it reaches the core (Invariant 2).
 *
 * Incremental carve: the ~1:1 structural fields (id, layout traits, scalar
 * appearance) still pass through untouched because `NodeSnapshot` is a subset of
 * the Figma node shape. The concerns that have migrated onto decoded snapshot
 * shapes — paints and effects — are unpacked here; the rest (text runs,
 * component metadata, named-style resolution) is decoded in later carve slices.
 *
 * The whole subtree is decoded eagerly: children are mapped recursively so the
 * walker only ever sees decoded snapshots and never reaches back into REST
 * shapes.
 */
export function restNodeToSnapshot(node: FigmaDocumentNode): NodeSnapshot {
  // Read the REST-shaped visual fields off a permissive view: they exist only on
  // some node types, and this adapter is the one place allowed to know their
  // wire shape. Everything else is carried through structurally via the spread.
  const raw = node as unknown as {
    fills?: Paint[];
    strokes?: Paint[];
    effects?: Effect[];
    children?: FigmaDocumentNode[];
  };

  const snapshot = { ...node } as unknown as NodeSnapshot;

  if (raw.fills) snapshot.fills = raw.fills.map(decodePaint);
  if (raw.strokes) snapshot.strokes = raw.strokes.map(decodePaint);
  if (raw.effects) snapshot.effects = raw.effects.map(decodeEffect);
  if (raw.children) snapshot.children = raw.children.map(restNodeToSnapshot);

  return snapshot;
}

/**
 * Decode a REST `Paint` into a `SnapshotPaint`. Solid/pattern map ~1:1; the
 * image ref is uniformized (`imageRef`/`imageTransform` → `ref`/`crop`) and the
 * gradient is normalized to `{stops, handles}` so the core's gradient math works
 * off handle vectors without knowing the wire encoding.
 *
 * Exported so the not-yet-migrated text transformer can decode the raw paints it
 * pulls out of `styleOverrideTable` before handing them to the migrated
 * `parsePaint`; that bridge disappears when text runs move into the adapter.
 */
export function decodePaint(paint: Paint): SnapshotPaint {
  switch (paint.type) {
    case "IMAGE":
      return {
        type: "IMAGE",
        // imageRef comes back null for assets living in another file; normalize
        // to undefined so the core simply omits the ref (see parsePaint).
        ref: paint.imageRef ?? undefined,
        gifRef: paint.gifRef,
        scaleMode: paint.scaleMode as "FILL" | "FIT" | "TILE" | "STRETCH",
        scalingFactor: paint.scalingFactor,
        crop: paint.imageTransform,
        visible: paint.visible,
      };
    case "PATTERN":
      return {
        type: "PATTERN",
        sourceNodeId: paint.sourceNodeId,
        scalingFactor: paint.scalingFactor,
        horizontalAlignment: paint.horizontalAlignment,
        verticalAlignment: paint.verticalAlignment,
        visible: paint.visible,
      };
    case "GRADIENT_LINEAR":
    case "GRADIENT_RADIAL":
    case "GRADIENT_ANGULAR":
    case "GRADIENT_DIAMOND":
      return {
        type: paint.type,
        stops: paint.gradientStops.map((stop) => ({ position: stop.position, color: stop.color })),
        handles: paint.gradientHandlePositions,
        opacity: paint.opacity,
        visible: paint.visible,
      };
    case "SOLID":
      return {
        type: "SOLID",
        color: paint.color,
        opacity: paint.opacity,
        blendMode: paint.blendMode,
        visible: paint.visible,
      };
  }
}

/**
 * Decode a REST `Effect` into a `SnapshotEffect`. Shadow/blur/texture carry a
 * radius; noise effects don't (they're not rendered downstream, so `?? 0` is
 * inert). Shadows additionally carry color + offset; the core reads whichever it
 * needs per type. Read through a permissive view because the REST `Effect` union
 * types `type` as optional on inner shadows and omits `radius`/`color`/`offset`
 * on the members that don't have them.
 */
function decodeEffect(effect: Effect): SnapshotEffect {
  const e = effect as {
    type: string;
    visible?: boolean;
    color?: SnapshotColor;
    offset?: SnapshotVector;
    radius?: number;
    spread?: number;
  };
  return {
    type: e.type,
    visible: e.visible,
    color: e.color,
    offset: e.offset,
    radius: e.radius ?? 0,
    spread: e.spread,
  };
}

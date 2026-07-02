import type { Paint, Effect } from "@figma/rest-api-spec";
import type {
  SnapshotColor,
  SnapshotEffect,
  SnapshotPaint,
  SnapshotVector,
} from "~/core/snapshot.js";
import { tagError } from "~/utils/error-meta.js";

/**
 * REST paint/effect decode — the wire-shape half of the adapter, split out so
 * both the node adapter (`node-to-snapshot`) and the text adapter
 * (`text`) can share it without an import cycle.
 */

/** Decode a paint list, dropping any the boundary can't decode (see decodePaint). */
export function decodePaints(paints: Paint[]): SnapshotPaint[] {
  const decoded: SnapshotPaint[] = [];
  for (const paint of paints) {
    const p = decodePaint(paint);
    if (p) decoded.push(p);
  }
  return decoded;
}

/**
 * Decode a REST `Paint` into a `SnapshotPaint`. Solid/pattern map ~1:1; the
 * image ref is uniformized (`imageRef`/`imageTransform` → `ref`/`crop`) and the
 * gradient is normalized to `{stops, handles}` so the core's gradient math works
 * off handle vectors without knowing the wire encoding.
 *
 * Returns undefined for a paint whose `type` is outside the REST union — a live
 * API shipping a paint kind newer than the pinned spec. This is a system
 * boundary, so we log-and-drop (as the pre-carve `parsePaint` did) rather than
 * let an undecodable paint reach the core and crash a downstream `isVisible`.
 */
export function decodePaint(paint: Paint): SnapshotPaint | undefined {
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
    default:
      tagError(new Error(`Unknown paint type: ${(paint as { type: string }).type}`), {
        category: "internal",
      });
      return undefined;
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
export function decodeEffect(effect: Effect): SnapshotEffect {
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

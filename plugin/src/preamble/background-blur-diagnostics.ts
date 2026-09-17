import { warnings } from "./warnings.js";
// Figma composites a BACKGROUND_BLUR through the layer's OWN paint: the blurred backdrop is masked by
// wherever the node actually paints. A node with no visible fill paints nowhere, so the blur renders
// exactly nothing — no error, no warning from the runtime, no pixels. Verified on canvas: a fill-less
// frame with backgroundBlur over a busy backdrop was invisible; adding rgba(255,255,255,0.14) and
// changing nothing else made it frost.
//
// GLASS is deliberately NOT covered. It draws its own refractive pane rather than compositing the
// backdrop through the node's paint, and renders on a fill-less frame (observed in the same ablation).
//
// A warning, never a refusal: a deliberately near-transparent fill is normal glassmorphism, and an
// agent may be about to set the fill in a later edit.

/** Live plugin paints and effects, read back off the node — only the fields this check reads. */
interface LivePaint {
  visible?: boolean;
  opacity?: number;
  gradientStops?: readonly { color: { a: number } }[];
}
interface LiveEffect {
  type: string;
  visible?: boolean;
  radius?: number;
}

/** Does this paint put any pixels down? Alpha lives on `opacity` for solids/images, on the stop colors
 *  for gradients — a stack of fully-transparent paints is as paint-less as an empty stack. */
function paintIsVisible(paint: LivePaint): boolean {
  if (paint.visible === false || paint.opacity === 0) return false;
  if (paint.gradientStops) return paint.gradientStops.some((stop) => stop.color.a > 0);
  return true;
}

export const BACKGROUND_BLUR_WITHOUT_FILL =
  "backgroundBlur renders nothing on a node with no visible fill — Figma composites the blurred backdrop through the node's own paint, so give the node a fill (a near-transparent one like \"rgba(255,255,255,0.08)\" is enough) for the frost to appear.";

/**
 * Warn when the node's FINAL state pairs a background blur with nothing to paint it through. Reads the
 * live node rather than the authored delta, so an edit that adds only a blur to an already-filled node
 * stays silent and one that clears the fill of a blurred node speaks up.
 */
export function warnBackgroundBlurWithoutFill(node: any): void {
  const effects: readonly LiveEffect[] | undefined = node.effects;
  if (!effects || !effects.some((e) => e.type === "BACKGROUND_BLUR" && e.visible !== false && (e.radius ?? 0) > 0)) return;
  // Negative space: a node KIND with no `fills` at all (a GROUP) masks the blur with its children's
  // paint instead of its own, so the trap doesn't apply. A TEXT's mixed-per-range fills are the
  // figma.mixed symbol, not an array — mixed means at least one range paints.
  const fills = node.fills;
  if (!Array.isArray(fills) || fills.some(paintIsVisible)) return;
  warnings.add({ id: node.id, message: BACKGROUND_BLUR_WITHOUT_FILL });
}

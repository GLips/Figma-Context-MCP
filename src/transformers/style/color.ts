import type { Paint, RGBA } from "@figma/rest-api-spec";

export type CSSRGBAColor = `rgba(${number}, ${number}, ${number}, ${number})`;
export type CSSHexColor = `#${string}`;
export interface ColorValue {
  hex: CSSHexColor;
  opacity: number;
}

/**
 * Convert color from RGBA to { hex, opacity }
 *
 * @param color - The color to convert, including alpha channel
 * @param opacity - The opacity of the color, if not included in alpha channel
 * @returns The converted color
 **/
export function convertColor(color: RGBA, opacity = 1): ColorValue {
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);

  // Alpha channel defaults to 1. If opacity and alpha are both and < 1, their effects are multiplicative
  const a = Math.round(opacity * color.a * 100) / 100;

  const hex = ("#" +
    ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase()) as CSSHexColor;

  return { hex, opacity: a };
}

/**
 * Convert color from Figma RGBA to rgba(#, #, #, #) CSS format
 *
 * @param color - The color to convert, including alpha channel
 * @param opacity - The opacity of the color, if not included in alpha channel
 * @returns The converted color
 **/
export function formatRGBAColor(color: RGBA, opacity = 1): CSSRGBAColor {
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  // Alpha channel defaults to 1. If opacity and alpha are both and < 1, their effects are multiplicative
  const a = Math.round(opacity * color.a * 100) / 100;

  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/**
 * A solid paint participates in flattening only when it blends normally with
 * what's behind it. PASS_THROUGH (groups) and NORMAL both composite with plain
 * source-over; every other blend mode (MULTIPLY, SCREEN, …) needs the backdrop
 * to compute, which a flattened stack has thrown away — so its presence anywhere
 * disqualifies the whole stack. A missing blendMode is treated as NORMAL (its
 * Figma default).
 */
function isFlattenableSolid(paint: Paint): paint is Extract<Paint, { type: "SOLID" }> {
  return (
    paint.type === "SOLID" &&
    (paint.blendMode === undefined ||
      paint.blendMode === "NORMAL" ||
      paint.blendMode === "PASS_THROUGH")
  );
}

type StraightColor = { r: number; g: number; b: number; a: number };

/** Source-over composite of `top` (foreground) onto `bottom` (backdrop), straight alpha, channels 0..1. */
function compositeOver(top: StraightColor, bottom: StraightColor): StraightColor {
  const a = top.a + bottom.a * (1 - top.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const blend = (cT: number, cB: number) => (cT * top.a + cB * bottom.a * (1 - top.a)) / a;
  return { r: blend(top.r, bottom.r), g: blend(top.g, bottom.g), b: blend(top.b, bottom.b), a };
}

/**
 * Collapse an all-solid paint stack into the single color a viewer actually sees.
 *
 * The emitted fills array carries layer order as a silent positional contract,
 * and LLM consumers misread it — picking the wrong layer's color, or emitting a
 * layer that's fully occluded by an opaque paint above it. When every visible
 * paint is a normally-blended SOLID we can resolve that ambiguity outright:
 * source-over composite the stack into one resolved color (hex when the result
 * is fully opaque, else rgba()). Compositing inherently culls dead layers —
 * anything beneath a fully-opaque paint contributes nothing to the result.
 *
 * Returns null when the stack contains a gradient, image, pattern, or any
 * non-normal blend mode: those have their own output syntax and can't be folded,
 * so the caller falls back to emitting the per-paint array untouched.
 *
 * `paints` must be in Figma order (index 0 = bottom layer).
 */
export function flattenSolidFills(paints: Paint[]): CSSHexColor | CSSRGBAColor | null {
  if (!paints.length || !paints.every(isFlattenableSolid)) return null;

  // Fold effective alpha (color.a * paint.opacity) before compositing, bottom to top.
  const toStraight = (p: Extract<Paint, { type: "SOLID" }>): StraightColor => ({
    r: p.color.r,
    g: p.color.g,
    b: p.color.b,
    a: p.color.a * (p.opacity ?? 1),
  });

  let acc = toStraight(paints[0]);
  for (let i = 1; i < paints.length; i++) {
    acc = compositeOver(toStraight(paints[i]), acc);
  }

  const composited: RGBA = acc;
  const { hex, opacity } = convertColor(composited);
  return opacity === 1 ? hex : formatRGBAColor(composited);
}

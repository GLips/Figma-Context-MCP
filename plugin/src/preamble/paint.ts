// paint — the typed paint domain: build a PaintSpec from numeric inputs and map it to a plugin Paint.
// No CSS strings live here (css.ts owns those). These constructors are the ONE home for the proven
// gradient-transform math, shared by two callers: the string parser (css.ts) and the gradient() sugar.
//
// THE GRADIENT-TRANSFORM MATH (grounded live; preserved from findings.md Round 2): Figma's plugin API
// takes a 2x3 gradientTransform, not an angle/handles. CSS linear angles use a different convention than
// the grounded matrix — CSS 0deg = "to top", 90deg = "to right", 180deg = "to bottom"; the matrix's own
// angle is 0 = left->right, 90 = top->bottom — so we feed it (cssAngle - 90). Verified by screenshot:
// 180deg renders top->bottom, 90deg left->right, radial centered correctly.

import { PaintSpec, GradientSpec, GradientStop, GradientType, Rgba, Transform } from "./ir.js";

// A color (alpha included) -> SOLID spec, alpha mapped to the paint's opacity. A fully-transparent color
// becomes opacity 0, never the opaque-black bug a naive parse produces.
export function solid(color: Rgba): PaintSpec {
  return { kind: "solid", color: { r: color.r, g: color.g, b: color.b }, opacity: color.a };
}

// CSS linear angle (deg) + stops -> linear gradient spec. The transform is derived here so the sugar and
// the string parser can never disagree on the matrix.
export function linearGradient(cssDeg: number, stops: GradientStop[]): GradientSpec {
  return { kind: "gradient", type: "GRADIENT_LINEAR", transform: linearTransform(cssDeg), stops };
}

// A radial/diamond gradient centered at (cx,cy) in CSS percent. `type` is read's circle->RADIAL,
// ellipse->DIAMOND mapping, decided by the caller.
export function radialGradient(type: GradientType, cx: number, cy: number, stops: GradientStop[]): GradientSpec {
  return { kind: "gradient", type, transform: radialTransform(cx, cy), stops };
}

// CSS linear angle -> 2x3 transform via the grounded matrix at (angle-90). See the module header.
function linearTransform(cssDeg: number): Transform {
  const r = ((cssDeg - 90) * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return [[c, s, (1 - c - s) / 2], [-s, c, (1 + s - c) / 2]];
}

// Centered radial transform (scale 0.5), translated so the CSS center (cx,cy %) lands at the gradient
// center: tx = 0.5*(1 - cx). At 50%/50% this is the grounded [[0.5,0,0.25],[0,0.5,0.25]].
function radialTransform(cxPct: number, cyPct: number): Transform {
  return [[0.5, 0, 0.5 * (1 - cxPct / 100)], [0, 0.5, 0.5 * (1 - cyPct / 100)]];
}

// PaintSpec -> the plugin's Paint. The bridge routes every fill/stroke through here; it is the single
// typed->plugin boundary for paint, so the one unavoidable plugin-typings cast lives here, not at call sites.
export function toFigmaPaint(spec: PaintSpec): Paint {
  if (spec.kind === "solid") {
    return { type: "SOLID", color: spec.color, opacity: spec.opacity };
  }
  if (spec.kind === "image") {
    // An image paint needs raster bytes + figma.createImage — a figma.* call, so it resolves in the bridge.
    // paintOf is the SOLE PaintSpec→Paint funnel there and routes every image spec to its own resolver, so a
    // pure image spec never reaches this figma-free path; this narrows the union and fails loud if that ever
    // breaks (e.g. a new paint consumer bypasses paintOf).
    throw new Error("flcm: internal — an image paint reached toFigmaPaint; route it through the bridge's paintOf so it resolves with fetched bytes.");
  }
  return {
    type: spec.type,
    gradientTransform: spec.transform,
    gradientStops: spec.stops.map((s) => ({ position: s.position, color: s.color })),
  } as GradientPaint;
}

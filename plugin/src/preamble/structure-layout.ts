/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import type { WriteLayout, WriteNode, Sizing, ConstraintX, ConstraintY } from "./ir.js";
import { layoutModeOf } from "./layout-mode.js";
import { BOUND_WORDS } from "./vocabulary.js";
import { unrotatedCornerOf } from "./pivot.js";
import { convertSizing } from "@framelink/core";

/** Per-axis intent wins as a unit: an explicit hug/fill/percent never retains old fixed pixels. */
function mergePlacementLayout(inherited: WriteLayout, explicit: WriteLayout = {}): WriteLayout {
  const result: WriteLayout = { ...inherited, ...explicit,
    sizing: { ...inherited.sizing, ...explicit.sizing },
    dimensions: { ...inherited.dimensions, ...explicit.dimensions },
    constraints: { ...inherited.constraints, ...explicit.constraints },
    bounds: { ...inherited.bounds, ...explicit.bounds },
  };
  for (const [axis, dimension] of [["horizontal", "width"], ["vertical", "height"]] as const) {
    if (explicit.sizing?.[axis] !== undefined) {
      delete result.dimensions![dimension];
      if (explicit.dimensions?.[dimension] !== undefined) result.dimensions![dimension] = explicit.dimensions[dimension];
    }
  }
  if (explicit.percentPos?.x !== undefined) delete result.left;
  if (explicit.percentPos?.y !== undefined) delete result.top;
  return result;
}

export function replacementTree(node: any, spec: WriteNode): WriteNode {
  const sizing = (value: "FILL" | "FIXED" | "HUG" | undefined): Sizing => convertSizing(value) || "fixed";
  const inherited: WriteLayout = {
    sizing: { horizontal: sizing(node.layoutSizingHorizontal), vertical: sizing(node.layoutSizingVertical) },
    dimensions: { width: node.width, height: node.height },
  };
  const bounds = Object.fromEntries(BOUND_WORDS.filter(key => node[key] != null).map(key => [key, node[key]]));
  if (Object.keys(bounds).length) inherited.bounds = bounds;
  if (node.constraints) {
    const x: Record<string, ConstraintX> = { MIN: "left", CENTER: "center", MAX: "right", STRETCH: "stretch", SCALE: "scale" };
    const y: Record<string, ConstraintY> = { MIN: "top", CENTER: "center", MAX: "bottom", STRETCH: "stretch", SCALE: "scale" };
    inherited.constraints = { x: x[node.constraints.horizontal], y: y[node.constraints.vertical] };
  }
  const positioned = layoutModeOf(node.parent).kind === "free" || node.layoutPositioning === "ABSOLUTE";
  if (positioned) {
    const corner = unrotatedCornerOf(node);
    inherited.left = corner.x; inherited.top = corner.y;
    inherited.position = "absolute";

  }
  return { ...spec, layout: mergePlacementLayout(inherited, spec.layout) };
}

import { gapShorthand } from "./common.js";
import type { NodeSnapshot } from "~/extractors/snapshot.js";

export function convertJustifyContent(align?: NodeSnapshot["primaryAxisAlignItems"]) {
  switch (align) {
    case "MIN":
      return undefined;
    case "MAX":
      return "flex-end";
    case "CENTER":
      return "center";
    case "SPACE_BETWEEN":
      return "space-between";
    default:
      return undefined;
  }
}

export function convertAlignItems(
  align: NodeSnapshot["counterAxisAlignItems"] | undefined,
  children: NodeSnapshot[],
  mode: "row" | "column",
) {
  // Row cross-axis is vertical; column cross-axis is horizontal
  const crossSizing = mode === "row" ? "layoutSizingVertical" : "layoutSizingHorizontal";
  const allStretch =
    children.length > 0 &&
    children.every((c) => c.layoutPositioning === "ABSOLUTE" || c[crossSizing] === "FILL");
  if (allStretch) return "stretch";

  switch (align) {
    case "MIN":
      return undefined;
    case "MAX":
      return "flex-end";
    case "CENTER":
      return "center";
    case "BASELINE":
      return "baseline";
    default:
      return undefined;
  }
}

// SPACE_BETWEEN computes gaps dynamically — the API returns stale spacing
// values, but Figma's UI shows "Auto". Suppress the affected axis.
export function buildFlexGap(n: NodeSnapshot, mode: "row" | "column"): string | undefined {
  const primaryGap = n.primaryAxisAlignItems === "SPACE_BETWEEN" ? undefined : n.itemSpacing;
  const counterGap =
    n.layoutWrap !== "WRAP" || n.counterAxisAlignContent === "SPACE_BETWEEN"
      ? undefined
      : n.counterAxisSpacing;

  // Map Figma's primary/counter axes to CSS's row/column axes
  const rowGap = mode === "row" ? counterGap : primaryGap;
  const colGap = mode === "row" ? primaryGap : counterGap;

  return gapShorthand(rowGap, colGap);
}

import { gapShorthand, type SimplifiedLayout } from "./common.js";
import { bindNumber } from "../bound-values.js";
import { variableReference } from "../../tokens.js";
import { pixelRound } from "../../utils.js";
import type { NodeSnapshot } from "../../snapshot.js";

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
  if (align === "BASELINE") return "baseline";
  if (allStretch) return "stretch";

  switch (align) {
    case "MIN":
      return undefined;
    case "MAX":
      return "flex-end";
    case "CENTER":
      return "center";
    default:
      return undefined;
  }
}

// SPACE_BETWEEN computes gaps dynamically — the API returns stale spacing
// values, but Figma's UI shows "Auto". Suppress the affected axis (and its binding with it).
export function buildFlexGap(
  n: NodeSnapshot,
  mode: "row" | "column",
): SimplifiedLayout["gap"] | undefined {
  const primaryGap =
    n.primaryAxisAlignItems === "SPACE_BETWEEN" || n.itemSpacing === undefined
      ? undefined
      : pixelRound(n.itemSpacing);
  const counterGap =
    n.layoutWrap !== "WRAP" ||
    n.counterAxisAlignContent === "SPACE_BETWEEN" ||
    n.counterAxisSpacing === undefined
      ? undefined
      : pixelRound(n.counterAxisSpacing);
  const primaryRef = primaryGap === undefined ? undefined : n.boundVariables?.itemSpacing;
  const counterRef = counterGap === undefined ? undefined : n.boundVariables?.counterAxisSpacing;

  // Map Figma's primary/counter axes to CSS's row/column axes
  const [rowGap, rowRef, colGap, colRef] =
    mode === "row"
      ? [counterGap, counterRef, primaryGap, primaryRef]
      : [primaryGap, primaryRef, counterGap, counterRef];

  if (!rowRef && !colRef) return gapShorthand(rowGap, colGap);
  // A bound gap emits even at 0: the binding is intent, not the omitted default.
  if (rowGap === undefined || colGap === undefined)
    return variableReference((rowRef ?? colRef)!, (rowGap ?? colGap)!);
  if (rowRef && colRef && rowRef.id === colRef.id) return variableReference(rowRef, rowGap);
  return { row: bindNumber(rowGap, rowRef), column: bindNumber(colGap, colRef) };
}

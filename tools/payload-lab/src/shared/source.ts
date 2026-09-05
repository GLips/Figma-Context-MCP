import { object, type Json, type Obj } from "./model.js";

// Candidate wire inputs for common output fields. These are navigation hints,
// not lineage claims: each revision owns the actual derivation and may use ancestors.
const sourceKeys: Record<string, string[]> = {
  text: ["characters", "characterStyleOverrides", "styleOverrideTable", "lineTypes"],
  textStyle: ["style", "styles"],
  width: ["absoluteBoundingBox", "rotation", "layoutSizingHorizontal", "layoutGrow"],
  designedWidth: ["absoluteBoundingBox", "rotation"],
  height: ["absoluteBoundingBox", "rotation", "layoutSizingVertical", "layoutGrow"],
  designedHeight: ["absoluteBoundingBox", "rotation"],
  left: ["absoluteBoundingBox", "rotation", "layoutPositioning"],
  top: ["absoluteBoundingBox", "rotation", "layoutPositioning"],
  rotation: ["rotation"],
  propertyDefinitions: ["componentPropertyDefinitions"],
  componentProperties: ["componentProperties"],
  componentId: ["componentId"],
  fills: ["fills", "styles"],
  strokes: ["strokes", "styles"],
  effects: ["effects", "styles"],
  layout: [
    "layoutMode",
    "layoutWrap",
    "primaryAxisAlignItems",
    "counterAxisAlignItems",
    "itemSpacing",
    "paddingLeft",
    "paddingRight",
    "paddingTop",
    "paddingBottom",
  ],
  borderRadius: ["cornerRadius", "rectangleCornerRadii"],
  overrides: ["overrides"],
};
export function findRawNode(raw: Json, id: string): Obj | undefined {
  if (!raw || typeof raw !== "object") return;
  if (!Array.isArray(raw) && raw.id === id) return raw;
  for (const child of Object.values(raw)) {
    const found = findRawNode(child, id);
    if (found) return found;
  }
}
export function sourceHint(source: Obj | undefined, field: string): Obj | undefined {
  if (!source || !field) return;
  return Object.fromEntries(
    (sourceKeys[field] ?? [field]).map((key) => [key, source[key] ?? "Absent on this raw node"]),
  );
}
export function fieldAt(node: Obj | undefined, segments: string[]): Json | undefined {
  let value: Json | undefined = node;
  for (const part of segments)
    value = Array.isArray(value) ? value[Number(part)] : object(value)[part];
  return value;
}

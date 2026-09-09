import type { SnapshotAnnotation } from "@framelink/core/snapshot";
import { rejectUnknownKeys } from "./validate.js";

// https://developers.figma.com/docs/plugins/api/AnnotationProperty/
// Validate property names before any file-scoped category can be created.
const ANNOTATION_PROPERTIES = [
  "width", "height", "maxWidth", "minWidth", "maxHeight", "minHeight", "fills", "strokes",
  "effects", "strokeWeight", "cornerRadius", "textStyleId", "textAlignHorizontal", "fontFamily",
  "fontStyle", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "itemSpacing", "padding",
  "layoutMode", "alignItems", "opacity", "mainComponent", "gridRowGap", "gridColumnGap",
  "gridRowCount", "gridColumnCount", "gridRowAnchorIndex", "gridColumnAnchorIndex", "gridRowSpan", "gridColumnSpan",
] as const;
type WriteAnnotationProperty = (typeof ANNOTATION_PROPERTIES)[number];
const ANNOTATION_KEYS = new Set(["text", "category", "properties"]);
export interface WriteAnnotation {
  text?: string;
  category?: string;
  properties?: WriteAnnotationProperty[];
}

function isAnnotationProperty(value: unknown): value is WriteAnnotationProperty {
  return ANNOTATION_PROPERTIES.some((property) => property === value);
}

export function compileAnnotations(value: unknown): WriteAnnotation[] {
  if (!Array.isArray(value)) throw new Error("flcm.annotations must be an array.");
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("flcm.annotations entries must be objects.");
    rejectUnknownKeys(entry, ANNOTATION_KEYS, "flcm.annotations");
    const { text, category, properties } = entry as Record<string, unknown>;
    const out: WriteAnnotation = {};
    if (text !== undefined) {
      if (typeof text !== "string") throw new Error("flcm.annotations.text must be a string.");
      out.text = text;
    }
    if (category !== undefined) {
      if (typeof category !== "string" || !category.trim()) throw new Error("flcm.annotations.category must be a non-blank name.");
      out.category = category.trim();
    }
    if (properties !== undefined) {
      if (!Array.isArray(properties) || !properties.every(isAnnotationProperty)) {
        throw new Error("flcm.annotations.properties must be an array of pinned property names: " + ANNOTATION_PROPERTIES.join(", ") + ".");
      }
      out.properties = [...properties];
    }
    return out;
  });
}

export type SceneAnnotation = {
  readonly label?: string;
  readonly labelMarkdown?: string;
  readonly categoryId?: string;
  readonly properties?: readonly { readonly type: string }[];
};

export function decodeAnnotations(
  annotations: readonly SceneAnnotation[] | undefined,
  categories: ReadonlyMap<string, string>,
): SnapshotAnnotation[] | undefined {
  if (!annotations?.length) return undefined;
  return annotations.map((annotation) => {
    const out: SnapshotAnnotation = {};
    const text = annotation.labelMarkdown ?? annotation.label;
    if (text !== undefined) out.text = text;
    if (annotation.categoryId) {
      const name = categories.get(annotation.categoryId);
      if (name !== undefined) out.category = name;
    }
    if (annotation.properties !== undefined) out.properties = annotation.properties.map((property) => property.type);
    return out;
  });
}

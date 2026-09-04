import type {
  SnapshotComponentPropertyDefinition,
  SnapshotComponentPropertyValue,
} from "~/core/snapshot.js";

/**
 * One property on a COMPONENT / COMPONENT_SET, as emitted on the defining node.
 * `type` is the lowercased Figma tag: boolean / text / instance_swap / variant / slot.
 */
export interface SimplifiedPropertyDefinition {
  type: string;
  /** Absent on `slot` (see SnapshotComponentPropertyDefinition). */
  defaultValue?: boolean | string;
  /** `variant` only: the legal values, so a writer can pick one without guessing. */
  variantOptions?: string[];
}

/**
 * The REST response-envelope tables, reduced to provenance an agent needs to
 * name a component: its publish `key`, human `name`, and which set a variant
 * belongs to. Property definitions are NOT here — they sit on the defining
 * node in the tree (`SimplifiedNode.propertyDefinitions`), where both producers
 * can emit them. A component outside the fetched subtree has an entry here but
 * no definitions anywhere: the wire never carries them off-tree.
 */
export interface SimplifiedComponentDefinition {
  id: string;
  key: string;
  name: string;
  componentSetId?: string;
}

export interface SimplifiedComponentSetDefinition {
  id: string;
  key: string;
  name: string;
  description?: string;
}

/**
 * Strip the #nodeId suffix from Figma property names.
 * "On Sale#341:0" → "On Sale"
 */
export function stripPropertyNameSuffix(name: string): string {
  const hashIndex = name.indexOf("#");
  return hashIndex === -1 ? name : name.substring(0, hashIndex);
}

/**
 * Property definitions → name → { type, defaultValue?, variantOptions? }. Every
 * type is kept: a writer needs the variant axes and swap slots as much as the
 * booleans and text.
 */
export function simplifyPropertyDefinitions(
  definitions: Record<string, SnapshotComponentPropertyDefinition>,
): Record<string, SimplifiedPropertyDefinition> {
  const result: Record<string, SimplifiedPropertyDefinition> = {};
  for (const [name, def] of Object.entries(definitions)) {
    const simplified: SimplifiedPropertyDefinition = { type: def.type.toLowerCase() };
    if (def.defaultValue !== undefined) simplified.defaultValue = def.defaultValue;
    if (def.variantOptions) simplified.variantOptions = def.variantOptions;
    result[stripPropertyNameSuffix(name)] = simplified;
  }
  return result;
}

/**
 * The wire's node-field → property-name map, re-keyed by the OUTPUT field each
 * property drives, so a reader can go straight from the field it sees to the
 * property that controls it. `visible` is already the output spelling; the other
 * three are renamed. Any other wire key is dropped.
 */
const PROPERTY_REFERENCE_FIELDS: Record<string, string> = {
  visible: "visible",
  characters: "text",
  mainComponent: "componentId",
  slotContentId: "slot",
};

export function simplifyPropertyReferences(
  references: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(references)) {
    const outputKey = PROPERTY_REFERENCE_FIELDS[key];
    if (outputKey) result[outputKey] = stripPropertyNameSuffix(value);
  }
  return result;
}

/**
 * An instance's component properties → flat name → value. Swap values ride along
 * with booleans and text (a swap value is the nested main component's id, derivable
 * nowhere else). VARIANT values are deliberately NOT emitted: the instance's
 * `componentId` names the variant COMPONENT, whose table `name` already spells
 * `Variant=Primary` — repeating that on every instance is pure token cost.
 */
export function simplifyComponentProperties(
  properties: Record<string, SnapshotComponentPropertyValue>,
): Record<string, boolean | string> {
  const result: Record<string, boolean | string> = {};
  for (const [name, prop] of Object.entries(properties)) {
    if (prop.type === "VARIANT") continue;
    result[stripPropertyNameSuffix(name)] = prop.value;
  }
  return result;
}

/**
 * Wire override field → the OUTPUT field it lands in, so a reader sees "this fill was
 * changed" next to the fill it reads. Both producers' spellings are listed: REST's
 * text-override tables and the plugin's `styledTextSegments` are the same edit, and
 * both fold to `text`. A wire field with no output field (bound variables, prototype
 * transitions, export settings, plugin data) is dropped — nothing in the read shape
 * shows it, so nothing can be "overridden" from a reader's point of view.
 */
const OVERRIDE_OUTPUT_FIELDS: Record<string, string | string[]> = {
  // identity / visibility
  name: "name",
  visible: "visible",
  opacity: "opacity",
  // geometry
  width: "width",
  height: "height",
  x: "left",
  y: "top",
  rotation: "rotation",
  relativeTransform: ["left", "top", "rotation"],
  // text content — REST's four-table encoding and the plugin's segments
  characters: "text",
  characterStyleOverrides: "text",
  styleOverrideTable: "text",
  lineTypes: "text",
  lineIndentations: "text",
  styledTextSegments: "text",
  // text style
  fontName: "textStyle",
  fontSize: "textStyle",
  fontWeight: "textStyle",
  lineHeight: "textStyle",
  letterSpacing: "textStyle",
  textCase: "textStyle",
  textDecoration: "textStyle",
  textAlignHorizontal: "textStyle",
  textAlignVertical: "textStyle",
  paragraphSpacing: "textStyle",
  paragraphIndent: "textStyle",
  textStyleId: "textStyle",
  inheritTextStyleId: "textStyle",
  // paints
  fills: "fills",
  fillStyleId: "fills",
  inheritFillStyleId: "fills",
  strokes: "strokes",
  strokeStyleId: "strokes",
  inheritStrokeStyleId: "strokes",
  strokeWeight: "strokeWidth",
  strokeTopWeight: "strokeWidth",
  strokeRightWeight: "strokeWidth",
  strokeBottomWeight: "strokeWidth",
  strokeLeftWeight: "strokeWidth",
  individualStrokeWeights: "strokeWidth",
  strokeAlign: "strokeAlign",
  dashPattern: "strokeDashes",
  strokeDashes: "strokeDashes",
  effects: "effects",
  effectStyleId: "effects",
  inheritEffectStyleId: "effects",
  // corners
  cornerRadius: "borderRadius",
  topLeftRadius: "borderRadius",
  topRightRadius: "borderRadius",
  bottomLeftRadius: "borderRadius",
  bottomRightRadius: "borderRadius",
  rectangleCornerRadii: "borderRadius",
  // container config
  clipsContent: "layout",
  layoutMode: "layout",
  layoutWrap: "layout",
  primaryAxisSizingMode: "layout",
  counterAxisSizingMode: "layout",
  primaryAxisAlignItems: "layout",
  counterAxisAlignItems: "layout",
  counterAxisAlignContent: "layout",
  paddingLeft: "layout",
  paddingRight: "layout",
  paddingTop: "layout",
  paddingBottom: "layout",
  itemSpacing: "layout",
  counterAxisSpacing: "layout",
  layoutAlign: "layout",
  layoutGrow: "layout",
  layoutPositioning: "layout",
  layoutSizingHorizontal: "layout",
  layoutSizingVertical: "layout",
  overflowDirection: "layout",
  // component data
  componentProperties: "componentProperties",
  mainComponent: "componentId",
};

/** Wire override fields → the distinct output fields they touch, in output order. */
export function simplifyOverriddenFields(fields: string[]): string[] {
  const out: string[] = [];
  for (const field of fields) {
    const mapped = OVERRIDE_OUTPUT_FIELDS[field];
    if (!mapped) continue;
    for (const output of Array.isArray(mapped) ? mapped : [mapped]) {
      if (!out.includes(output)) out.push(output);
    }
  }
  return out;
}

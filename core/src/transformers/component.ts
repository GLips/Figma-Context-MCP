import type {
  SnapshotComponentPropertyDefinition,
  SnapshotComponentPropertyValue,
} from "../snapshot.js";

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

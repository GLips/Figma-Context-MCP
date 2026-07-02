export interface SimplifiedPropertyDefinition {
  type: string;
  defaultValue: boolean | string;
}

export interface SimplifiedComponentDefinition {
  id: string;
  key: string;
  name: string;
  componentSetId?: string;
  propertyDefinitions?: Record<string, SimplifiedPropertyDefinition>;
}

export interface SimplifiedComponentSetDefinition {
  id: string;
  key: string;
  name: string;
  description?: string;
  propertyDefinitions?: Record<string, SimplifiedPropertyDefinition>;
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
 * Simplify componentPropertyDefinitions from the raw Figma format to a flat
 * Record of property name → default value. Only extracts BOOLEAN and TEXT
 * properties for Phase 1.
 */
export function simplifyPropertyDefinitions(
  definitions: Record<string, { type: string; defaultValue: boolean | string }>,
): Record<string, SimplifiedPropertyDefinition> {
  const result: Record<string, SimplifiedPropertyDefinition> = {};
  for (const [name, def] of Object.entries(definitions)) {
    if (def.type === "BOOLEAN" || def.type === "TEXT") {
      result[stripPropertyNameSuffix(name)] = {
        type: def.type.toLowerCase(),
        defaultValue: def.defaultValue,
      };
    }
  }
  return result;
}

/**
 * Simplify componentPropertyReferences from the raw Figma format.
 * Strips #nodeId suffixes from property names and renames "characters" key to "text"
 * to match SimplifiedNode's text field.
 * Only handles "visible" (BOOLEAN) and "characters" (TEXT) references for Phase 1.
 */
export function simplifyPropertyReferences(
  references: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(references)) {
    if (key === "visible" || key === "characters") {
      const outputKey = key === "characters" ? "text" : key;
      result[outputKey] = stripPropertyNameSuffix(value);
    }
  }
  return result;
}

/**
 * Simplify instance componentProperties from the verbose Figma format to a flat
 * Record of property name → value. Only extracts BOOLEAN and TEXT properties for Phase 1.
 */
export function simplifyComponentProperties(
  properties: Record<string, { type: string; value: boolean | string }>,
): Record<string, boolean | string> {
  const result: Record<string, boolean | string> = {};
  for (const [name, prop] of Object.entries(properties)) {
    if (prop.type === "BOOLEAN" || prop.type === "TEXT") {
      result[stripPropertyNameSuffix(name)] = prop.value;
    }
  }
  return result;
}

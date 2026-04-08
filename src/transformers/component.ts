import type { Component, ComponentSet } from "@figma/rest-api-spec";

export interface SimplifiedComponentDefinition {
  id: string;
  key: string;
  name: string;
  componentSetId?: string;
  propertyDefinitions?: Record<string, boolean | string>;
}

export interface SimplifiedComponentSetDefinition {
  id: string;
  key: string;
  name: string;
  description?: string;
  propertyDefinitions?: Record<string, boolean | string>;
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
): Record<string, boolean | string> {
  const result: Record<string, boolean | string> = {};
  for (const [name, def] of Object.entries(definitions)) {
    if (def.type === "BOOLEAN" || def.type === "TEXT") {
      result[stripPropertyNameSuffix(name)] = def.defaultValue;
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

/**
 * Remove unnecessary component properties and convert to simplified format.
 */
export function simplifyComponents(
  aggregatedComponents: Record<string, Component>,
  propertyDefinitions?: Record<string, Record<string, boolean | string>>,
): Record<string, SimplifiedComponentDefinition> {
  return Object.fromEntries(
    Object.entries(aggregatedComponents).map(([id, comp]) => [
      id,
      {
        id,
        key: comp.key,
        name: comp.name,
        componentSetId: comp.componentSetId,
        ...(propertyDefinitions?.[id] && {
          propertyDefinitions: propertyDefinitions[id],
        }),
      },
    ]),
  );
}

/**
 * Remove unnecessary component set properties and convert to simplified format.
 */
export function simplifyComponentSets(
  aggregatedComponentSets: Record<string, ComponentSet>,
  propertyDefinitions?: Record<string, Record<string, boolean | string>>,
): Record<string, SimplifiedComponentSetDefinition> {
  return Object.fromEntries(
    Object.entries(aggregatedComponentSets).map(([id, set]) => [
      id,
      {
        id,
        key: set.key,
        name: set.name,
        description: set.description,
        ...(propertyDefinitions?.[id] && {
          propertyDefinitions: propertyDefinitions[id],
        }),
      },
    ]),
  );
}

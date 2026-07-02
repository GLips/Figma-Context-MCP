import type { Component, ComponentSet } from "@figma/rest-api-spec";
import type {
  SimplifiedComponentDefinition,
  SimplifiedComponentSetDefinition,
  SimplifiedPropertyDefinition,
} from "~/transformers/component.js";

/**
 * REST adapter: decode the top-level `components` / `componentSets` tables into
 * the simplified definition maps the output carries. These tables are a
 * REST-specific coupling spot (Invariant 2) — they live outside the node tree in
 * the API response, so they're parsed here rather than in the core walk. The
 * per-node component simplifiers stay in transformers/component.ts (Figma-free).
 */

/**
 * Remove unnecessary component properties and convert to simplified format.
 */
export function simplifyComponents(
  aggregatedComponents: Record<string, Component>,
  propertyDefinitions?: Record<string, Record<string, SimplifiedPropertyDefinition>>,
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
  propertyDefinitions?: Record<string, Record<string, SimplifiedPropertyDefinition>>,
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

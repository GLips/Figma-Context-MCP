import yaml from "js-yaml";
import type { SimplifiedDesign, SimplifiedNode } from "~/extractors/types.js";

/**
 * Render the simplified design as a token-efficient indented tree.
 *
 * Structural keys (id, name, type, children) are encoded positionally on each
 * node line, eliminating the YAML/JSON overhead of repeating those keys for
 * every node. Style values stay deduplicated in a globalVars block at the top,
 * so identical styling across many nodes still pays once — the win over
 * inline-only formats grows with how much style reuse the design has.
 *
 * Node line format:
 *   [TYPE] "name" #id key=value key=value ...
 *
 * All SimplifiedNode fields are preserved; this is a serialization change only.
 */
export function serializeAsTree(design: SimplifiedDesign): string {
  const sections: string[] = [];

  sections.push(`NAME: ${design.name}`);

  if (Object.keys(design.globalVars.styles).length > 0) {
    sections.push(`\nGLOBAL_VARS:\n${dumpYaml(design.globalVars.styles)}`);
  }

  if (Object.keys(design.components).length > 0) {
    sections.push(`COMPONENTS:\n${dumpYaml(design.components)}`);
  }

  if (Object.keys(design.componentSets).length > 0) {
    sections.push(`COMPONENT_SETS:\n${dumpYaml(design.componentSets)}`);
  }

  const lines: string[] = ["NODES:"];
  for (const node of design.nodes) {
    renderNode(node, 0, lines);
  }
  sections.push(lines.join("\n"));

  return sections.join("\n");
}

function dumpYaml(value: unknown): string {
  return yaml.dump(value, {
    noRefs: true,
    lineWidth: -1,
    noCompatMode: true,
    schema: yaml.JSON_SCHEMA,
  });
}

function renderNode(node: SimplifiedNode, depth: number, out: string[]): void {
  const indent = "  ".repeat(depth);
  const parts: string[] = [];

  parts.push(`[${node.type}]`);
  parts.push(quote(node.name));
  parts.push(`#${node.id}`);

  // Order chosen to put high-signal properties first
  if (node.layout !== undefined) parts.push(`layout=${node.layout}`);
  if (node.fills !== undefined) parts.push(`fills=${maybeQuote(node.fills)}`);
  if (node.strokes !== undefined) parts.push(`strokes=${maybeQuote(node.strokes)}`);
  if (node.strokeWeight !== undefined) parts.push(`strokeWeight=${maybeQuote(node.strokeWeight)}`);
  if (node.strokeWeights !== undefined) {
    parts.push(`strokeWeights=${maybeQuote(node.strokeWeights)}`);
  }
  if (node.strokeDashes !== undefined) parts.push(`strokeDashes=${node.strokeDashes.join(",")}`);
  if (node.effects !== undefined) parts.push(`effects=${maybeQuote(node.effects)}`);
  if (node.opacity !== undefined) parts.push(`opacity=${node.opacity}`);
  if (node.borderRadius !== undefined) parts.push(`borderRadius=${maybeQuote(node.borderRadius)}`);
  if (node.styles !== undefined) parts.push(`styles=${maybeQuote(node.styles)}`);
  if (node.componentId !== undefined) parts.push(`componentId=${node.componentId}`);
  if (node.componentProperties !== undefined) {
    parts.push(`componentProperties=${encodeRecord(node.componentProperties)}`);
  }
  if (node.componentPropertyReferences !== undefined) {
    parts.push(`componentPropertyReferences=${encodeRecord(node.componentPropertyReferences)}`);
  }
  if (node.textStyle !== undefined) parts.push(`textStyle=${node.textStyle}`);
  if (node.boldWeight !== undefined) parts.push(`boldWeight=${node.boldWeight}`);
  if (node.text !== undefined) parts.push(`text=${quote(node.text)}`);

  out.push(indent + parts.join(" "));

  if (node.children) {
    for (const child of node.children) {
      renderNode(child, depth + 1, out);
    }
  }
}

// Always JSON-quote name and text so embedded whitespace, quotes, or newlines
// can't break the line-per-node parse contract.
function quote(s: string): string {
  return JSON.stringify(s);
}

// Quote only when the value would otherwise break the space-separated
// `key=value` parse — keeps short scalar refs (`layout_ABC`, `12px`) unquoted.
function maybeQuote(s: string): string {
  return /[\s"]/.test(s) ? JSON.stringify(s) : s;
}

// Inline a Record as key:val pairs joined by commas. Values that contain commas
// or colons (rare in component property names/values, but possible) are quoted.
function encodeRecord(record: Record<string, string | boolean>): string {
  const entries = Object.entries(record).map(([k, v]) => {
    const val = typeof v === "string" && /[,:\s"]/.test(v) ? JSON.stringify(v) : String(v);
    return `${k}:${val}`;
  });
  return entries.join(",");
}

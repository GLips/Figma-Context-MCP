import type { SimplifiedNode } from "~/extractors/types.js";
import type { SerializableDesign } from "./serializable-design.js";
import { dumpYaml } from "./yaml-dump.js";

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
export function serializeAsTree(design: SerializableDesign): string {
  const sections: string[] = [];

  // Quote the design name — designers can use anything, including ":" or
  // whitespace, which would otherwise produce a malformed `NAME: foo: bar` line.
  sections.push(`NAME: ${quote(design.metadata.name)}`);

  if (Object.keys(design.globalVars.styles).length > 0) {
    sections.push(`\nGLOBAL_VARS:\n${dumpYaml(design.globalVars.styles)}`);
  }

  // Deduplicated element bodies referenced by node `template=` fields below.
  if (design.elements && Object.keys(design.elements).length > 0) {
    sections.push(`ELEMENTS:\n${dumpYaml(design.elements)}`);
  }

  if (Object.keys(design.metadata.components).length > 0) {
    sections.push(`COMPONENTS:\n${dumpYaml(design.metadata.components)}`);
  }

  if (Object.keys(design.metadata.componentSets).length > 0) {
    sections.push(`COMPONENT_SETS:\n${dumpYaml(design.metadata.componentSets)}`);
  }

  const lines: string[] = ["NODES:"];
  for (const node of design.nodes) {
    renderNode(node, 0, lines, design.elements);
  }
  sections.push(lines.join("\n"));

  return sections.join("\n");
}

function renderNode(
  node: SimplifiedNode,
  depth: number,
  out: string[],
  elements: SerializableDesign["elements"],
): void {
  const indent = "  ".repeat(depth);
  const parts: string[] = [];

  // A template reference carries no body of its own — its type and styling live
  // in the shared element. Render the type label from there so the line keeps the
  // familiar `[TYPE] "name" #id` shape, then point at the template.
  const element = node.template ? elements?.[node.template] : undefined;
  parts.push(`[${element?.type ?? node.type}]`);
  // Name is dropped upstream (wrapForSerialization) when it is noise, so the
  // token is conditional and the line collapses to `[TYPE] #id ...`.
  if (node.name !== undefined) parts.push(quote(node.name));
  parts.push(`#${node.id}`);
  if (node.template !== undefined) parts.push(`template=${node.template}`);

  // Order chosen to put high-signal properties first
  if (node.layout !== undefined) parts.push(`layout=${renderStyleValue(node.layout)}`);
  if (node.fills !== undefined) parts.push(`fills=${renderStyleValue(node.fills)}`);
  if (node.strokes !== undefined) parts.push(`strokes=${renderStyleValue(node.strokes)}`);
  if (node.strokeWeight !== undefined) parts.push(`strokeWeight=${maybeQuote(node.strokeWeight)}`);
  if (node.strokeWeights !== undefined) {
    parts.push(`strokeWeights=${maybeQuote(node.strokeWeights)}`);
  }
  if (node.strokeDashes !== undefined) parts.push(`strokeDashes=${node.strokeDashes.join(",")}`);
  if (node.effects !== undefined) parts.push(`effects=${renderStyleValue(node.effects)}`);
  if (node.opacity !== undefined) parts.push(`opacity=${node.opacity}`);
  if (node.borderRadius !== undefined) parts.push(`borderRadius=${maybeQuote(node.borderRadius)}`);
  if (node.styles !== undefined) parts.push(`styles=${maybeQuote(node.styles)}`);
  if (node.componentId !== undefined) parts.push(`componentId=${node.componentId}`);
  if (node.componentProperties !== undefined) {
    parts.push(`componentProperties=${JSON.stringify(node.componentProperties)}`);
  }
  if (node.componentPropertyReferences !== undefined) {
    parts.push(`componentPropertyReferences=${JSON.stringify(node.componentPropertyReferences)}`);
  }
  if (node.textStyle !== undefined) parts.push(`textStyle=${renderStyleValue(node.textStyle)}`);
  if (node.boldWeight !== undefined) parts.push(`boldWeight=${node.boldWeight}`);
  if (node.text !== undefined) parts.push(`text=${quote(node.text)}`);

  out.push(indent + parts.join(" "));

  if (node.children) {
    for (const child of node.children) {
      renderNode(child, depth + 1, out, elements);
    }
  }
}

// Style fields hold either a globalVars reference (a short scalar id) or, for
// single-use values after the finalize pass, the inline value itself. Refs render
// bare; inline objects/arrays render as compact JSON (consistent with how
// componentProperties is rendered), keeping the whole node on one line.
function renderStyleValue(value: unknown): string {
  return typeof value === "string" ? maybeQuote(value) : JSON.stringify(value);
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

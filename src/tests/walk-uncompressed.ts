import type { Node as FigmaNode, Style } from "@figma/rest-api-spec";
import { restNodeToSnapshot, type RestComponentTables } from "~/adapters/rest/node-to-snapshot.js";
import type { StyleValue, TraversalOptions } from "@framelink/core";
import {
  createComponentNotes,
  createRefStyleTable,
  extractComponents,
  walkNodes,
} from "@framelink/core/internal";

// The uncompressed walk — what `simplify` runs before `compressDesign`. Three read-path suites
// need the output and style sink before compression rewrites both. Kept to one file so the
// divergent-walk toolkit has a single call site to audit.
export async function walkUncompressed(
  nodes: FigmaNode[],
  options: {
    traversal?: TraversalOptions;
    extraStyles?: Record<string, Style>;
    /** Pre-registered entries; `resolveStyleKey` treats anything already in the table as taken. */
    seedStyles?: Record<string, StyleValue>;
    /** The response envelope's component tables, folded onto the nodes by the adapter. */
    tables?: RestComponentTables;
  } = {},
) {
  const sink = createRefStyleTable();
  Object.assign(sink.styles, options.seedStyles);
  const notes = createComponentNotes();
  const extracted = await walkNodes(
    nodes.map((node) => restNodeToSnapshot(node, options.extraStyles, options.tables)),
    sink,
    options.traversal,
    notes,
  );
  // The components pass runs here too: it is not part of compression (the plugin reads
  // expanded and still gets the sidecar), so an uncompressed walk without it would be a shape
  // no producer emits.
  const components = extractComponents(extracted, notes);
  return { nodes: extracted, styles: sink.styles, components };
}

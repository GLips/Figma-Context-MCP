import type { Node as FigmaNode, Style } from "@figma/rest-api-spec";
import { restNodeToSnapshot } from "~/adapters/rest/node-to-snapshot.js";
import type { StyleValue, TraversalOptions } from "@framelink/core";
import { createRefStyleTable, walkNodes } from "@framelink/core/internal";

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
  } = {},
) {
  const sink = createRefStyleTable();
  Object.assign(sink.styles, options.seedStyles);
  const extracted = await walkNodes(
    nodes.map((node) => restNodeToSnapshot(node, options.extraStyles)),
    sink,
    options.traversal,
  );
  return { nodes: extracted, styles: sink.styles };
}

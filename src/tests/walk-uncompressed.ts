import type { Node as FigmaNode, Style } from "@figma/rest-api-spec";
import { restNodeToSnapshot, type RestComponentTables } from "~/adapters/rest/node-to-snapshot.js";
import { simplify } from "@framelink/core";
import type { TraversalOptions } from "@framelink/core";
import { createRefStyleTable, projectIntoTable } from "@framelink/core/internal";

// The uncompressed walk — what `simplify` runs before `compressDesign`. Three read-path suites
// need the output and style sink before compression rewrites both. Kept to one file so the
// divergent-walk toolkit has a single call site to audit.
export async function walkUncompressed(
  nodes: FigmaNode[],
  options: {
    traversal?: TraversalOptions;
    extraStyles?: Record<string, Style>;
    /** The response envelope's component tables, folded onto the nodes by the adapter. */
    tables?: RestComponentTables;
  } = {},
) {
  const sink = createRefStyleTable();
  const full = await simplify(
    nodes.map((node) => restNodeToSnapshot(node, options.extraStyles, options.tables)),
  );
  const result = projectIntoTable(full, sink, options.traversal);
  return { ...result, styles: sink.styles };
}

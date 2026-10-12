import type { Node as FigmaNode, Style } from "@figma/rest-api-spec";
import { restNodeToSnapshot } from "~/adapters/rest/decode/node-to-snapshot.js";
import type { RestComponentTables } from "~/adapters/rest/decode/component-tables.js";
import { project, simplify } from "@framelink/core";
import type { TraversalOptions } from "@framelink/core";
import { internStyleValues } from "@framelink/core/internal";

// The projected walk with every style value interned but none gated or templated — the state
// compression starts from. Read-path suites assert on a value's ref and table entry before
// compression inlines single-use ones. Kept to one file so the divergent-walk toolkit has a
// single call site to audit.
export async function walkUncompressed(
  nodes: FigmaNode[],
  options: {
    traversal?: TraversalOptions;
    extraStyles?: Record<string, Style>;
    /** The response envelope's component tables, folded onto the nodes by the adapter. */
    tables?: RestComponentTables;
  } = {},
) {
  const full = await simplify(
    nodes.map((node) => restNodeToSnapshot(node, options.extraStyles, options.tables)),
  );
  const result = project(full, options.traversal);
  const surfaces = [
    result.nodes,
    ...Object.values(result.components).flatMap((entry) =>
      entry.children ? [entry.children] : [],
    ),
  ];
  return { ...result, styles: internStyleValues(surfaces) };
}

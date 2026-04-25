import yaml from "js-yaml";
import type { SimplifiedDesign } from "~/extractors/types.js";
import { serializeAsTree } from "./serialize-tree.js";

export type OutputFormat = "yaml" | "json" | "tree";

export function serializeResult(result: unknown, format: OutputFormat): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  if (format === "tree") {
    return serializeAsTree(result as SimplifiedDesign);
  }
  // Output goes to LLMs, not human editors — optimize for speed over readability.
  // noRefs skips O(n²) reference detection; lineWidth:-1 skips line-folding;
  // JSON_SCHEMA reduces per-string implicit type checks.
  return yaml.dump(result, {
    noRefs: true,
    lineWidth: -1,
    noCompatMode: true,
    schema: yaml.JSON_SCHEMA,
  });
}

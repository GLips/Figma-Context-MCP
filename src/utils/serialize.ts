import { serializeAsTree } from "./serialize-tree.js";
import type { SerializableDesign } from "./serializable-design.js";
import { dumpYaml } from "./yaml-dump.js";

export type OutputFormat = "yaml" | "json" | "tree";

export const VALID_OUTPUT_FORMATS: readonly OutputFormat[] = ["yaml", "json", "tree"];

export function isOutputFormat(value: string): value is OutputFormat {
  return (VALID_OUTPUT_FORMATS as readonly string[]).includes(value);
}

// Accepts `unknown` so YAML/JSON callers can pass arbitrary structures (tests,
// debug dumps, partial fixtures); the tree path requires the design wrapper
// shape and casts at its boundary. Production callers go through
// `wrapForSerialization` which enforces the contract at compile time.
export function serializeResult(result: unknown, format: OutputFormat): string {
  if (format === "json") return JSON.stringify(result, null, 2);
  if (format === "tree") return serializeAsTree(result as SerializableDesign);
  return dumpYaml(result);
}

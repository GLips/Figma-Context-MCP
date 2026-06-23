/**
 * Render a saved SimplifiedDesign fixture in a chosen output format.
 * Used to feed pre-rendered design data to sub-agents during /trial benchmarks
 * without forcing the parent conversation to ingest the multi-MB JSON.
 *
 * Usage:
 *   pnpm tsx scripts/render-fixture.ts --input <path> --format <yaml|json|tree> --output <path>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { serializeResult, isOutputFormat, VALID_OUTPUT_FORMATS } from "../src/utils/serialize.js";
import { wrapForSerialization } from "../src/utils/serializable-design.js";
import type { SimplifiedDesign } from "../src/extractors/types.js";

const { values } = parseArgs({
  options: {
    input: { type: "string" },
    format: { type: "string", default: "yaml" },
    output: { type: "string" },
  },
});

if (!values.input || !values.output) {
  console.error(
    "Usage: render-fixture.ts --input <path> --format <yaml|json|tree> --output <path>",
  );
  process.exit(1);
}

if (!isOutputFormat(values.format!)) {
  console.error(
    `Invalid format: ${values.format}. Expected one of: ${VALID_OUTPUT_FORMATS.join(", ")}`,
  );
  process.exit(1);
}

const design = JSON.parse(readFileSync(values.input, "utf8")) as SimplifiedDesign;
const output = serializeResult(wrapForSerialization(design), values.format);
writeFileSync(values.output, output);

console.error(
  `Rendered ${values.input} as ${values.format} → ${values.output} (${output.length.toLocaleString()} bytes)`,
);

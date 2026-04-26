/**
 * Compare serialization formats on a real simplified-design fixture.
 *
 * Usage: pnpm tsx scripts/compare-formats.ts [path/to/figma-simplified.json]
 *
 * Reads a SimplifiedDesign JSON, renders it as yaml / json / tree, prints
 * byte counts and ratios. Also writes each output next to the fixture so the
 * tree format can be eyeballed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { serializeResult } from "../src/utils/serialize.js";
import { wrapForSerialization } from "../src/utils/serializable-design.js";
import type { SimplifiedDesign, SimplifiedNode } from "../src/extractors/types.js";

const inputPath = resolve(process.argv[2] ?? "logs/figma-simplified.json");
const design = JSON.parse(readFileSync(inputPath, "utf8")) as SimplifiedDesign;
const wrapped = wrapForSerialization(design);

const yamlOut = serializeResult(wrapped, "yaml");
const jsonOut = serializeResult(wrapped, "json");
const treeOut = serializeResult(wrapped, "tree");

const outDir = dirname(inputPath);
const stem = basename(inputPath, ".json");
writeFileSync(resolve(outDir, `${stem}.yaml`), yamlOut);
writeFileSync(resolve(outDir, `${stem}.tree`), treeOut);

const yamlBytes = Buffer.byteLength(yamlOut, "utf8");
const jsonBytes = Buffer.byteLength(jsonOut, "utf8");
const treeBytes = Buffer.byteLength(treeOut, "utf8");

const nodeCount = countNodes(design.nodes);
const styleCount = Object.keys(design.globalVars.styles).length;
const componentCount = Object.keys(design.components).length;

console.log(`Fixture: ${inputPath}`);
console.log(`  nodes: ${nodeCount}`);
console.log(`  globalVars styles: ${styleCount}`);
console.log(`  components: ${componentCount}`);
console.log();

const fmt = (n: number) => n.toLocaleString().padStart(10);
const pct = (n: number, base: number) => `${((n / base - 1) * 100).toFixed(1).padStart(6)}%`;

console.log(`Format   ${"bytes".padStart(10)}   vs YAML   vs JSON`);
console.log(
  `yaml     ${fmt(yamlBytes)}   ${pct(yamlBytes, yamlBytes)}   ${pct(yamlBytes, jsonBytes)}`,
);
console.log(
  `json     ${fmt(jsonBytes)}   ${pct(jsonBytes, yamlBytes)}   ${pct(jsonBytes, jsonBytes)}`,
);
console.log(
  `tree     ${fmt(treeBytes)}   ${pct(treeBytes, yamlBytes)}   ${pct(treeBytes, jsonBytes)}`,
);
console.log();

const yamlSavings = ((1 - treeBytes / yamlBytes) * 100).toFixed(1);
console.log(`tree saves ${yamlSavings}% over yaml on this fixture (byte count, not tokens)`);

function countNodes(nodes: SimplifiedNode[]): number {
  let total = 0;
  for (const n of nodes) {
    total += 1;
    if (n.children) total += countNodes(n.children);
  }
  return total;
}

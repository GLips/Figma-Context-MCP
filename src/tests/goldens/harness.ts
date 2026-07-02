import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  simplifyRawFigmaObject,
  allExtractors,
  collapseSvgContainers,
} from "~/extractors/index.js";
import type { SimplifiedDesign } from "~/extractors/types.js";
import type { GoldenFixture } from "./fixtures.js";

// Directory holding the committed golden outputs (one <name>.json per fixture).
export const EXPECTED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "expected");

/**
 * Run a fixture through the PUBLIC simplify entry with the exact options
 * production uses (`getFigmaData` calls it with `afterChildren:
 * collapseSvgContainers`). Targeting the public entry — not the extractor
 * internals — is what lets these goldens survive the carve gutting everything
 * underneath.
 */
export async function runFixture(fixture: GoldenFixture): Promise<SimplifiedDesign> {
  return simplifyRawFigmaObject(fixture.response, allExtractors, {
    afterChildren: collapseSvgContainers,
  });
}

/**
 * Serialize a design to the exact golden string: insertion-order pretty JSON.
 *
 * Insertion order (NOT stable-sorted keys) is deliberate — it's the byte order
 * the tool actually emits, so the goldens gate key ORDER too, not just semantic
 * structure. A refactor that reordered output fields changes the bytes an LLM
 * receives; a key-insensitive `toEqual` would wave that through. The carve was
 * verified byte-identical (including key order) against pre-carve `main`, so
 * this order-sensitive form is a faithful, not accidental, baseline.
 */
export function serializeGolden(design: SimplifiedDesign): string {
  return JSON.stringify(design, null, 2) + "\n";
}

export function expectedPath(name: string): string {
  return path.join(EXPECTED_DIR, `${name}.json`);
}

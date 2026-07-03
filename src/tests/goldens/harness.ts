import { fileURLToPath } from "node:url";
import path from "node:path";
import { simplifyRawFigmaObject } from "~/adapters/rest/design-extractor.js";
import type { SimplifiedDesign } from "~/core/types.js";
import type { GoldenFixture } from "./fixtures.js";

// Directory holding the committed golden outputs (one <name>.json per fixture).
export const EXPECTED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "expected");

/**
 * Run a fixture through the PUBLIC simplify entry exactly as production does
 * (`getFigmaData` passes only depth/progress options). Targeting the public
 * entry — not the walk internals — is what lets these goldens survive
 * refactors gutting everything underneath.
 */
export async function runFixture(fixture: GoldenFixture): Promise<SimplifiedDesign> {
  return simplifyRawFigmaObject(fixture.response);
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

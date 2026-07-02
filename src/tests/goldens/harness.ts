import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  simplifyRawFigmaObject,
  allExtractors,
  collapseSvgContainers,
} from "~/extractors/index.js";
import { stableStringify } from "~/utils/common.js";
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
 * Canonicalize a design for comparison: stable-sorted keys via `stableStringify`
 * (the repo's deterministic serializer), re-parsed to a plain object so Vitest's
 * `toEqual` produces a readable structural diff on mismatch. Raw `JSON.stringify`
 * is intentionally avoided — key order isn't a stable guarantee across the carve.
 */
export function canonical(design: SimplifiedDesign): unknown {
  return JSON.parse(stableStringify(design));
}

export function expectedPath(name: string): string {
  return path.join(EXPECTED_DIR, `${name}.json`);
}

/**
 * Manually regenerate the committed golden outputs for the canonicalize carve.
 *
 *   pnpm tsx src/tests/goldens/regenerate.ts
 *
 * Run this ONLY when an output change is intentional, and review the resulting
 * diff deliberately. This is deliberately a standalone script rather than
 * vitest's `-u` snapshot update: a reflexive `-u` during the carve would
 * silently re-baseline a behavior regression and defeat Invariant 1's safety
 * net. (Lives under the test tree because `scripts/` is gitignored.)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { GOLDEN_FIXTURES } from "./fixtures.js";
import { runFixture, canonical, expectedPath, EXPECTED_DIR } from "./harness.js";

mkdirSync(EXPECTED_DIR, { recursive: true });

for (const fixture of GOLDEN_FIXTURES) {
  const design = await runFixture(fixture);
  const json = JSON.stringify(canonical(design), null, 2);
  writeFileSync(expectedPath(fixture.name), json + "\n");
  console.error(`Wrote golden: ${fixture.name} (${json.length.toLocaleString()} bytes)`);
}

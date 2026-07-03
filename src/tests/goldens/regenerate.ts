/**
 * Manually regenerate the committed golden outputs for the simplify core.
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
import { runFixture, serializeGolden, expectedPath, EXPECTED_DIR } from "./harness.js";

mkdirSync(EXPECTED_DIR, { recursive: true });

for (const fixture of GOLDEN_FIXTURES) {
  const golden = serializeGolden(await runFixture(fixture));
  writeFileSync(expectedPath(fixture.name), golden);
  console.error(`Wrote golden: ${fixture.name} (${golden.length.toLocaleString()} bytes)`);
}

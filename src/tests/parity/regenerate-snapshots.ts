/**
 * Manually regenerate the committed plan-neutral snapshot fixtures.
 *
 *   pnpm tsx src/tests/parity/regenerate-snapshots.ts
 *
 * Run this ONLY when a snapshot change is intentional (the REST decode changed on
 * purpose), and review the diff deliberately — parity.test.ts gates these faithful
 * to the live REST decode, so a stale fixture fails loudly rather than silently.
 * A standalone script, not a vitest `-u`, for the same reason the goldens use one:
 * a reflexive update must not re-baseline a regression. (Lives under the test tree
 * because `scripts/` is gitignored.)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { GOLDEN_FIXTURES } from "../goldens/fixtures.js";
import { restResponseToSnapshots } from "~/adapters/rest/design-extractor.js";
import { SNAPSHOTS_DIR, snapshotPath } from "./snapshots-io.js";

mkdirSync(SNAPSHOTS_DIR, { recursive: true });

for (const fixture of GOLDEN_FIXTURES) {
  const { snapshots } = restResponseToSnapshots(fixture.response);
  const json = JSON.stringify(snapshots, null, 2) + "\n";
  writeFileSync(snapshotPath(fixture.name), json);
  console.error(`Wrote snapshot: ${fixture.name} (${json.length.toLocaleString()} bytes)`);
}

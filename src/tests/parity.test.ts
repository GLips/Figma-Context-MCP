import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import type { SimplifiedDesign } from "~/core/types.js";
import { restResponseToSnapshots } from "~/adapters/rest/design-extractor.js";
import { GOLDEN_FIXTURES } from "./goldens/fixtures.js";
import { expectedPath } from "./goldens/harness.js";
import { PARITY_CASES } from "./parity/cases.js";
import { PARITY_PRODUCERS } from "./parity/producers.js";
import { loadSnapshot } from "./parity/snapshots-io.js";
import { parityView } from "./parity/shared-subset.js";

/**
 * REST↔plugin parity harness — "one output, two producers" (plan Phase 4).
 *
 * Every producer that can produce a design for a case must reduce to the SAME
 * shared view (parityView), and that view must equal the golden's — so the
 * canonical output can't fork between the REST decode and the plugin's future
 * `sceneNodeToSnapshot`. Today two producers run (`rest`, `snapshot`); the read
 * plan registers the plugin producer and it joins the fan-out with no change here.
 *
 * The strict byte-exact golden regression gate is separate (goldens.test.ts) —
 * this harness deliberately compares the SHARED SUBSET (via parityView) so a
 * producer's legitimate incidental differences and future plugin enrichments
 * don't read as parity failures.
 */
describe("parity harness", () => {
  // The committed snapshot fixtures are the read plan's concrete target, so they
  // must stay faithful to what the REST adapter actually decodes. `toEqual` (not
  // `toStrictEqual`) so the JSON round-trip's dropped `undefined` fields — absent
  // in the committed file, present-but-undefined in a live decode — don't matter.
  describe("committed snapshots stay faithful to the REST decode", () => {
    for (const fixture of GOLDEN_FIXTURES) {
      it(`snapshot matches the live decode for "${fixture.name}"`, () => {
        const fresh = restResponseToSnapshots(fixture.response).snapshots;
        expect(loadSnapshot(fixture.name)).toEqual(fresh);
      });
    }
  });

  describe("producers agree over the shared subset", () => {
    for (const parityCase of PARITY_CASES) {
      it(`all producers reduce to the golden for "${parityCase.name}"`, async () => {
        const golden = JSON.parse(
          readFileSync(expectedPath(parityCase.name), "utf8"),
        ) as SimplifiedDesign;
        const target = parityView(golden);

        for (const producer of PARITY_PRODUCERS) {
          const produced = producer.produce(parityCase);
          if (!produced) continue; // producer has no input for this case (e.g. plugin slot)
          const design = await produced;
          expect(parityView(design), `producer "${producer.id}"`).toEqual(target);
        }
      });
    }
  });
});

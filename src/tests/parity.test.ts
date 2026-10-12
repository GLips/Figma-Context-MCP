import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import type { SimplifiedDesign } from "@framelink/core";
import { parseRestResponse } from "~/adapters/rest/decode/response.js";
import { GOLDEN_FIXTURES } from "./goldens/fixtures.js";
import { expectedPath } from "./goldens/harness.js";
import { PARITY_CASES } from "./parity/cases.js";
import { PARITY_PRODUCERS } from "./parity/producers.js";
import { loadSnapshot } from "./parity/snapshots-io.js";
import { parityView } from "./parity/shared-subset.js";
import { loadSceneTokenIds } from "./parity/scenes-io.js";

/**
 * REST↔plugin parity harness — "one output, two producers".
 *
 * Every producer must reduce every case to the SAME shared view (parityView), and
 * that view must equal the golden's — so the canonical output can't fork between
 * `restNodeToSnapshot` and the plugin's `sceneNodeToSnapshot`. Three parity
 * producers run: `rest` and `scene` (the two live adapters), plus `snapshot`, which
 * feeds the committed decode straight to core to localize a failure.
 *
 * The strict byte-exact golden regression gate is separate (goldens.test.ts) —
 * this harness deliberately compares the SHARED SUBSET (via parityView) so a
 * producer's legitimate incidental differences and plugin-only enrichments
 * don't read as parity failures.
 */
describe("parity harness", () => {
  // The committed snapshot fixtures must stay faithful to what the REST adapter
  // actually decodes. `toEqual` (not
  // `toStrictEqual`) so the JSON round-trip's dropped `undefined` fields — absent
  // in the committed file, present-but-undefined in a live decode — don't matter.
  describe("committed snapshots stay faithful to the REST decode", () => {
    for (const fixture of GOLDEN_FIXTURES.filter(({ nodeId }) => nodeId === undefined)) {
      it(`snapshot matches the live decode for "${fixture.name}"`, () => {
        const fresh = parseRestResponse(fixture.response).snapshots;
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
        const tokenIds = loadSceneTokenIds(parityCase.name);
        const target = parityView(golden, tokenIds);

        for (const producer of PARITY_PRODUCERS) {
          const design = await producer.produce(parityCase);
          if (!design) continue;
          expect(parityView(design, tokenIds), `producer "${producer.id}"`).toEqual(target);
        }
      });
    }
  });
});

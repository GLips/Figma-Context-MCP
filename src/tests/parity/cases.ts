import { GOLDEN_FIXTURES } from "../goldens/fixtures.js";
import type { ParityCase } from "./producers.js";
import { loadSnapshot } from "./snapshots-io.js";

/**
 * The parity cases: the 8 golden fixtures, each paired with its committed
 * plan-neutral snapshot. The REST response and the snapshot are the two producer
 * inputs; both must reduce to the same shared view of the golden. Reuses
 * GOLDEN_FIXTURES so the parity target can never drift from the byte-exact
 * regression goldens.
 */
export const PARITY_CASES: ParityCase[] = GOLDEN_FIXTURES.map((fixture) => ({
  name: fixture.name,
  rest: fixture.response,
  snapshot: loadSnapshot(fixture.name),
}));

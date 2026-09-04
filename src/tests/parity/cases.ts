import { GOLDEN_FIXTURES } from "../goldens/fixtures.js";
import type { ParityCase } from "./producers.js";
import { loadSnapshot } from "./snapshots-io.js";
import { loadScene } from "./scenes-io.js";

/**
 * The parity cases: every golden fixture, each paired with its committed
 * plan-neutral snapshot and (where one exists yet) its plugin-native scene
 * fixture. The producer inputs must all reduce to the same shared view of the
 * golden. Reuses GOLDEN_FIXTURES so the parity target can never drift from the
 * byte-exact regression goldens.
 */
export const PARITY_CASES: ParityCase[] = GOLDEN_FIXTURES.map((fixture) => ({
  name: fixture.name,
  rest: fixture.response,
  snapshot: loadSnapshot(fixture.name),
  scene: loadScene(fixture.name),
}));

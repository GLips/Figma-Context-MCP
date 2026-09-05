import type { Flcm } from "@framelink/plugin/schema";

// The copy-what's-already-there worked example — the read↔write seam. Authored against the REAL typed
// surface (Flcm), so a change to get/fromRead/append breaks this file's typecheck rather than shipping a
// stale example. The generator inlines only the marked region below (see examples.ts).
export async function reuseExample(flcm: Flcm) {
  // example:start
  // Copy a card that already exists on the canvas into a different container, widened on the way.
  // `get` reads it as the canonical shape; `fromRead` re-authors that shape through the constructors,
  // which is what makes it a COPY. A bare read spec carries the original's live id, so passing one
  // straight to `append` is refused rather than read as "move the node I just looked at".
  // `get` returns an envelope — `node` is the spec, and `components` (when the card holds instances)
  // names each component once, with the children every instance shares.
  const { node } = await flcm.get("card");
  const wider = flcm.fromRead({ ...node, width: 480, name: "Card (wide)" });
  const placed = await flcm.append("sidebar", wider);

  // fromRead REBUILDS, so it reaches only what flcm can author: an INSTANCE, a stacked paint, or a grid
  // container fails loud naming the field. flcm.clone(target, parent) duplicates the live node whole —
  // faithful, but not editable as a spec first.
  return placed;
  // example:end
}

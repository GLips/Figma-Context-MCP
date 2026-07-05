// find(query?, predicate?) live round-trip: render a frame with mixed-fill rects, then locate by a
// predicate over the EXPANDED read shape (fills are inline hex, not styles refs) — exercising the hybrid
// filter (query pre-filter → materialize survivors → predicate) inside the preamble IIFE against live nodes.
const swatches = flcm.frame(
  {
    key: "swatches",
    width: 320,
    fill: "#ffffff",
    layout: { mode: "row", gap: 12, padding: 24 },
  },
  [
    flcm.rect({ key: "green", width: 48, height: 48, fill: "#22c55e" }),
    flcm.rect({ key: "white", width: 48, height: 48, fill: "#ffffff" }),
    flcm.rect({ key: "faded", width: 48, height: 48, fill: "#22c55e", opacity: 0.5 }),
  ],
);
await flcm.render(swatches);

// Predicate over inline styling values. A plain query find would need the exact key; the predicate lets us
// ask "every rect with a white fill" — the survivor is a SlimHandle (find's contract holds).
const whites = await flcm.find({ type: "RECTANGLE" }, (n) => Array.isArray(n.fills) && n.fills[0] === "#FFFFFF");
console.log("white rects:", JSON.stringify(whites.map((h) => h.key)));

// Predicate on a different styling field (opacity) — the faded rect only.
const faded = await flcm.find({ type: "RECTANGLE" }, (n) => n.opacity !== undefined && n.opacity < 1);
console.log("faded rects:", JSON.stringify(faded.map((h) => h.key)));

// The query pre-filter narrows candidates: same white-fill predicate scoped to FRAMEs finds the container,
// not the rects.
const whiteFrames = await flcm.find({ type: "FRAME" }, (n) => Array.isArray(n.fills) && n.fills[0] === "#FFFFFF");
console.log("white frames:", JSON.stringify(whiteFrames.map((h) => h.key)));

return {
  whites: whites.map((h) => h.key),
  faded: faded.map((h) => h.key),
  whiteFrames: whiteFrames.map((h) => h.key),
};

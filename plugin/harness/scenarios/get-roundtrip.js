// get round-trip: render a styled card, then read it back with flcm.get by key — exercising the
// bundled simplify core inside the preamble IIFE (resolve → adapt → simplify, expanded output).
const card = flcm.frame(
  {
    key: "card",
    width: 320,
    fill: "linear-gradient(180deg, #6366f1, #a855f7)",
    layout: { mode: "column", gap: 12, padding: 24 },
  },
  [
    flcm.text("Hello **world**", { key: "title", textStyle: { fontSize: 18 } }),
    flcm.rect({ key: "chip", width: 48, height: 48, fill: "#22c55e", borderRadius: 8 }),
  ],
);
await flcm.render(card);

const read = await flcm.get("card");
console.log(JSON.stringify(read, null, 2));
const spec = read.node;
return { type: spec.type, mode: spec.layout && spec.layout.mode, children: (spec.children || []).length };

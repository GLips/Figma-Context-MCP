import type { Flcm } from "@framelink/plugin/schema";

export async function gridExample(flcm: Flcm) {
  // example:start
  const grid = await flcm.render({
    type: "FRAME",
    name: "Grid cards",
    width: 400,
    layout: {
      mode: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: "12px 16px",
      padding: 16,
    },
    children: [
      // A double-wide banner, then tiles: the row count follows from the placement.
      {
        type: "RECTANGLE",
        width: "fill",
        height: 72,
        fill: "#6366F1",
        layout: { gridColumn: "span 2" },
      },
      { type: "RECTANGLE", width: "fill", height: 56, fill: "#14B8A6" },
      {
        type: "RECTANGLE",
        width: 40,
        height: 40,
        fill: "#F59E0B",
        layout: { justifySelf: "center", alignSelf: "end" },
      },
    ],
  });
  return (await flcm.get(grid)).node;
  // example:end
}

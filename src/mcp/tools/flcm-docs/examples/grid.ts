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
      gridTemplateRows: "80px 80px",
      gap: "12px 16px",
      padding: 16,
    },
    children: [
      { type: "RECTANGLE", width: "fill", height: "fill", fill: "#6366F1" },
      {
        type: "RECTANGLE",
        width: 40,
        height: 40,
        fill: "#F59E0B",
        layout: { justifySelf: "center", alignSelf: "end" },
      },
      {
        type: "RECTANGLE",
        width: "fill",
        height: "fill",
        fill: "#14B8A6",
        layout: { gridColumn: "span 2", gridRow: "2" },
      },
    ],
  });
  return (await flcm.get(grid)).node;
  // example:end
}

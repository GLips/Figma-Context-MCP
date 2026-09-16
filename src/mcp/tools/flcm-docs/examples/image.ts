import type { Flcm, NodeSpec } from "@framelink/plugin/schema";

// The image worked example — real raster fills on ordinary shapes. Authored against the REAL typed surface
// (Flcm), so a change to the image() signature or its opts breaks this file's typecheck rather than
// shipping a stale example. The generator inlines only the marked region below (see examples.ts).
export async function imageExample(flcm: Flcm) {
  // example:start
  // A feed post: a real photo as a frame fill, and a circular avatar as an ellipse filled with an image.
  // flcm.image is a paint value — any shape carries one. The server fetches the bytes; your code doesn't.
  const post: NodeSpec = {
    type: "FRAME",
    layout: { mode: "column", gap: 8 },
    width: 390,
    children: [
      {
        // The photo carries TWO paints — a stack, first entry on top, the order a read returns. The
        // scrim darkens the bottom of the photo so the title over it stays legible at any exposure.
        type: "FRAME",
        width: 390,
        height: 260,
        fill: [
          flcm.gradient({ stops: ["rgba(0,0,0,0)", "rgba(0,0,0,0.65)"], angle: 180 }),
          flcm.image("https://example.com/photo.jpg"),
        ],
        children: [
          {
            type: "TEXT",
            text: "Ridgeline at golden hour",
            textStyle: { fontSize: 20, fontWeight: "semibold" },
            fill: "#FFFFFF",
            left: 16,
            top: 216,
          },
        ],
      },
      {
        type: "FRAME",
        layout: { mode: "row", gap: 8, padding: 12, alignItems: "center" },
        children: [
          {
            type: "ELLIPSE",
            width: 40,
            height: 40,
            fill: flcm.image("https://example.com/avatar.jpg", { scaleMode: "FILL" }),
          },
          { type: "TEXT", text: "@ridgeline", textStyle: { fontWeight: "semibold", fontSize: 14 } },
        ],
      },
    ],
  };

  const out = await flcm.render(post);
  return out.id;
  // example:end
}

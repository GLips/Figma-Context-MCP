import type { Flcm } from "@framelink/plugin/schema";

// The image worked example — real raster fills on ordinary shapes. Authored against the REAL typed surface
// (Flcm), so a change to the image() signature or its opts breaks this file's typecheck rather than
// shipping a stale example. The generator inlines only the marked region below (see examples.ts).
export async function imageExample(flcm: Flcm) {
  // example:start
  // A feed post: a real photo as a rect fill, and a circular avatar as an ellipse filled with an image.
  // flcm.image is a paint value — any shape carries one. The server fetches the bytes; your code doesn't.
  const post = flcm.frame({ layout: { mode: "column", gap: 8 }, width: 390 }, [
    flcm.rect({ width: 390, height: 260, fill: flcm.image("https://example.com/photo.jpg") }),
    flcm.frame({ layout: { mode: "row", gap: 8, padding: 12, alignItems: "center" } }, [
      flcm.ellipse({ width: 40, height: 40, fill: flcm.image("https://example.com/avatar.jpg", { scaleMode: "FILL" }) }),
      flcm.text("@ridgeline", { textStyle: { fontWeight: "semibold", fontSize: 14 } }),
    ]),
  ]);

  const out = await flcm.render(post);
  return out.root.id;
  // example:end
}

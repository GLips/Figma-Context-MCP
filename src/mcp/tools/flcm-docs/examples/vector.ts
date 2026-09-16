import type { Flcm } from "@framelink/plugin/schema";

// The vector worked example — both contracts side by side. Authored against the REAL typed surface (Flcm),
// so a change to the svg/path signatures or the path fields breaks this file's typecheck rather than
// shipping a stale example. The generator inlines only the marked region below (see examples.ts).
export async function vectorExample(flcm: Flcm) {
  // example:start
  // A round "play" button showing both vector forms and how each is sized.
  const player = {
    type: "FRAME",
    width: 96,
    height: 96,
    borderRadius: 48,
    fill: "#111827",
    children: [
      // `d` is bare geometry: this path is 32x36 because those are its own coordinates, and `scale`
      // is what makes it bigger. No width/height — they'd be a canvas the path doesn't have.
      {
        type: "VECTOR",
        key: "play",
        d: "M0 0 L32 18 L0 36 Z",
        fill: "#6366F1",
        scale: 1.5,
        left: 34,
        top: 24,
      },
      // `svg` is a canvas: the viewBox sets the coordinate space, width/height size it, and `fill`
      // repaints every vector inside — so the same markup serves every theme.
      {
        type: "VECTOR",
        svg: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#22C55E"/></svg>',
        fill: "#F9FAFB",
        width: 16,
        height: 16,
        left: 8,
        top: 8,
      },
    ],
  };

  const out = await flcm.render(player);
  return { node: out.id, play: out.children![0].id };
  // example:end
}

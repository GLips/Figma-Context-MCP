import type { Flcm } from "@framelink/plugin/schema";

// The vector worked example — both contracts side by side. Authored against the REAL typed surface (Flcm),
// so a change to the svg/path signatures or the path fields breaks this file's typecheck rather than
// shipping a stale example. The generator inlines only the marked region below (see examples.ts).
export async function vectorExample(flcm: Flcm) {
  // example:start
  // A round "play" button: a themed circle, with a themeable play triangle (VECTOR with d) centered on top,
  // and a brand mark pasted verbatim from SVG markup (VECTOR with svg) in the corner.
  const player = {
    type: "FRAME",
    width: 96,
    height: 96,
    borderRadius: 48,
    fill: "#111827",
    children: [
      // path themes like any primitive — the triangle fills with the accent color
      {
        type: "VECTOR",
        key: "play",
        d: "M38 30 L70 48 L38 66 Z",
        fill: "#6366F1",
        left: 30,
        top: 24,
      },
      // svg pastes opaque markup (its colors are baked in — fill/stroke would be rejected here)
      {
        type: "VECTOR",
        svg: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#22C55E"/></svg>',
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

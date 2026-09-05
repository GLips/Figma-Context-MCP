import type { Flcm } from "@framelink/plugin/schema";

// The vector worked example — both contracts side by side. Authored against the REAL typed surface (Flcm),
// so a change to the svg/path signatures or the path fields breaks this file's typecheck rather than
// shipping a stale example. The generator inlines only the marked region below (see examples.ts).
export async function vectorExample(flcm: Flcm) {
  // example:start
  // A round "play" button: a themed circle, with a themeable play triangle (flcm.path) centered on top,
  // and a brand mark pasted verbatim from SVG markup (flcm.svg) in the corner.
  const player = flcm.frame({ width: 96, height: 96, borderRadius: 48, fill: "#111827" }, [
    // path themes like any primitive — the triangle fills with the accent color
    flcm.path({
      key: "play",
      d: "M38 30 L70 48 L38 66 Z",
      fill: "#6366F1",
      left: 30,
      top: 24,
    }),
    // svg pastes opaque markup (its colors are baked in — fill/stroke would be rejected here)
    flcm.svg('<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#22C55E"/></svg>', {
      width: 16,
      height: 16,
      left: 8,
      top: 8,
    }),
  ]);

  const out = await flcm.render(player);
  return { node: out.node.id, play: out.keyed.play.id };
  // example:end
}

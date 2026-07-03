import type { Flcm } from "@framelink/plugin/schema";

// The feed-caption worked example — the rich-text runs form. Authored against the REAL typed surface
// (Flcm), so a change to the runs signature or the run fields breaks this file's typecheck rather than
// shipping a stale example. The generator inlines only the marked region below (see examples.ts).
export async function captionExample(flcm: Flcm) {
  // example:start
  // One text node, three styles: a colored @handle, plain body copy, a muted "more". The base props
  // (size 15, a line height) apply to every run; each run overrides only what it changes.
  const caption = flcm.text(
    [
      ["@ridgeline", { fontWeight: "semibold", color: "#6366F1" }],
      " summited at golden hour — the whole valley lit up. ",
      ["more", { color: "#8E8E93" }],
    ],
    {
      key: "caption",
      color: "#111827",
      width: 340,
      textStyle: { fontSize: 15, lineHeight: "20px" },
    },
  );

  const out = await flcm.render(caption);
  return { caption: out.keyed.caption.id, text: out.keyed.caption.text };
  // example:end
}

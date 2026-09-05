// Worked examples for the reference. Each is a real .ts file under examples/, compile-checked against
// the typed flcm surface (see examples/login.ts) — a schema change that breaks an example goes red in
// type-check instead of shipping stale docs. The marked region of each file is extracted verbatim into
// examples-code.generated.ts by `pnpm docs:gen`, and `pnpm docs:check` fails on drift, so the shipped
// example is byte-for-byte the code that just type-checked. The generated-module indirection (rather
// than reading the example sources at runtime) exists because the npm product runs from a tsup bundle,
// where source files aren't on disk.

import { EXAMPLE_CODE } from "./examples-code.generated.js";

export interface Example {
  title: string;
  intro: string;
  code: string;
}

type ExampleId = keyof typeof EXAMPLE_CODE;

// Keyed exhaustively by the generated module, so BOTH drift directions fail to compile: a new
// example (file + generator id) with no metadata here is a missing key, and metadata for a deleted
// example is an excess key. Without this tie, a metadata-less example would generate cleanly, pass
// docs:check, and silently never render — the stale-docs failure this apparatus exists to kill.
const EXAMPLE_META: Record<ExampleId, { title: string; intro: string }> = {
  login: {
    title: "The login screen",
    intro:
      "A gradient background, an absolute radial-glow decoration declared first (so it sits behind), a " +
      'frosted card whose shadow and blur are plain CSS strings, fixed and "fill" sizing, rgba/hex solids, ' +
      "numeric font weights, and keyed nodes addressed after render.",
  },
  caption: {
    title: "A feed caption (rich text)",
    intro:
      "One `flcm.text` node carrying three styled runs — a colored `@handle`, plain body copy, and a muted " +
      "`more` — over shared base props, wrapped to a fixed width. Replaces four hand-split text nodes.",
  },
  vector: {
    title: "Vector art (svg & path)",
    intro:
      "Both vector contracts side by side: a themeable `flcm.path` triangle that fills with the accent " +
      "color like any primitive, and an opaque `flcm.svg` mark pasted verbatim (its colors baked into the " +
      "markup). No icon catalog — you bring the path data or markup.",
  },
  image: {
    title: "Images (real raster fills)",
    intro:
      "A feed post with a real photo as a `rect` fill and a circular avatar as an `ellipse` filled with an " +
      "image. `flcm.image(url)` is a paint value, so any shape carries one; the server fetches the bytes.",
  },
  reuse: {
    title: "Copying what's already on the canvas (get → fromRead)",
    intro:
      "The read↔write seam: `flcm.get` reads a live subtree as the canonical shape, you edit that shape " +
      "like any object, and `flcm.fromRead` re-authors it through the constructors so a structural verb " +
      "places a COPY. `flcm.clone` stays the faithful duplicate for subtrees a rebuild can't reproduce.",
  },
};

// Rendered in the generated module's key order, which the generator emits in EXAMPLE_IDS order.
export const EXAMPLES: Example[] = (Object.keys(EXAMPLE_CODE) as ExampleId[]).map((id) => ({
  ...EXAMPLE_META[id],
  code: EXAMPLE_CODE[id],
}));

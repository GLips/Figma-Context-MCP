// Worked examples for the reference. Each is a real .ts file under examples/, compile-checked against
// the typed flcm surface (see examples/login.ts) — a schema change that breaks an example goes red in
// type-check instead of shipping stale docs. The marked region of each file is extracted verbatim into
// examples-code.generated.ts by `pnpm docs:gen`, and `pnpm docs:check` fails on drift, so the shipped
// example is byte-for-byte the code that just type-checked. The generated-module indirection (rather
// than reading the example sources at runtime) exists because the npm product runs from a tsup bundle,
// where source files aren't on disk to read.

import { EXAMPLE_CODE } from "./examples-code.generated.js";

export interface Example {
  title: string;
  intro: string;
  code: string;
}

export const EXAMPLES: Example[] = [
  {
    title: "The login screen",
    intro:
      "A gradient background, an absolute radial-glow decoration declared first (so it sits behind), a " +
      'frosted card with a shadow + background blur, fixed and "fill" sizing, rgba/hex solids, numeric ' +
      "font weights, and keyed nodes addressed after render.",
    code: EXAMPLE_CODE.login,
  },
  {
    title: "A feed caption (rich text)",
    intro:
      "One `flcm.text` node carrying three styled runs — a colored `@handle`, plain body copy, and a muted " +
      "`more` — over shared base props, wrapped to a fixed width. Replaces four hand-split text nodes.",
    code: EXAMPLE_CODE.caption,
  },
  {
    title: "Vector art (svg & path)",
    intro:
      "Both vector contracts side by side: a themeable `flcm.path` triangle that fills with the accent " +
      "color like any primitive, and an opaque `flcm.svg` mark pasted verbatim (its colors baked into the " +
      "markup). No icon catalog — you bring the path data or markup.",
    code: EXAMPLE_CODE.vector,
  },
  {
    title: "Images (real raster fills)",
    intro:
      "A feed post with a real photo as a `rect` fill and a circular avatar as an `ellipse` filled with an " +
      "image. `flcm.image(url)` is a paint value, so any shape carries one; the server fetches the bytes.",
    code: EXAMPLE_CODE.image,
  },
];

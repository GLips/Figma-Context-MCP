/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Worked examples for the reference. Each is a real .ts file under examples/, compile-checked against
// the typed flcm surface (see examples/login.ts) — a schema change that breaks an example goes red in
// type-check instead of shipping stale docs. The marked region of each file is extracted verbatim into
// examples-code.generated.ts by `pnpm docs:gen`, and `pnpm docs:check` fails on drift, so the shipped
// example is byte-for-byte the code that just type-checked. The generated-module indirection (rather
// than reading the example sources at runtime) exists because the npm product runs from a tsup bundle,
// where source files aren't on disk.

import { EXAMPLE_CODE } from "./examples-code.generated.js";

export interface Example {
  /** The task an agent arrives with, which is how it scans the recipe list. */
  title: string;
  intro: string;
  code: string;
}

type ExampleId = keyof typeof EXAMPLE_CODE;

// Keyed exhaustively by the generated module, so BOTH drift directions fail to compile: a new
// example (file + generator id) with no metadata here is a missing key, and metadata for a deleted
// example is an excess key. Without this tie, a metadata-less example would generate cleanly, pass
// docs:check, and silently never render — the stale-docs failure this apparatus exists to kill.
// An example earns a place only by combining areas, or by showing something no reference section
// does; a single-feature snippet belongs beside its prop instead.
const EXAMPLE_META: Record<ExampleId, Omit<Example, "code">> = {
  login: {
    title: "Build a screen from scratch",
    intro:
      "One render builds the whole tree. A node declared first paints behind its siblings, and " +
      "`left`/`top` lift it out of the column, which is how the glow sits behind the title. Return the " +
      "ids you'll use next.",
  },
  grid: {
    title: "Lay out a grid",
    intro:
      "Name the columns and give the frame a width: `fr` tracks divide a fixed width. Leave the rows out " +
      'and they grow to fit the children. A child spans with `gridColumn: "span 2"` and aligns in its ' +
      "cell with `justifySelf`/`alignSelf`.",
  },
  reuse: {
    title: "Move, wrap or copy what's already on the canvas",
    intro:
      "`flcm.get` reads a live subtree as a spec you edit like any object. Its ids name live nodes, so " +
      "placing them moves those nodes, and mapping them selects which ones move. To copy, `clone`.",
  },
  makeComponent: {
    title: "Make a component with variants",
    intro:
      "Build the component as a frame whose layers name the property that drives them, promote each size " +
      "with `flcm.component`, then fold them into a set with `flcm.variants`. Defaults come from the bound " +
      "layers, so only the boolean states its own.",
  },
  components: {
    title: "Use a component from the file",
    intro:
      "Find the component by name and read it first: `get`'s `components` sidecar lists its property " +
      "names, variant options and sublayer paths. Pick a variant by its axes in `componentProperties`, and " +
      "change a sublayer by its path in `overrides`.",
  },
};

// Rendered in the generated module's key order, which the generator emits in EXAMPLE_IDS order.
export const EXAMPLES: Example[] = (Object.keys(EXAMPLE_CODE) as ExampleId[]).map((id) => ({
  ...EXAMPLE_META[id],
  code: EXAMPLE_CODE[id],
}));

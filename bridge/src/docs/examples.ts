import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Worked examples for the reference. Each is a real .ts file compile-checked against the typed flcm
// surface (see examples/login.ts); here we read the file's SOURCE and inline the marked region verbatim,
// so the shipped example is byte-for-byte the code that just type-checked. Read from source at startup
// (the server runs via tsx), mirroring tool-docs.ts.

const START = "// example:start";
const END = "// example:end";

export interface Example {
  title: string;
  intro: string;
  code: string;
}

// Pull the marked region out of an example file and dedent it to column 0. Markers are matched as whole
// lines (trimmed), so a stray mention of the token in prose can't be mistaken for a real marker. Fail
// loud if they're gone: a silently-empty example is exactly the stale-docs failure this exists to kill.
function extractExample(relPath: string): string {
  const path = fileURLToPath(new URL(relPath, import.meta.url));
  const lines = readFileSync(path, "utf8").split("\n");
  const start = lines.findIndex((l) => l.trim() === START);
  const end = lines.findIndex((l) => l.trim() === END);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Cannot inline example: the ${START} / ${END} marker lines are missing or out of order in ${path}.`);
  }
  return dedent(lines.slice(start + 1, end));
}

// Strip the common leading indentation (the region sits inside a function body) and trim blank edges.
function dedent(lines: string[]): string {
  const body = [...lines];
  while (body.length && body[0].trim() === "") body.shift();
  while (body.length && body[body.length - 1].trim() === "") body.pop();
  const indents = body.filter((l) => l.trim().length).map((l) => l.match(/^ */)![0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return body.map((l) => l.slice(min)).join("\n");
}

export const EXAMPLES: Example[] = [
  {
    title: "The login screen",
    intro:
      "A gradient background, an absolute radial-glow decoration declared first (so it sits behind), a " +
      "frosted card with a shadow + background blur, fixed and \"fill\" sizing, rgba/hex solids, numeric " +
      "font weights, and keyed nodes addressed after render.",
    code: extractExample("./examples/login.ts"),
  },
  {
    title: "A feed caption (rich text)",
    intro:
      "One `flcm.text` node carrying three styled runs — a colored `@handle`, plain body copy, and a muted " +
      "`more` — over shared base props, wrapped to a fixed width. Replaces four hand-split text nodes.",
    code: extractExample("./examples/caption.ts"),
  },
  {
    title: "Vector art (svg & path)",
    intro:
      "Both vector contracts side by side: a themeable `flcm.path` triangle that fills with the accent " +
      "color like any primitive, and an opaque `flcm.svg` mark pasted verbatim (its colors baked into the " +
      "markup). No icon catalog — you bring the path data or markup.",
    code: extractExample("./examples/vector.ts"),
  },
  {
    title: "Images (real raster fills)",
    intro:
      "A feed post with a real photo as a `rect` fill and a circular avatar as an `ellipse` filled with an " +
      "image. `flcm.image(url)` is a paint value, so any shape carries one; the server fetches the bytes.",
    code: extractExample("./examples/image.ts"),
  },
];

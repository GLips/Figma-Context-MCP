// Test-only seam, off the barrel on purpose: `walkNodes` + a raw style table is the toolkit for
// assembling a walk that diverges from `simplify`. eslint rejects this subpath outside tests.
// The root's read-path tests need it and can't live here — they drive the REST adapter.

export { walkNodes } from "./simplify.js";
export { createRefStyleTable } from "./style-table.js";
export { createComponentNotes, extractComponents } from "./components.js";
export { STYLE_REF_FIELDS } from "./compress.js";
export type { SimplifiedTextStyle, TextRun } from "./transformers/text.js";

// The test-only seam. Everything here is reachable across the package boundary ONLY so the root
// package's read-path tests can drive the walk directly — those tests build `@figma/rest-api-spec`
// fixtures and pipe them through the REST adapter, so they cannot live in this package without
// inverting the dependency.
//
// Why a separate subpath rather than the barrel: `simplify` is the one transform authority, and
// `walkNodes` + a raw style table is exactly the toolkit needed to assemble a DIVERGENT walk — the
// fork this package exists to prevent. On the barrel, `plugin/src/preamble/read.ts` could do that
// with a legal one-line import. Behind `@framelink/core/internal`, it can't: eslint's
// no-restricted-imports rejects this subpath outside tests (see eslint.config.js).
//
// Nothing here is published. The npm surface is the root package's src/index.ts, which re-exports
// from the barrel only.

export { walkNodes } from "./simplify.js";
export { createRefStyleTable } from "./style-table.js";
export { STYLE_REF_FIELDS } from "./compress.js";
export type { SimplifiedTextStyle, TextRun } from "./transformers/text.js";

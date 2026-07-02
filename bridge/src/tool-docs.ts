import { buildQuickStart } from "./docs/reference.js";

// The execute_code description is the GENERATED quick-start — assembled from the schema (verbs/props),
// the narrative fragments, and the compile-checked examples (see docs/reference.ts). This supersedes the
// earlier marker-splice from docs/authoring/flcm.md: the description no longer copies a hand-written doc
// (which could drift, and once shipped a description of a deleted API) — it is derived from the same
// typed source as the DSL itself, so it cannot describe a verb/prop the code doesn't have.
//
// It is kept ≤2KB by construction (Claude Code truncates tool descriptions at a hard 2KB): critical-first
// — execution model, verb signatures, the must-knows — then a pointer to get_flcm_reference for the rest.
export const EXECUTE_CODE_DESCRIPTION = buildQuickStart();

// Regenerate (or drift-check) the committed human-readable authoring doc, plugin/docs/authoring/flcm.md,
// from the SAME generator that feeds the get_flcm_reference tool. So the doc a human reads in the repo and
// the doc the agent is served are the same bytes — the whole point of this plan: docs that cannot drift
// from the code, because both come from the schema single-source.
//
//   pnpm --filter @framelink/bridge docs:gen     → write the doc
//   pnpm --filter @framelink/bridge docs:check   → fail if the committed doc is stale (wired into validate)
//
// The banner marks the file as generated; everything below it is buildFullReference() verbatim (the same
// content the reference tool serves section by section).

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildFullReference, buildQuickStart, buildReferenceSections } from "../src/docs/reference.js";

const DOC_PATH = fileURLToPath(new URL("../../plugin/docs/authoring/flcm.md", import.meta.url));
// Provenance is a VISIBLE blockquote, not an HTML comment: the repo's hidden-char
// scanner rejects long HTML comments (a prompt-injection vector), and a human
// reading the rendered doc should see the "do not edit" warning anyway.
const BANNER =
  "> **Generated — do not edit.** Regenerate with `pnpm --filter @framelink/bridge docs:gen`.\n" +
  "> Source: `plugin/src/preamble/schema.ts` (verbs/props) + `bridge/src/docs/{narrative,examples}`.\n\n";

// Building the quick-start here (not just the full doc) makes its ≤2KB cap a validate-time gate: the call
// throws if the execute_code description ever overflows, so `docs:check` fails rather than the server
// silently shipping a truncated contract.
buildQuickStart();

// Same idea for the get_flcm_reference size cap: render the ["all"] payload so an over-cap reference fails
// validate here, not at runtime as a silently-truncated tool result in an agent's context.
buildReferenceSections(["all"]);

const expected = BANNER + buildFullReference();
const mode = process.argv[2];

if (mode === "check") {
  const actual = readFileSync(DOC_PATH, "utf8");
  if (actual !== expected) {
    console.error(
      `docs/authoring/flcm.md is stale — it no longer matches the generated reference.\n` +
        `Run \`pnpm --filter @framelink/bridge docs:gen\` and commit the result.`,
    );
    process.exit(1);
  }
  console.log("flcm.md is in sync with the schema.");
} else {
  writeFileSync(DOC_PATH, expected);
  console.log(`Wrote ${DOC_PATH}`);
}

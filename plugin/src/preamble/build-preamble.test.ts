// The preamble's build-time invariants, stated where they belong: on the generator.
//
// These used to be greps over the plugin's output bundle. That couldn't survive ADR-0010 — the
// preamble now ships from the SERVER build, whose bundle legitimately contains zod, so no grep of a
// consumer's output could tell a leak from a legitimate dependency. Asserting on the input GRAPH at
// the one seam that produces the string is both stricter and consumer-independent.
import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error — plain .mjs generator with no declarations.
import { buildSandboxPreamble } from "./index.mjs";

test("the sandbox preamble bundles, and carries no zod into QuickJS", async () => {
  // The zod assertion IS the call: buildSandboxPreamble throws — naming the offending input and the
  // type-only-import fix — when a runtime value import from schema.ts drags zod in. Bundling at all
  // is the other half: the server build depends on this succeeding, so a broken preamble graph (a
  // bad ~/ alias, an unresolvable import) surfaces here rather than at release.
  const { preamble, watchFiles } = await buildSandboxPreamble();

  assert.match(preamble, /flcm std-lib/, "the delimited std-lib string, not a bare bundle");
  assert.ok(preamble.length > 50_000, "a plausible bundle, not an empty or truncated one");

  // watchFiles is load-bearing, not incidental: it is the ONLY thing that makes `tsup --watch`
  // rebuild the shipped preamble when a verb changes. Nothing in the server's own entry graph
  // reaches these files, so an empty list means a DSL edit silently ships stale in development.
  assert.ok(watchFiles.length > 10, "the preamble's input graph, for the server build's watcher");
  assert.ok(
    watchFiles.some((f: string) => f.endsWith("runtime.ts")),
    "the watch list covers the preamble entry point",
  );
});

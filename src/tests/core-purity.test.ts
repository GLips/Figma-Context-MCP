import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Phase 2 Done-when gate (Invariant 4): the core must be bundle-pure. It ships
// into the plugin's QuickJS sandbox as part of an esbuild IIFE, so nothing
// reachable from the core barrel may touch a Node builtin — `platform:
// 'neutral'` makes esbuild fail resolution on any `node:*`/`fs`/`path` import
// instead of silently treating it as external.
//
// This complements the Figma-free gate (core-figma-free.test.ts): that one
// walks the import graph for one forbidden package; this one actually bundles,
// so it catches builtins pulled in transitively from any depth.

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("canonicalize core is bundle-pure (Invariant 4)", () => {
  it("bundles under platform:'neutral' entirely from src/ — no builtins, no packages", async () => {
    // Throws (failing the test) if any Node builtin is reachable, since
    // neutral has no builtin resolution.
    const result = await build({
      entryPoints: [resolve(SRC, "core/index.ts")],
      bundle: true,
      write: false,
      metafile: true,
      platform: "neutral",
      format: "esm",
      logLevel: "silent",
      alias: { "~": SRC },
    });

    // Builtins fail the build above; external PACKAGES would bundle happily
    // (e.g. zod would pass `neutral` resolution). The plugin's QuickJS bundle
    // budget treats any dependency creep as a regression, so pin the stronger
    // property: every module in the core bundle comes from this repo's src/.
    const inputs = Object.keys(result.metafile.inputs);
    const outsideSrc = inputs.filter((input) => relative(SRC, resolve(input)).startsWith(".."));
    expect(outsideSrc).toEqual([]);
  });
});

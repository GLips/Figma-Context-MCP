// SANDBOX_PREAMBLE generator — the sole seam both consumers go through. code.ts (via build.mjs) and
// harness/dogfood.mjs each call buildSandboxPreamble(); neither learns the fragment layout or order.
//
// The preamble is the std-lib source string injected ahead of the agent's code inside the one async
// IIFE that wraps every execute_code call (see executeCode in code.ts). It defines a single `flcm`
// global; the agent calls flcm.frame()/flcm.render()/etc.
//
// The fragments are authored as real typed ES modules (so tsc checks the shipped JS), but QuickJS has
// no module system — so esbuild bundles runtime.ts as an IIFE with globalName 'flcm'. That wraps the
// whole module graph in one closure: only the verbs runtime.ts re-exports land on the `flcm` global,
// and every internal helper is closure-private — uncollidable with the agent's code in the shared eval
// scope, which is why no helper needs a name prefix.
//
// Why a generator and not a plain string export: bundling requires running esbuild, which can't happen
// inside the Figma sandbox — so the string is produced at build time (build.mjs bakes it into code.ts
// via `define`) and fresh each dogfood run, both by calling this one function.
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export async function buildSandboxPreamble() {
  // format:'iife' + globalName:'flcm' is what gives us the single-global / closure-private-internals
  // shape. target:'esnext' keeps output lean; there is no top-level await to preserve (the inert-spec
  // model loads fonts inside render(), not at module top level), so any modern target works.
  const bundled = await esbuild.build({
    entryPoints: [resolve(here, "runtime.ts")],
    bundle: true, write: false, format: "iife", globalName: "flcm", target: "esnext", platform: "neutral",
    // The read path bundles the repo-root simplify core, whose internal imports use the root's ~/ alias.
    alias: { "~": resolve(here, "../../../src") },
  });
  const code = bundled.outputFiles[0].text;

  return [
    "// ===== flcm std-lib (injected) =====",
    code,
    "// ===== end std-lib =====",
  ].join("\n");
}

// SANDBOX_PREAMBLE generator — the sole seam every consumer goes through. The SERVER build
// (tsup.config.ts, which injects the result into the shipped bundle) and harness/dogfood.mjs each
// call buildSandboxPreamble(); neither learns the fragment layout or order. The plugin no longer
// calls it at all — ADR-0010 moved the runtime onto the server so DSL changes skip the re-import.
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
// inside the Figma sandbox — so the string is produced at the server's build time and fresh each
// dogfood run, both by calling this one function. It returns the input graph alongside the string so
// a watching build can rebuild when a fragment changes.
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
    // Powers the zod gate below and the watch list callers need — both want the real input graph,
    // not a guess at it.
    metafile: true,
  });
  const code = bundled.outputFiles[0].text;
  const inputs = Object.keys(bundled.metafile.inputs);

  // Load-bearing invariant, enforced (not just documented): zod must NEVER reach the QuickJS sandbox.
  // The preamble imports schema-derived things as `import type` only, so esbuild erases them — but a
  // future *value* import from schema.ts is valid TS that silently bundles zod.
  //
  // Asserted on the input GRAPH, not by greping the output for the string "zod": the output check
  // false-positives on the word appearing in a comment or an error message, and false-negatives if
  // zod's emitted code never names itself. The graph is the actual question — did this module ever
  // get pulled in.
  //
  // And asserted HERE, at the one seam that produces the preamble, rather than on a consumer's
  // bundle: the SERVER build ships this preamble too, and the server bundle legitimately contains
  // zod, so a grep of that output could never tell the two apart. Every consumer inherits this.
  const zodInputs = inputs.filter((f) => /(^|\/)node_modules\/(\.pnpm\/)?[^/]*zod/.test(f));
  if (zodInputs.length) {
    // A leak drags in zod's whole graph (~80 modules), so name a few and count the rest — the fix is
    // the same whichever one you look at, and an 80-path error is unreadable.
    const shown = zodInputs.slice(0, 3).join(", ");
    const rest = zodInputs.length > 3 ? ` (+${zodInputs.length - 3} more)` : "";
    throw new Error(
      "zod leaked into the sandbox preamble via " + shown + rest + ". The preamble must import " +
        "schema.ts things as `import type` ONLY — a runtime value import from schema.ts pulls zod into " +
        "QuickJS. Find it and make it type-only.",
    );
  }

  return {
    preamble: [
      "// ===== flcm std-lib (injected) =====",
      code,
      "// ===== end std-lib =====",
    ].join("\n"),
    // Every file the preamble is built FROM. The server build watches these so that editing a verb
    // rebuilds the string it injects — without this, `tsup --watch` serves a preamble frozen at
    // config-load time and a DSL edit shows no effect in Figma, silently.
    watchFiles: inputs.map((f) => resolve(process.cwd(), f)),
  };
}

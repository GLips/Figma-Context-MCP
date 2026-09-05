// The flcm std-lib generator — the sole seam every consumer goes through. The SERVER build
// (tsup.config.ts, which injects the result into the shipped bundle) and harness/dogfood.mjs each
// call buildSandboxPreamble(); neither learns the fragment layout or order. The plugin no longer
// calls it at all — ADR-0010 moved the runtime onto the server so DSL changes skip the re-import.
//
// What it emits is a FACTORY EXPRESSION, not a paste-in blob: `eval(preamble)(host)` takes the
// FlcmHost and returns the `flcm` surface the agent calls (flcm.frame()/flcm.render()/…). That shape
// is what keeps `__flcmHost` — the one identifier no compiler can follow across eval — entirely
// inside this directory. This file writes the wrapper that BINDS it and asserts the bundle READS it
// (see below); the consumers only ever call the factory positionally, so none of them can drift.
//
// The fragments are authored as real typed ES modules (so tsc checks the shipped JS), but QuickJS has
// no module system — so esbuild bundles runtime.ts as an IIFE with globalName 'flcm'. That wraps the
// whole module graph in one closure: only the verbs runtime.ts re-exports land on the `flcm` global,
// and every internal helper is closure-private — uncollidable with the agent's code, which is why no
// helper needs a name prefix.
//
// Why a generator and not a plain string export: bundling requires running esbuild, which can't happen
// inside the Figma sandbox — so the string is produced at the server's build time and fresh each
// dogfood run, both by calling this one function.
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
    // Powers the zod gate below: it asks the real input graph rather than guessing from the output.
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

  // The other load-bearing invariant, and the reason the wrapper below is written HERE rather than
  // in code.ts: `__flcmHost` is the single identifier that crosses an eval boundary, so no bundler
  // or type checker connects the binding to the read. Emitting both ends from one file reduces that
  // to a check this generator can make itself — the bundle it just produced must actually reference
  // the name the wrapper is about to bind. Rename it in host.ts alone and this throws; rename it in
  // both and nothing outside this directory needs to know.
  if (!code.includes("__flcmHost")) {
    throw new Error(
      "the flcm std-lib bundle never references `__flcmHost` — src/preamble/host.ts must read that " +
        "exact free identifier, since it is the name the factory wrapper binds. Image fills and run " +
        "cancellation would detach silently in live Figma.",
    );
  }

  // Wrapped as a callable expression: `eval(preamble)(host)` → the `flcm` surface. `flcm` is the var
  // esbuild's globalName emits, declared inside this function rather than in whatever scope the
  // consumer eval'd from — so the std-lib's single global never leaks into the agent's scope by
  // accident; the caller hands it to the agent's code deliberately.
  return [
    "// ===== flcm std-lib (injected) =====",
    "(function (__flcmHost) {",
    code,
    "return flcm;",
    "})",
    "// ===== end std-lib =====",
  ].join("\n");
}

/**
 * The preamble as a drop-in replacement for src/services/plugin-bridge/sandbox-preamble.ts, whose
 * on-disk body is a fail-loud placeholder. Both bundlers that inject it — tsup for the shipped
 * server, vite for the test run — go through here so the generated module's SHAPE lives in one
 * place; each config only knows its own hook API.
 */
export async function buildSandboxPreambleModule() {
  const preamble = await buildSandboxPreamble();
  return `export function flcmSandboxPreamble() { return ${JSON.stringify(preamble)}; }`;
}

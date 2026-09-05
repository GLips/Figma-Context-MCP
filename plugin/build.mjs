import * as esbuild from "esbuild";

// Figma's plugin sandbox loads a single classic script as `main`. Bundle code.ts into an IIFE so it
// runs there directly. Neither the agent's code NOR the flcm std-lib is bundled here — both travel
// from the server as raw strings and are eval'd at runtime (ADR-0010), which is what keeps a DSL
// change off the manual-re-import path. Only the host shell is built.
await esbuild.build({
  entryPoints: ["src/code.ts"],
  bundle: true,
  outfile: "dist/code.js",
  platform: "browser",
  format: "iife",
  target: "es2017",
  logLevel: "info",
});

// Negative space, both deliberate: this build asserts nothing about the bundle afterwards.
//
// No zod check — the preamble isn't in here anymore, so grepping this output for it would be
// vacuous. It moved to the seam that PRODUCES the preamble (src/preamble/index.mjs).
//
// No `__flcmHost` check either. code.ts calls the std-lib factory positionally and never names that
// identifier; the wrapper that binds it and the bundle that reads it are both emitted by
// index.mjs, which asserts they agree. A grep here could only re-check one end of a seam whose ends
// no longer live apart.

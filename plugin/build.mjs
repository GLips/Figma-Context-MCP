import * as esbuild from "esbuild";
import { readFileSync } from "node:fs";

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

// The one unpinnable seam in the host↔preamble interface. The host passes its FlcmHost capability
// object as a parameter of a function that exists only inside an eval'd STRING, and the preamble
// picks it up as the free identifier `__flcmHost` — so no bundler or type checker connects the two
// sides, and a rename would detach image fills and cancellation enforcement with no symptom until
// live Figma. Grep the shipped bundle so that drift fails the build instead.
//
// Only the NAME needs this. The object's methods are pinned by types: both halves import FlcmHost
// (src/preamble/host.ts), so renaming or reshaping one is a tsc error on both sides. That is the
// whole reason the interface was collapsed from two loose identifiers into one named object.
//
// Negative space: there is deliberately no zod check here anymore. It moved to the seam that
// PRODUCES the preamble (buildSandboxPreamble, src/preamble/index.mjs) — asserting it on this
// bundle would be vacuous now that the preamble isn't in it.
const bundle = readFileSync("dist/code.js", "utf8");
if (!bundle.includes("async function(__flcmHost)")) {
  throw new Error(
    "dist/code.js lost the `async function(__flcmHost)` eval wrapper — the preamble's host channel " +
      "(images, run cancellation) would silently detach. Check executeCode in src/code.ts against the " +
      "`__flcmHost` declare in src/preamble/host.ts.",
  );
}

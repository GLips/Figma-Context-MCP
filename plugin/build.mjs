import * as esbuild from "esbuild";
import { readFileSync } from "node:fs";
import { buildSandboxPreamble } from "./src/preamble/index.mjs";

// Generate the std-lib string through the one seam and bake it into the bundle via `define`. code.ts
// can't generate it in-sandbox (flattening runs esbuild), so the value is a build-time constant here.
// This is why code.ts declares SANDBOX_PREAMBLE rather than importing it.
const SANDBOX_PREAMBLE = await buildSandboxPreamble();

// Figma's plugin sandbox loads a single classic script as `main`. Bundle code.ts
// into an IIFE so it runs there directly. The agent's code is NEVER bundled — it
// travels as a raw string and is eval'd at runtime; only the plugin shell is built.
await esbuild.build({
  entryPoints: ["src/code.ts"],
  bundle: true,
  outfile: "dist/code.js",
  platform: "browser",
  format: "iife",
  target: "es2017",
  define: { SANDBOX_PREAMBLE: JSON.stringify(SANDBOX_PREAMBLE) },
  logLevel: "info",
});

// Load-bearing invariant, enforced (not just documented): zod must NEVER reach the QuickJS sandbox. The
// preamble imports schema-derived things as `import type` only, so esbuild erases them — but a future
// *value* import from schema.ts is valid TS that silently bundles zod. Grep the output and fail the build
// if it slips in, turning the acceptance criterion into a gate rather than a manual check.
const bundle = readFileSync("dist/code.js", "utf8");
if (bundle.includes("zod")) {
  throw new Error(
    "zod leaked into the sandbox bundle (dist/code.js). The preamble must import schema.ts things as " +
      "`import type` ONLY — a runtime value import from schema.ts pulls zod into QuickJS. Find it and make it type-only.",
  );
}

// The mid-run image channel and the run-cancellation flag ride on the eval'd wrapper's PARAMETER
// names matching the free identifiers the preamble references (`__flcmRequestImages` in
// preamble/flcm.ts, `__flcmRunCancelled` in preamble/mutation-lock.ts). All of it lives inside
// string/eval'd code, so no bundler or type checker connects the two sides — a rename on either
// side breaks image fills or cancellation enforcement only at runtime, inside live Figma. Grep the
// shipped bundle for the wrapper head so that drift fails the build instead.
if (!bundle.includes("async function(__flcmRequestImages, __flcmRunCancelled)")) {
  throw new Error(
    "dist/code.js lost the `async function(__flcmRequestImages, __flcmRunCancelled)` eval wrapper — " +
      "the preamble's image channel or cancellation flag would silently detach. Check executeCode in " +
      "src/code.ts and the declares in preamble/flcm.ts and preamble/mutation-lock.ts.",
  );
}
// The wrapper-head grep above only pins the HOST side of the cancellation pairing. The preamble
// side (mutation-lock.ts's runCancelled) reads the same identifier through a permissive typeof
// guard — it must fail open so the harness and unit tests run without a host — which means a
// rename there would detach cancellation enforcement with no runtime symptom at all. Require a
// second occurrence beyond the wrapper head so both halves must name the same identifier.
if (bundle.split("__flcmRunCancelled").length - 1 < 2) {
  throw new Error(
    "dist/code.js references `__flcmRunCancelled` only in the eval wrapper head — the preamble side " +
      "(preamble/mutation-lock.ts runCancelled) no longer reads it, so cancellation enforcement is detached.",
  );
}

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
if (readFileSync("dist/code.js", "utf8").includes("zod")) {
  throw new Error(
    "zod leaked into the sandbox bundle (dist/code.js). The preamble must import schema.ts things as " +
      "`import type` ONLY — a runtime value import from schema.ts pulls zod into QuickJS. Find it and make it type-only.",
  );
}

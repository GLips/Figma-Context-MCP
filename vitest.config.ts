import { defineConfig } from "vitest/config";
import path from "path";
// @ts-expect-error — plain .mjs generator with no declarations.
import { buildSandboxPreambleModule } from "./plugin/src/preamble/index.mjs";

const SANDBOX_PREAMBLE_MODULE = path.resolve(
  __dirname,
  "src/services/plugin-bridge/sandbox-preamble.ts",
);

export default defineConfig({
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "src"),
    },
  },
  plugins: [
    // Mirrors the tsup build's injection (see tsup.config.ts) so tests reach the REAL preamble
    // rather than the on-disk fail-loud placeholder. That matters for the test asserting
    // figma_execute_code actually attaches the std-lib to its outgoing request: against a stub it
    // would pass while shipping nothing. Also means a zod leak fails the test run, since
    // the generator throws on one.
    {
      name: "flcm-preamble",
      async load(id: string) {
        if (id !== SANDBOX_PREAMBLE_MODULE) return null;
        return await buildSandboxPreambleModule();
      },
    },
  ],
  test: {
    globals: true,
    testTimeout: 30_000,
    // Scope to figma-mcp's own suite. The plugin ships node:test files — a
    // different runner vitest can't parse — driven by the `test:plugin`
    // script. Without this bound, vitest globs them and fails with "No test
    // suite found".
    include: ["src/**/*.test.ts"],
  },
});

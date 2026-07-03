import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "src"),
    },
  },
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

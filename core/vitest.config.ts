import { defineConfig } from "vitest/config";

// Needed because vitest walks UP for a config and would otherwise find the root one, whose
// include (`src/**/*.test.ts`) matches nothing here.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});

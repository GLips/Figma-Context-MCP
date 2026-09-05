import { defineConfig } from "vitest/config";

// This package needs its own config, not the repo root's: vitest walks UP the directory tree for
// a config file, so without this it finds the root one and runs with `include: ["src/**/*.test.ts"]`
// — which matches nothing here, because this package keeps its tests in tests/ beside src/.
//
// No `~` alias on purpose. This package has no path alias; every intra-package import is relative,
// which is what lets it be consumed across a package boundary at all.
// No `globals: true` either: every test here imports describe/it/expect from "vitest" explicitly,
// and tsconfig.json's `types` deliberately omits vitest/globals, so the flag would be a lie.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});

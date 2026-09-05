import { defineConfig } from "tsup";

const isDev = process.env.npm_lifecycle_event === "dev";
const packageVersion = process.env.npm_package_version;

export default defineConfig({
  clean: true,
  entry: ["src/index.ts", "src/bin.ts", "src/mcp-server.ts"],
  // @framelink/core and @framelink/plugin are private, unpublished workspace members: the shared
  // read transform and the flcm write-surface SSOT must both be BUNDLED into dist, never left as
  // runtime imports the npm package can't resolve. The plugin's zod import stays external and
  // resolves to the root zod (v4).
  noExternal: ["@framelink/core", "@framelink/plugin"],
  format: ["esm"],
  minify: !isDev,
  target: "esnext",
  outDir: "dist",
  outExtension: ({ format: _format }) => ({
    js: ".js",
  }),
  onSuccess: isDev ? "node dist/bin.js" : undefined,
  define: {
    "process.env.NPM_PACKAGE_VERSION": JSON.stringify(packageVersion),
  },
});

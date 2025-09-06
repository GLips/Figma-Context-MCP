import { defineConfig } from "tsup";

const isDev = process.env.npm_lifecycle_event === "dev";
const packageVersion = process.env.npm_package_version;

export default defineConfig({
  clean: true,
  entry: ["src/index.ts"],
  format: ["esm"],
  minify: !isDev,
  target: "esnext",
  outDir: "dist",
  outExtension: () => ({
    js: ".js",
  }),
  define: {
    "process.env.NPM_PACKAGE_VERSION": JSON.stringify(packageVersion),
  },
});

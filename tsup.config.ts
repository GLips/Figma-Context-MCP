import { defineConfig } from "tsup";
import type { Plugin } from "esbuild";
// @ts-expect-error — plain .mjs generator with no declarations; this config is outside tsconfig's `include`.
import { buildSandboxPreambleModule } from "./plugin/src/preamble/index.mjs";

const isDev = (process.env.npm_lifecycle_event ?? "").startsWith("dev");
const packageVersion = process.env.npm_package_version;

export default defineConfig({
  clean: true,
  entry: ["src/index.ts", "src/bin.ts", "src/mcp-server.ts"],
  // @framelink/plugin is a private, unpublished workspace member: its schema module (the flcm
  // write-surface SSOT) must be BUNDLED into dist, never left as a runtime import the npm
  // package can't resolve. Its own zod import stays external and resolves to the root zod (v4).
  noExternal: ["@framelink/plugin"],
  format: ["esm"],
  minify: !isDev,
  target: "esnext",
  outDir: "dist",
  outExtension: ({ format: _format }) => ({
    js: ".js",
  }),
  onSuccess: isDev ? "node dist/bin.js" : undefined,
  // Watching is configured HERE, and the dev scripts deliberately do NOT pass `--watch`. The CLI
  // flag sets `watch: true`, and on that exact value tsup (8.5.1) discards any changed file missing
  // from the outer bundle's metafile inputs — nothing in the server's entry graph reaches
  // plugin/src/preamble, so every DSL edit would wake the watcher and be thrown away. A path LIST
  // skips that filter, which is what makes `pnpm dev` actually pick up a new verb. Left undefined
  // outside dev, since any truthy value turns `pnpm build` into a watch build.
  watch: isDev ? ["src/**/*", "plugin/src/**/*"] : undefined,
  define: {
    "process.env.NPM_PACKAGE_VERSION": JSON.stringify(packageVersion),
  },
  esbuildPlugins: [
    {
      // ADR-0010: the plugin is a dumb host — the flcm std-lib ships from the SERVER with every
      // EXECUTE_CODE, so a DSL change reaches a running plugin on a server update alone, with no
      // manual manifest re-import. Generate it here and swap it into sandbox-preamble.ts, whose
      // on-disk body is a fail-loud placeholder.
      //
      // An onLoad hook rather than a `define` constant: `define` is captured once when this config
      // is evaluated, and tsup loads the config a single time — so under watch a preamble edit
      // would keep shipping the string as it was at startup, silently, the DSL change simply not
      // appearing in Figma. This hook re-runs the generator on every rebuild.
      //
      // What TRIGGERS that rebuild is the explicit `watch` list above. Not esbuild's own watchFiles
      // signal — tsup drives its own chokidar and never reads it, which is why this hook doesn't
      // bother returning one.
      name: "flcm-preamble",
      setup(build) {
        build.onLoad(
          { filter: /[/\\]services[/\\]plugin-bridge[/\\]sandbox-preamble\.ts$/ },
          async () => ({ contents: await buildSandboxPreambleModule(), loader: "ts" }),
        );
      },
    } satisfies Plugin,
  ],
});

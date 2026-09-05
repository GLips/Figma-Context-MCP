import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Every subpath in @framelink/plugin's exports map must also be mapped in the root
// tsconfig's `paths`. The mapping is what keeps TypeScript resolving the plugin inside
// the workspace instead of through its node_modules symlink — and TypeScript refuses to
// emit declarations for any file it first reached while resolving through node_modules
// (`program.isSourceFileFromExternalLibrary`). The plugin's preamble imports back into
// ~/core/index.js, so an unmapped subpath silently marks the read core unemittable:
// `tsup --dts` gets nothing back for it, falls through to the raw .ts, and rollup's
// JS-only parser dies with `Error parsing: src/core/index.ts:2:7`.
//
// That error names a blameless file and never mentions @framelink/plugin, which is why
// this gate exists rather than leaving it to the build: adding a third plugin export and
// forgetting the mapping should fail here, by name, not as a parse error in the core.
//
// Directional on purpose: extra `paths` entries beyond the exports map are not a failure
// here — the exports map is the boundary, and widening tsconfig past it is caught by the
// package-boundary check, not by this one.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const PLUGIN_PACKAGE = "@framelink/plugin";

function readJsonc(path: string): Record<string, unknown> {
  const { config, error } = ts.readConfigFile(path, (file) => readFileSync(file, "utf8"));
  if (error) {
    throw new Error(ts.flattenDiagnosticMessageText(error.messageText, " "));
  }
  return config as Record<string, unknown>;
}

describe("root tsconfig paths mirror the plugin's exports map", () => {
  it("maps every @framelink/plugin export subpath into the workspace", () => {
    const pluginPkg = readJsonc(resolve(REPO_ROOT, "plugin/package.json"));
    const exportsMap = pluginPkg.exports as Record<string, string>;

    // "./schema" -> "@framelink/plugin/schema", the specifier source actually writes.
    // A bare "." root export has no subpath to map, so it isn't part of this contract.
    const specifiers = Object.keys(exportsMap)
      .filter((subpath) => subpath !== ".")
      .map((subpath) => `${PLUGIN_PACKAGE}/${subpath.replace(/^\.\//, "")}`);
    expect(specifiers.length).toBeGreaterThan(0);

    const tsconfig = readJsonc(resolve(REPO_ROOT, "tsconfig.json"));
    const paths = (tsconfig.compilerOptions as { paths: Record<string, string[]> }).paths;

    expect(Object.keys(paths)).toEqual(expect.arrayContaining(specifiers));
  });

  it("points each mapping at the file the exports map serves", () => {
    const pluginPkg = readJsonc(resolve(REPO_ROOT, "plugin/package.json"));
    const exportsMap = pluginPkg.exports as Record<string, string>;
    const tsconfig = readJsonc(resolve(REPO_ROOT, "tsconfig.json"));
    const paths = (tsconfig.compilerOptions as { paths: Record<string, string[]> }).paths;

    for (const [subpath, target] of Object.entries(exportsMap)) {
      if (subpath === ".") continue;
      const specifier = `${PLUGIN_PACKAGE}/${subpath.replace(/^\.\//, "")}`;
      const mapped = paths[specifier];
      // A mapping that survives a file move but points nowhere resolves back through
      // node_modules, which is the same silent failure with none of the noise.
      expect(mapped, `no tsconfig paths entry for ${specifier}`).toBeDefined();
      expect(mapped.map((entry) => resolve(REPO_ROOT, entry))).toEqual([
        resolve(REPO_ROOT, "plugin", target),
      ]);
    }
  });
});

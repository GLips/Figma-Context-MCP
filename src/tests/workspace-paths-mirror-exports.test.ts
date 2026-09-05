import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Every subpath in a bundled workspace member's exports map must also be mapped in the root
// tsconfig's `paths`. The mapping is what keeps TypeScript resolving these packages inside the
// workspace instead of through their node_modules symlinks — and TypeScript refuses to emit
// declarations for any file it first reached while resolving through node_modules
// (`program.isSourceFileFromExternalLibrary`). An unmapped subpath silently marks everything
// reached through it unemittable: `tsup --dts` gets nothing back, falls through to the raw .ts,
// and rollup's JS-only parser dies on the first `export type`.
//
// That failure names whatever file the parser happened to reach first, never the package whose
// mapping is missing, which is why this gate exists rather than leaving it to the build: adding
// an export subpath and forgetting the mapping should fail here, by name.
//
// Directional on purpose: extra `paths` entries beyond the exports map are not a failure
// here — the exports map is the boundary, and widening tsconfig past it is caught by the
// package-boundary check, not by this one.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// The bundled workspace members: private, never published, inlined into dist by tsup's
// `noExternal`. Anything added to that list belongs here too.
const BUNDLED_MEMBERS = [
  { name: "@framelink/core", dir: "core" },
  { name: "@framelink/plugin", dir: "plugin" },
];

function readJsonc(path: string): Record<string, unknown> {
  const { config, error } = ts.readConfigFile(path, (file) => readFileSync(file, "utf8"));
  if (error) {
    throw new Error(ts.flattenDiagnosticMessageText(error.messageText, " "));
  }
  return config as Record<string, unknown>;
}

/** "./schema" -> "@framelink/plugin/schema"; "." -> "@framelink/core". */
function specifierFor(pkg: string, subpath: string): string {
  return subpath === "." ? pkg : `${pkg}/${subpath.replace(/^\.\//, "")}`;
}

function rootPaths(): Record<string, string[]> {
  const tsconfig = readJsonc(resolve(REPO_ROOT, "tsconfig.json"));
  return (tsconfig.compilerOptions as { paths: Record<string, string[]> }).paths;
}

describe.each(BUNDLED_MEMBERS)("root tsconfig paths mirror $name", ({ name, dir }) => {
  const exportsMap = readJsonc(resolve(REPO_ROOT, dir, "package.json")).exports as Record<
    string,
    string
  >;

  it("maps every export entry into the workspace", () => {
    const specifiers = Object.keys(exportsMap).map((subpath) => specifierFor(name, subpath));
    expect(specifiers.length).toBeGreaterThan(0);
    expect(Object.keys(rootPaths())).toEqual(expect.arrayContaining(specifiers));
  });

  it("points each mapping at the file the exports map serves", () => {
    const paths = rootPaths();
    for (const [subpath, target] of Object.entries(exportsMap)) {
      const specifier = specifierFor(name, subpath);
      const mapped = paths[specifier];
      // A mapping that survives a file move but points nowhere resolves back through
      // node_modules, which is the same silent failure with none of the noise.
      expect(mapped, `no tsconfig paths entry for ${specifier}`).toBeDefined();
      expect(mapped.map((entry) => resolve(REPO_ROOT, entry))).toEqual([
        resolve(REPO_ROOT, dir, target),
      ]);
    }
  });
});

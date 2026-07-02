import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Phase 1 Done-when gate (Invariant 2): the `canonicalize` core module graph —
// everything reachable from the pure transform's entry points — must NOT import
// `@figma/rest-api-spec`. Every REST wire structure is decoded in the adapter
// (restNodeToSnapshot + rest-*.ts) so the core only ever sees `NodeSnapshot`.
// One REST type leaking into the core forks the transform for the future plugin
// producer, which is the exact failure this carve exists to prevent.
//
// This walks the import graph rather than grepping a hand-maintained file list,
// so a new core module that pulls in a Figma type fails here automatically —
// the gate can't rot as the core grows.

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The pure transform's entry surface. `restNodeToSnapshot` and everything above
// it (design-extractor, services) are the ADAPTER — deliberately not roots.
const CORE_ROOTS = [
  "extractors/node-walker.ts",
  "extractors/built-in.ts",
  "extractors/finalize.ts",
];

const FORBIDDEN = "@figma/rest-api-spec";

/** Extract every module specifier from `import`/`export ... from "..."` statements. */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const re = /(?:import|export)[\s\S]*?from\s*["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

/** Resolve a local (`~/` or relative) `.js` specifier to its `.ts` source path; null for externals. */
function resolveLocal(specifier: string, fromFile: string): string | null {
  let path: string;
  if (specifier.startsWith("~/")) {
    path = resolve(SRC, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    path = resolve(dirname(fromFile), specifier);
  } else {
    return null; // bare specifier — external package
  }
  return path.replace(/\.js$/, ".ts");
}

/** Files reachable from the core roots by following local imports. */
function coreModuleGraph(): string[] {
  const seen = new Set<string>();
  const queue = CORE_ROOTS.map((r) => resolve(SRC, r));
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf-8");
    for (const spec of importSpecifiers(source)) {
      const local = resolveLocal(spec, file);
      if (local && !seen.has(local)) queue.push(local);
    }
  }
  return Array.from(seen);
}

describe("canonicalize core is Figma-free (Invariant 2)", () => {
  it("no module reachable from the core roots imports @figma/rest-api-spec", () => {
    const offenders = coreModuleGraph().filter((file) => {
      const source = readFileSync(file, "utf-8");
      return importSpecifiers(source).includes(FORBIDDEN);
    });

    expect(offenders.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });
});

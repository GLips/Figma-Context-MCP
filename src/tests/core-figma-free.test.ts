import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Phase 1 Done-when gate (Invariant 2): the `canonicalize` core module graph —
// everything reachable from the pure transform's entry points — must NOT import
// `@figma/rest-api-spec`. Every REST wire structure is decoded in the adapter
// (src/adapters/rest/) so the core only ever sees `NodeSnapshot`.
// One REST type leaking into the core forks the transform for the future plugin
// producer, which is the exact failure this carve exists to prevent.
//
// This walks the import graph rather than grepping a hand-maintained file list,
// so a new core module that pulls in a Figma type fails here automatically —
// the gate can't rot as the core grows.
//
// Scope: this enforces import-cleanliness (no core module *names* a REST type),
// not value-cleanliness. `restNodeToSnapshot` builds the snapshot by spreading
// the raw node, so undeclared REST fields still ride through at runtime; the
// contract that the core only *reads* declared `NodeSnapshot` fields is upheld
// by the types, not by this test. Tightening that (explicit construction or a
// runtime shape assertion) is deferred — the spread passthrough is the
// deliberate incremental-carve mechanism, not an oversight.

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The pure transform's entry surface: the core barrel, which re-exports the
// walker, built-in extractors, and finalize. `restNodeToSnapshot` and
// everything above it (src/adapters/rest/, services) are the ADAPTER —
// deliberately not roots. Phase 2's esbuild purity probe targets this same
// entry, so anything the barrel doesn't reach isn't part of the core.
const CORE_ROOTS = ["core/index.ts"];

const FORBIDDEN = "@figma/rest-api-spec";

// Every module-referencing form: static `... from "x"`, bare side-effect
// `import "x"`, and dynamic / inline-type `import("x")`. The last matters most —
// an inline `import("@figma/rest-api-spec").Node` type reference reintroduces the
// forbidden dependency without any top-level import statement, and this test is
// the sole enforcement of the invariant, so a form it can't see is a false green.
const SPECIFIER_PATTERNS = [
  /(?:import|export)[\s\S]*?from\s*["']([^"']+)["']/g, // static import/export ... from
  /(?:^|[\n;])\s*import\s+["']([^"']+)["']/g, // bare side-effect import "x"
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // dynamic / inline-type import("x")
];

/** Extract every module specifier referenced by `source`, across all import forms. */
function importSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  for (const re of SPECIFIER_PATTERNS) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      specifiers.add(match[1]);
    }
  }
  return Array.from(specifiers);
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

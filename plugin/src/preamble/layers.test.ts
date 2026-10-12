/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The preamble's import direction. Asked of esbuild's input graph for the real sandbox bundle, so
// it sees runtime imports only — a type-only import is erased and can point anywhere.
//
// Two rules. The graph is acyclic: everything lands in one IIFE, where module-init order across a
// cycle is a latent hazard for any top-level value. And the orchestration tiers below only import
// downward (or within their own tier). A module named in no tier is library code — compilers, IR,
// the bridge's appliers, the read pipeline, diagnostics — and imports no tiered module at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const TIERS: readonly (readonly string[])[] = [
  // The bundle entry and the agent-facing surface.
  ["sandbox", "runtime"],
  // The mutating verbs. read.ts is the read pipeline as well as the read verbs, and standing state
  // reads through it, so it stays library.
  ["structure", "component", "edit", "edit-many", "page", "design-tokens"],
  // The one entry every mutating verb takes: serialize, seal, settle, commit.
  ["mutation-lock"],
  // What a verb loads before its seal, and where a tree's nodes land.
  ["verb-resources", "land-tree", "live-tree"],
  // The stages a gated edit lands in, and the plans they consume. No stage loads resources itself.
  ["edit-apply", "component-edit", "clone-bindings", "standing-state", "instance", "edit-plan", "component-properties"],
];

const tierOf = new Map(TIERS.flatMap((names, i) => names.map((name) => [name, i] as const)));
const LIBRARY = TIERS.length;

async function preambleGraph(): Promise<Map<string, string[]>> {
  const built = await esbuild.build({
    entryPoints: [fileURLToPath(new URL("./sandbox.ts", import.meta.url))],
    bundle: true, write: false, format: "iife", platform: "neutral", metafile: true, logLevel: "silent",
  });
  const local = (path: string) => /src\/preamble\/([\w-]+)\.ts$/.exec(path)?.[1];
  const graph = new Map<string, string[]>();
  for (const [path, input] of Object.entries(built.metafile.inputs)) {
    const name = local(path);
    if (name) graph.set(name, input.imports.flatMap((edge) => local(edge.path) ?? []));
  }
  return graph;
}

test("the preamble's runtime imports only point down the orchestration tiers", async () => {
  const graph = await preambleGraph();
  for (const name of tierOf.keys()) assert.ok(graph.has(name), `${name} is in a tier but not in the bundle — drop it from TIERS`);
  const upward = [...graph].flatMap(([from, deps]) =>
    deps.filter((to) => (tierOf.get(to) ?? LIBRARY) < (tierOf.get(from) ?? LIBRARY)).map((to) => `${from} → ${to}`),
  );
  assert.deepEqual(upward, []);
});

test("the preamble's runtime import graph has no cycle", async () => {
  const graph = await preambleGraph();
  const state = new Map<string, "open" | "done">();
  const cycles: string[] = [];
  const visit = (name: string, path: string[]): void => {
    if (state.get(name) === "done") return;
    if (state.get(name) === "open") {
      cycles.push([...path.slice(path.indexOf(name)), name].join(" → "));
      return;
    }
    state.set(name, "open");
    for (const dep of graph.get(name) ?? []) visit(dep, [...path, name]);
    state.set(name, "done");
  };
  for (const name of graph.keys()) visit(name, []);
  assert.deepEqual(cycles, []);
});

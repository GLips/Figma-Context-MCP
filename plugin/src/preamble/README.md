# The flcm sandbox runtime

The server bundles `runtime.ts` through `buildSandboxPreamble()` in `index.mjs` and sends the factory with each execute request. The plugin supplies `FlcmHost` and evaluates the factory in its sandbox. Only exports from `runtime.ts` reach the agent's `flcm` object.

## Authoring and compilation

Nodes are plain data in the read vocabulary. `compile-tree.ts` snapshots a tree, validates it with indexed paths, and dispatches each new node to its prop compiler: `compile-nodes.ts` (frames, shapes, vectors, instances, and the shared base/appearance/layout words), `compile-text.ts` (TEXT), `compile-component-words.ts` (property, override, definition-edit and binding words), and `value-sugar.ts` (the `gradient`/`image`/`effects` value verbs). The compiled `WriteNode` IR stays inside the mutation call. `schema.ts` supplies types and documentation; its zod dependency never enters the sandbox bundle.

A node spec with an `id` identifies a live node. It compiles to a read-only `LiveRef` holding only what the author wrote; what the node resolves to lives on the loaded and gated live tree (`verb-resources.ts` loads it, `live-tree.ts` gates and places it), using the same stages as `edit`. A spec without an id creates a node. Both forms recurse into ordinary `children` and instance slot content. Mentioned children go to the end in spec order; unmentioned children retain their relative order. Verbs return a fresh copy of the input with the placed ids filled in; caller data stays reusable. Component promotion returns root type `COMPONENT`.

`structure.ts` holds the placement and structural verbs, including `render` on the current page. `verb-resources.ts` loads and gates what a verb needs before its seal, and `land-tree.ts` lands a tree's root. `component.ts` promotes a tree's root and declares bindings. `bridge.ts` owns Figma writes and layout settlement, and `mutation-lock.ts` makes each verb one serialized undo step. Read-only preparation can fail without writes; application failures roll back the call. Addressing (`target.ts`) and component topology (`identity.ts`) are shared by read and write verbs.

## Layers

Imports point one way: seam (`sandbox`, `runtime`) → verbs → `mutation-lock` → resources and placement (`verb-resources`, `land-tree`, `live-tree`) → stages (`edit-apply`, `component-edit`, `instance`, `edit-plan`, …) → library (compilers, IR, the bridge's appliers, the read pipeline). `layers.test.ts` names the tiers and fails on an upward import or any cycle in the bundle's runtime graph.

Paint and effect helpers return reusable values. CSS strings compile through `css.ts`; only typed values reach bridge appliers. `get` returns expanded read data, with shared component definitions beside the node. The authoring reference is generated with `pnpm docs:gen`.

## Checks

Run `pnpm validate` at the repository root. It includes plugin type-checks, behavior tests, the zod-free preamble build, and generated-document drift checks. Tests use `plugin/harness/figma-mock.mjs`; the live harness remains available for Figma-specific verification.

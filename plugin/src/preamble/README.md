# The flcm sandbox runtime

The server bundles `runtime.ts` through `buildSandboxPreamble()` in `index.mjs` and sends the factory with each execute request. The plugin supplies `FlcmHost` and evaluates the factory in its sandbox. Only exports from `runtime.ts` reach the agent's `flcm` object.

## Authoring and compilation

Nodes are plain data in the read vocabulary. `compile-tree.ts` snapshots a tree, validates it with indexed paths, and dispatches each new node to the private prop compilers in `flcm.ts`. The compiled `WriteNode` IR stays inside the mutation call. `schema.ts` supplies types and documentation; its zod dependency never enters the sandbox bundle.

A node spec with an `id` identifies a live node. Its IR type is `UNRESOLVED` until `live-tree.ts` resolves it and prepares edits using the same stages as `edit`. A spec without an id creates a node. Both forms recurse into ordinary `children` and instance slot content. Mentioned children go to the end in spec order; unmentioned children retain their relative order. The bridge writes live ids into the private input snapshot, which becomes the returned tree; caller data stays reusable. Component promotion returns root type `COMPONENT`.

`structure.ts` drives placement, including `render` on the current page. `render.ts` loads and gates tree resources. `component.ts` promotes a tree's root and declares bindings. `bridge.ts` owns Figma writes and layout settlement, and `mutation-lock.ts` makes each verb one serialized undo step. Read-only preparation can fail without writes; application failures roll back the call.

Paint and effect helpers return reusable values. CSS strings compile through `css.ts`; only typed values reach bridge appliers. `get` returns expanded read data, with shared component definitions beside the node. The authoring reference is generated with `pnpm docs:gen`.

## Checks

Run `pnpm validate` at the repository root. It includes plugin type-checks, behavior tests, the zod-free preamble build, and generated-document drift checks. Tests use `plugin/harness/figma-mock.mjs`; the live harness remains available for Figma-specific verification.

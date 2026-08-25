# @framelink/plugin

The Framelink Figma plugin — hosts **flcm**, the authoring DSL for the "code mode" write path. Private workspace member; never published to npm.

- `src/preamble/` — the flcm runtime, bundled by esbuild (`index.mjs`, the one seam, which also gates zod out of the graph) into an IIFE preamble. The **server** builds it and ships it with every execute request (ADR-0010); the plugin evals it ahead of the agent's code in the QuickJS sandbox. `host.ts` is the whole host↔preamble interface — the `FlcmHost` object arriving as the eval-wrapper parameter `__flcmHost`. `schema.ts` is the single source of the authoring surface (the write edge of the canonical vocabulary); types, validation, and the generated authoring doc all derive from it.
- `src/code.ts` — the plugin host (Figma main thread): sandbox setup and approval gating; it never touches the network itself, talking to the server's WS relay (`src/services/plugin-bridge/` in the repo root) via postMessage to the headless `ui.html`, which owns the WS connection.
- `build.mjs` — esbuild build of the host shell only; the preamble is not bundled here. Greps the output for the `__flcmHost` wrapper head, the one part of the host interface no compiler can pin. Run as `pnpm build:plugin` from the repo root.
- `harness/` — live-Figma ergonomics flows (`pnpm dogfood`); not part of CI.
- `docs/authoring/flcm.md` — **generated** from the schema by the repo-root `scripts/gen-flcm-doc.ts`; never hand-edit (`pnpm docs:check` gates drift).

Tests: `pnpm test:plugin` from the repo root (node:test, not vitest).

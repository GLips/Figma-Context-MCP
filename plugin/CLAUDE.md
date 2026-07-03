# @framelink/plugin

The Framelink Figma plugin — hosts **flcm**, the authoring DSL for the "code mode" write path. Private workspace member; never published to npm.

- `src/preamble/` — the flcm runtime, bundled by esbuild into an IIFE preamble injected into the QuickJS sandbox where agent code runs. `schema.ts` is the single source of the authoring surface (the write edge of the canonical vocabulary); types, validation, and the generated authoring doc all derive from it.
- `src/code.ts` — the plugin host (Figma main thread): sandbox setup and approval gating; it never touches the network itself, talking to the bridge via postMessage to the headless `ui.html`, which owns the WS connection.
- `build.mjs` — esbuild build; fails if zod leaks into the preamble bundle (QuickJS purity guard). Run as `pnpm build:plugin` from the repo root.
- `harness/` — live-Figma ergonomics flows (`pnpm dogfood`); not part of CI.
- `docs/authoring/flcm.md` — **generated** from the schema by `bridge/scripts/gen-flcm-doc.ts`; never hand-edit (`docs:check:flcm` gates drift).

Tests: `pnpm test:flcm` from the repo root (node:test, not vitest). Design docs (ADRs, plans) live in the repo-root `docs/flcm/` — a private repo clone, gitignored; don't commit design docs here.

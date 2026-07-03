# @framelink/bridge

The WS bridge + `execute_code` MCP server connecting MCP clients to the Figma plugin. Private workspace member; expected to dissolve into the root package's `src/mcp` at a future server-surface unification.

- `src/bridge.ts` / `src/index.ts` — WebSocket relay (plugin ⇄ server) and MCP server entry (`pnpm dev` here to run it).
- `src/tool-docs.ts` + `src/docs/` — the `execute_code` tool description, built from code (the schema is the source of truth, not a hand-written doc).
- `src/approval.ts` — human-approval gate for plugin mutations.
- `scripts/gen-flcm-doc.ts` — regenerates `plugin/docs/authoring/flcm.md` from the schema; `docs:check` fails CI on drift.
- `harness/bridge-contract.mjs` — end-to-end bridge contract check (`pnpm contract:flcm` from the repo root).

Tests: `pnpm test:flcm` from the repo root (node:test, not vitest). Design docs live in the repo-root `docs/flcm/` — a private repo clone, gitignored; don't commit design docs here.

# Framelink MCP for Figma

Framelink MCP for Figma is a Model Context Protocol (MCP) server that gives AI coding tools (Cursor, etc.) access to Figma design data. It fetches Figma files/nodes via the Figma API, simplifies the response to include only relevant layout and styling information, and serves it to AI clients.

## Repo layout (pnpm workspace)

This repo is a pnpm workspace. The **root package `figma-developer-mcp`** is the shipped npm product: one MCP server carrying both the REST read tools and the **flcm** write path ("code mode"). One `"private": true` workspace member remains:

- **`plugin/`** (`@framelink/plugin`) — the Figma plugin: the `flcm` authoring DSL preamble (`src/preamble/`, an esbuild IIFE bundled into the QuickJS sandbox), `code.ts` host, `manifest.json`, `ui.html`, `build.mjs`. Its schema (`src/preamble/schema.ts`) is the write edge of the canonical vocabulary — the root build bundles it into `dist` via tsup `noExternal` (the package itself is never published).

The write path lives in the root `src/`: `src/services/plugin-bridge/` is the WS relay to the plugin (port block, approval gate, version-skew policy, the trusted image fetch), and `src/mcp/tools/figma-execute-code-tool.ts` registers the code-mode tools (`figma_execute_code`, `get_flcm_reference`, `get_screenshot`). The relay starts with the server in both transports; the tools are **dynamically advertised** — disabled until a plugin connects (latched on for the process lifetime; `--code-mode` forces always-on). `src/mcp/tools/flcm-docs/` generates the tool docs from the schema; `scripts/gen-flcm-doc.ts` regenerates the committed artifacts (`pnpm docs:gen`, drift-gated by `pnpm docs:check`).

flcm design docs (ADRs, plans, sketches, solutions) live in **`docs/flcm/`** — note `docs/` is a separate private repo (FramelinkAI/mcp-docs) cloned at that path and gitignored here; design docs must not be committed to this public repo. The tracked generated docs are `plugin/docs/authoring/flcm.md` and `src/mcp/tools/flcm-docs/examples-code.generated.ts` (CI-gated, regenerated from code).

The relocation puts `src/core` in-repo so the plugin **will** bundle it from source via esbuild (no npm subpath) once the read surface lands — that import doesn't exist yet (it's the read plan). Today the flcm CI guard covers the plugin build's **zod-purity gate** and the REST↔plugin **parity snapshots** (core-coupled: a core change that alters output fails goldens + parity). The plugin keeps its own toolchain (its own `tsconfig`/typecheck, a `node:test` runner) and is excluded from the root's eslint/prettier; the relocated bridge code is ordinary `src/` code under the root toolchain.

zod note: the root dependency is zod 4. The flcm surface (and the bundled plugin schema) uses the v4 API from `"zod"`; the pre-existing read-tool schemas import `"zod/v3"` (the classic API zod 4 still ships) — migrate them deliberately, not incidentally.

## Build & Development Commands

```bash
pnpm install          # Install dependencies
pnpm build            # Build with tsup (outputs to dist/)
pnpm dev              # Development mode with watch + auto-restart (HTTP)
pnpm dev:cli          # Development mode (stdio)
pnpm test             # Run Vitest tests (figma-mcp core only; scoped to src/)
pnpm type-check       # TypeScript type checking only
pnpm lint             # ESLint
pnpm format           # Prettier formatting
pnpm inspect          # Run MCP inspector for debugging
pnpm validate         # One gate over the whole workspace — run before pushing
```

`pnpm validate` is the single CI gate: hidden-char scan, format check, lint, root type-check + Vitest suite (goldens + parity + purity + the relocated bridge tests), the plugin (`typecheck:plugin`, `test:plugin`, `build:plugin` with its zod-purity guard), the WS `contract` harness, and `docs:check` (generated-doc drift).

### Running the Server

```bash
pnpm start            # HTTP mode (default port 3333)
pnpm start:cli        # stdio mode for MCP clients
```

### Running a Single Test

```bash
pnpm test -- path/to/test.ts
pnpm test -- --testNamePattern="pattern"
```

### Releasing

Releases are automated via [release-please](https://github.com/googleapis/release-please). On merge to `main`, release-please reads conventional commit prefixes (`fix:`, `feat:`, `feat!:`) and maintains a release PR. Merging the release PR publishes to npm via OIDC trusted publishing.

### PR Title Convention

PRs are squash-merged, so the PR title becomes the commit message that release-please parses. Always use [Conventional Commit](https://www.conventionalcommits.org/) prefixes in PR titles.

## Architecture

### Entry Points

- `src/bin.ts` — CLI entry point, calls `startServer()`
- `src/server.ts` — Server initialization, handles stdio vs HTTP mode selection
- `src/mcp-server.ts` — Library re-exports for external consumers (`createServer`, `startServer`, etc.)
- `src/index.ts` — Library exports (extractors, types)

### Transport Modes

The server supports two transports (configured in `src/server.ts`):

- **stdio** — For direct MCP client integration (activated with `--stdio` flag or `NODE_ENV=cli`)
- **StreamableHTTP** — Stateless HTTP transport at `/mcp` (also served at `/sse` for backward compatibility with existing client configs)

### Core Data Flow

1. **MCP Tools** (`src/mcp/tools/`) — Define tool schemas and handlers

   - `get_figma_data` — Fetches and simplifies Figma design data
   - `download_figma_images` — Downloads images from Figma
   - `figma_execute_code` / `get_flcm_reference` / `get_screenshot` — the code-mode write path,
     served over the WS relay (`src/services/plugin-bridge/`); hidden from `tools/list` until the
     Figma plugin connects (or `--code-mode`)

2. **Figma Service** (`src/services/figma.ts`) — API client for Figma REST API

   - Handles auth (Personal Access Token or OAuth)
   - Methods: `getRawFile()`, `getRawNode()`, `downloadImages()`

3. **REST Adapter** (`src/adapters/rest/`) — REST wire format → `NodeSnapshot`

   - `rest.ts` — Entry point (`simplifyRestResponse`): parses the API response envelope, decodes the component tables, and calls the core
   - `node-to-snapshot.ts` — Decodes a raw REST node into a plan-neutral `NodeSnapshot` (with `text.ts`, `paint.ts` handling wire-specific structures)

4. **Simplify Core** (`src/core/`) — Transforms `NodeSnapshot` into simplified output; Figma-type-free (gated by `src/tests/core-figma-free.test.ts`), entry barrel `src/core/index.ts`

   - `simplify.ts` — The whole spine: `simplify()` picks a style table, then a single-pass walk extracts geometry/layout, text, visuals, and component data per node (and collapses SVG-heavy containers)
   - `style-table.ts` — Where the walk interns style values: inline emission (expanded) vs content-addressed refs (compressing)
   - `compress.ts` — Opt-in egress compression pass (count-gated style hoisting, element templates)
   - `transformers/` — Convert specific node properties
     - `layout.ts` — Layout/positioning transforms
     - `style.ts` — Visual styling (fills, strokes)
     - `effects.ts` — Effects (shadows, blurs)
     - `text.ts` — Text content and styling
     - `component.ts` — Component metadata

### Configuration

`src/config.ts` handles CLI args and environment variables:

- `FIGMA_API_KEY` or `--figma-api-key` — Personal Access Token
- `FIGMA_OAUTH_TOKEN` or `--figma-oauth-token` — OAuth Bearer token
- `PORT` or `--port` — HTTP server port (default: 3333)
- `OUTPUT_FORMAT` or `--format` — Output format: `tree` (default), `yaml`, or `json`
- `--json` — Back-compat alias for `--format=json`
- `--skip-image-downloads` — Disable image download tool
- `FIGMA_CODE_MODE` or `--code-mode` — Always advertise the code-mode write tools (default: advertised only once the Figma plugin connects)

### Path Alias

The codebase uses `~/` as an alias for `src/` (configured in tsconfig.json and vitest.config.ts).

## Philosophy

From CONTRIBUTING.md — important context for development:

1. **Unix Philosophy** — Tools should have one job and few arguments. Keep tools simple to avoid confusing LLMs.
2. **Focused Scope** — The server only handles "ingesting designs for AI consumption." Out of scope: image manipulation, CMS syncing, code generation, third-party integrations.
3. **Project-level Config** — Options unlikely to change between requests should be CLI arguments, not tool parameters.

## Token Efficiency

The simplified output is consumed by LLMs, so every field costs context budget. Keep it lean:

- Omit default values where LLMs can reliably infer the expectation without explicit data — emit only deviations. (e.g. `strokeAlign: INSIDE` matches the default CSS `border` an LLM already produces, so it is dropped; only `OUTSIDE`/`CENTER` are emitted.)

## Quality

This codebase will outlive you. Every shortcut becomes someone else's burden. Every hack compounds into technical debt that slows the whole team down.

For each proposed change, examine the existing system and redesign it into the most elegant solution that would have emerged if the change had been a foundational assumption from the start.

You are not just writing code. You are shaping the future of this project. The patterns you establish will be copied. The corners you cut will be cut again.

Fight entropy. Leave the codebase better than you found it.

## Comment Policy

### Unacceptable Comments

- Comments that repeat what code does
- Commented-out code (delete it)
- Obvious comments ("increment counter")
- Comments instead of good naming

### Great Comments

- **Why this exists** — what problem does this solve, why is it valuable
- **Why it works this way** — important design decisions and their rationale
- **Why NOT** — approaches you considered and rejected, to prevent re-attempting failed ideas
- **Warnings** — non-obvious gotchas, ordering dependencies, "this must happen before X"
- **Domain bridges** — when code implements complex domain logic (finance calculations, protocol specs, algorithms) that can't fully express the underlying concept
- **Looks wrong** — when code appears unused, redundant, or incorrect but exists for a non-obvious reason (e.g., interface contracts for test implementations, load-bearing side effects)
- **Negative space** — when code deliberately doesn't handle something and that absence is intentional (e.g., "Does not retry—caller handles backoff" prevents someone from "helpfully" adding retry logic that breaks upstream assumptions)

## Testing Philosophy

Write tests. Not too many. Mostly integration.

- Every test has a cost: maintenance, false positives, slower CI. Tests must earn their place.
- Most features need 2-5 tests. Some need zero.
- Zero tests is valid for: simple CRUD, styling, config changes, framework-convention code, etc.
- Design for testability using "functional core, imperative shell": keep pure business logic separate from code that does IO.

### Principles

- **Test behavior, not implementation.** Tests should verify what the code does, not how it does it. Only use methods available on the public interface to verify behavior.
- **Don't test what the type system guarantees.** If TypeScript enforces it at compile time, a runtime test adds no value.
- **Don't test the framework.** Don't verify that Express routes, React renders, or ORM queries work — test _your_ logic.
- **Prefer real implementations over mocks.** Mocks couple tests to implementation details and hide real bugs. Only mock at system boundaries (network, filesystem, time).

### Only test behavior where:

- A failure would frustrate or block real users
- The behavior is non-obvious and could regress silently
- It's a critical integration point or state transition

### Skip testing:

- Implementation details, private methods, trivial code
- Edge cases that won't occur in practice
- Variations that test the same underlying behavior

## Error Handling

Trust internal code and framework guarantees. Only validate at system boundaries — user input, external APIs, file I/O. Don't add try/catch, fallbacks, or defensive checks for scenarios that can't happen in practice. Let errors propagate naturally; the caller that knows how to handle them should be the one catching them.

## External Libraries

Use the context7 MCP first to gather information on unfamiliar libraries or APIs. If that fails, you may search the code directly or search the web for more detail.

## Communication Style

When reviewing plans, providing feedback, or analyzing approaches, be genuinely critical. Flag real risks, tradeoffs, and things that will break rather than being agreeable. Grounded, opinionated analysis is more valuable than polite agreement.

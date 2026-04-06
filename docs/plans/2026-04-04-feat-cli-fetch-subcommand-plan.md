---
title: "feat: CLI fetch subcommand"
type: feat
status: active
date: 2026-04-04
---

# CLI `fetch` Subcommand

## Context

Users should be able to fetch simplified Figma data from the CLI without running a server. This plan adds a `fetch` subcommand as a completely separate code path using `cleye`'s native subcommand support, calling the library layer directly.

See: `docs/brainstorms/2026-04-04-cli-fetch-subcommand-brainstorm.md`

## Phase 1: Safety net (near-term)

### Goal

Add tests covering the behaviors most at risk during the Phase 2 refactor: config helpers we're extracting, serialization we're moving, and the CLI startup paths we're rewiring.

### Approach

**Auth/config resolution tests**: Export the pure helpers from `config.ts` (`resolve()`, `envStr()`, `envInt()`, `envBool()`) and test them directly. These stay exported after the refactor — not temporary scaffolding. Key behaviors:

- `resolve()` priority chain: CLI flag wins over env, env wins over default, default is fallback
- `envStr()` returns `undefined` for empty/missing vars
- `envInt()` tries multiple names in order
- `envBool()` maps `"true"`/`"false"` strings, returns `undefined` for anything else

**Result serialization tests**: Write tests against the current inline serialization behavior in `get-figma-data-tool.ts`. Phase 2 extracts this into a shared function — the tests verify the extraction preserves behavior:

- YAML output uses performance flags (`noRefs`, `lineWidth: -1`, `noCompatMode`, `JSON_SCHEMA`)
- JSON output is pretty-printed with 2-space indent

**Process-level CLI startup tests**: The `bin.ts` rewrite is the riskiest change for existing users. Add process-level tests that pin the current behavior before touching it:

- `--stdio` flag starts stdio mode and completes MCP handshake (extend existing `stdio.test.ts`)
- `NODE_ENV=cli` starts stdio mode (this backdoor is in `config.ts` today, moves to `bin.ts` — must not break)
- HTTP mode starts and listens on the expected port with root flags

### Warnings

- Clean up `process.env` mutations between tests to avoid cross-test pollution
- The serialization test should verify the YAML _options_ produce distinct output from a bare `yaml.dump()` — e.g., a self-referential object that `noRefs: true` handles differently, or a long string that `lineWidth: -1` keeps on one line

### Done when

- [x] Tests pass against the current code
- [x] Intentionally breaking a `resolve()` priority or removing a YAML option causes a test failure
- [x] Intentionally breaking the stdio or HTTP startup path causes a test failure

### Completed

Branch: `feat/cli-fetch-subcommand` (4 commits on top of main)

- `a651286` — exported config helpers, 13 unit tests for resolve/envStr/envInt/envBool
- `ee088d7` — 5 serialization tests (noRefs, lineWidth, round-trip, JSON indent)
- `13c4499` — process-level CLI tests (NODE_ENV=cli stdio, HTTP startup on port 19876)
- `2d9405f` — edge cases: falsy resolve values, JSON_SCHEMA quoting behavior

All tests verified by intentional breakage: resolve priority swap, noRefs removal, lineWidth removal, JSON_SCHEMA removal, NODE_ENV=cli removal — each caught by the corresponding test.

## Phase 2: Fetch subcommand (near-term)

### Goal

Add `figma-developer-mcp fetch` as a subcommand that performs a one-off Figma data fetch to stdout, without touching the server code path.

### Approach

**Restructure `bin.ts` as a router.** Move the `cli()` call from `config.ts` to `bin.ts`. `bin.ts` defines root-level flags (server flags) and registers the `fetch` subcommand. When no subcommand is given, `bin.ts` calls `getServerConfig(flags)` → `startServer(config)` directly — no intermediate `serve.ts` needed since it would just be two lines of pass-through.

**`commands/fetch.ts`** is a cleye `command()` with its own flags and callback. It's the only file in `commands/` — the serve path doesn't need one since server flags must stay at the root level to preserve backward compatibility (`figma-developer-mcp --stdio` must keep working) and the routing logic is trivial.

**Keep auth in `config.ts`.** Auth construction (`resolveAuth`) stays in `config.ts` alongside the generic helpers (`resolve()`, `envStr()`, etc.) it depends on. No separate `auth.ts` — it would create a circular dependency since `config.ts` also needs `resolveAuth`. Both the serve path and fetch command import `resolveAuth` + `loadEnv` from `config.ts`. `config.ts` stops owning CLI parsing and instead receives parsed flags via `getServerConfig(flags)`.

**Extract result serialization to `utils/serialize.ts`.** A `serializeResult(result, format)` function handling both YAML (with perf flags) and JSON. Replaces the inline serialization in `get-figma-data-tool.ts` and is used by the fetch command.

**New URL parser at `utils/figma-url.ts`.** Parses Figma URLs into `{ fileKey, nodeId }`. Supports `figma.com/file/...` and `figma.com/design/...` formats, with `node-id` query parameter extraction. Converts `-` to `:` in node IDs (Figma URLs use dashes, API expects colons).

**Fetch command interface:**

```
figma-developer-mcp fetch [url]

Positional:
  url                    Figma URL (optional if --file-key given)

Flags:
  --file-key             Figma file key (overrides URL)
  --node-id              Node ID, format 1234:5678 (overrides URL)
  --depth                Tree traversal depth
  --json                 Output JSON instead of YAML
  --figma-api-key        Figma API key
  --figma-oauth-token    Figma OAuth token
  --env                  Path to .env file
```

URL is optional positional. `--file-key` and `--node-id` override values parsed from a URL. If no URL and no `--file-key`, error.

**Fetch handler flow:** Parse URL/flags → load .env → resolve auth → instantiate `FigmaService` → call `getRawNode()`/`getRawFile()` → `simplifyRawFigmaObject()` with `allExtractors` + `collapseSvgContainers` → `serializeResult()` → `console.log()` to stdout.

### Interfaces

The shared serializer replaces inline code in `get-figma-data-tool.ts`. Current usage:

```ts
// get-figma-data-tool.ts, lines 111-122 (current)
const formattedResult =
  outputFormat === "json"
    ? JSON.stringify(result, null, 2)
    : yaml.dump(result, {
        noRefs: true,
        lineWidth: -1,
        noCompatMode: true,
        schema: yaml.JSON_SCHEMA,
      });
```

After extraction, both call sites become:

```ts
import { serializeResult } from "~/utils/serialize.js";
const output = serializeResult(result, outputFormat);
```

Both the serve path and fetch command need auth. They import from `config.ts`:

```ts
import { loadEnv, resolveAuth } from "~/config.js";

loadEnv(envFlagValue);
const auth = resolveAuth({ figmaApiKey: flagValue, figmaOauthToken: flagValue });
// resolveAuth uses resolve()/envStr() internally for flag → env → default chain
// Exits if neither API key nor OAuth token is found
```

`getServerConfig(flags)` calls these internally for the serve path. The fetch command calls them directly.

### Integration points

- **`bin.ts`** — Complete rewrite. Becomes the `cli()` owner and router. `NODE_ENV === "cli"` stdio detection moves here. Default branch calls `getServerConfig(flags)` → `startServer(config)` directly.
- **`config.ts`** — Loses `cli()` call. `getServerConfig(flags)` takes pre-parsed flags instead of parsing internally. Gains exported `resolveAuth()` and `loadEnv()` for the fetch command to use. Generic helpers (`resolve()`, `envStr()`, etc.) stay here and are also exported.
- **`get-figma-data-tool.ts`** — Inline serialization replaced by `serializeResult()` import. One-line change.
- **`server.ts`** — `startServer(config: ServerConfig)` takes a config object directly instead of calling `getServerConfig()` internally. Server internals (HTTP setup, transport, connections) are untouched.
- **`mcp-server.ts`** — Library re-exports update to match new signatures. No backward-compat concern — no known library consumers depend on these.
- **`tsup.config.ts`** — No changes needed.

### Warnings

- `cleye` subcommand flags and root flags are separate namespaces. Server flags (--stdio, --port, etc.) MUST stay at root level, not on a `serve` subcommand, or `figma-developer-mcp --stdio` breaks.
- Root flags are NOT inherited by subcommands. The `fetch` command must declare its own `--json`, `--figma-api-key`, etc. — it can't rely on root-level definitions.
- Flag-before-command (`figma-developer-mcp --json fetch <url>`) will NOT invoke fetch — cleye dispatches on the first positional token. This is fine (it's how most CLIs work) but `--help` should make the subcommand usage clear.
- Figma URLs can contain `&` which shells interpret. The `--help` output or docs should mention quoting the URL argument.
- The fetch command must pass `depth` to both `getRawNode()`/`getRawFile()` AND `simplifyRawFigmaObject()` (as `maxDepth`).

### Done when

- [ ] `figma-developer-mcp` with no subcommand starts the server identically to today (stdio and HTTP modes)
- [ ] `figma-developer-mcp fetch "https://figma.com/design/ABC/name?node-id=1-2"` outputs simplified YAML to stdout
- [ ] `figma-developer-mcp fetch --file-key ABC --node-id 1:2 --json` outputs JSON
- [ ] Phase 1 safety-net tests still pass
- [ ] Existing test suite passes with no modifications (except import path changes if tests import from moved modules)

---

## Dependencies

None.

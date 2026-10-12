# Framelink MCP for Figma

## Overview

An MCP server (`figma-developer-mcp` on npm) that gives AI coding tools access to Figma designs. It has two halves:

- **Read** — fetches files/nodes from the Figma REST API and simplifies them into a compact, LLM-shaped view of layout, styling, and component data.
- **Write ("code mode")** — an agent authors `flcm` code that a companion Figma plugin executes against the live document, over a local WebSocket relay.

It runs as a long-lived local process on user machines holding a user's Figma token, so treat auth handling, the WS relay, the upload endpoint, and anything touching the filesystem as a real trust boundary.

## Commands

`pnpm validate` is the single CI gate: tests, formatting, linting, etc.

`pnpm run` for full list of commands.

## Architecture

A pnpm workspace with three private members, never published on their own. The first two are bundled into `dist` by the root build:

- `core/` (`@framelink/core`) — the shared read transform. Depends on nothing; both producers depend on it.
- `plugin/` (`@framelink/plugin`) — the Figma plugin, and the `flcm` schema the root reads for docs.
- `tools/payload-lab/` — a dev-only tool for inspecting read payloads (`pnpm payload-lab`). Not bundled; nothing depends on it.

The root package is the shipped product. The arrows only point one way — `plugin → core`, `root → core`, `root → plugin` — so no member reaches back into another's source. Two things enforce that: each member declares its dependency in its own `package.json`, and `core` declares none at all.

### Read path

`src/services/figma.ts` (REST client, PAT or OAuth) → `src/adapters/rest/` (wire format → plan-neutral `NodeSnapshot`) → `@framelink/core` (snapshot → simplified output). The tools live in `src/mcp/tools/`: `get_figma_data`, `get_figma_comments`, `download_figma_images`.

### Write path ("code mode")

`plugin/src/preamble/schema.ts` is the single source of the `flcm` authoring surface — types, validation, and generated docs all derive from it. The preamble itself ships from the **server**, sent with every `EXECUTE_CODE` (ADR-0010), so a DSL change needs no plugin re-import; the only thing the plugin hands it is `FlcmHost` (`plugin/src/preamble/host.ts`), and changing THAT does need one. The preamble also owns egress: the factory returns `projectForEgress`, which the plugin applies to every result and console line. The wire itself — protocol version, every frame type, the reply each request is owed, and the timing both sides share — lives in `plugin/src/protocol.ts` (`@framelink/plugin/protocol`), zod-free and imported by both sides, so a protocol change is one file and one version bump. `src/commercial/plugin-bridge/` is the WS relay to the plugin (approval gate, version-skew policy, trusted image fetch), and `src/commercial/tools/code-mode-tools.ts` registers `figma_execute_code`, `get_flcm_reference`, `get_screenshot`. Write-path tests live in `src/commercial/tests/`.

The relay starts with the server in both transports, but the code-mode tools are **dynamically advertised**: hidden from `tools/list` until a plugin connects, then latched on for the process lifetime. `--code-mode` forces them always-on.

Beside the relay, `plugin-bridge/upload-endpoint.ts` runs a second loopback listener (`POST /uploads`) that takes image bytes for the `upload` command, with its own browser-refusal and authorization gates. Every write passes the gate in `src/commercial/entitlement/`: a free monthly allowance on a local ledger, then a seat check against the Framelink app.

### CLI and telemetry

`src/bin.ts` either starts the server or dispatches a subcommand: `src/commands/` (`fetch`, `comments`) and `src/commercial/commands/` (`execute`, `reference`, `upload`). Every MCP tool needs a CLI counterpart or an explicit exemption in `MCP_TOOL_CLI_COUNTERPARTS` (`src/commands/index.ts`); a test enforces it. `src/telemetry/` sends anonymous usage events to PostHog, scrubbing credentials and Figma identifiers first; `--no-telemetry`, `FRAMELINK_TELEMETRY=off` or `DO_NOT_TRACK` turn it off.

## Rules of the road

- **Every output field costs context budget.** Omit values an LLM can infer — emit only deviations from the default. (`strokeAlign: INSIDE` matches the CSS `border` an LLM already writes, so it's dropped; only `OUTSIDE`/`CENTER` are emitted.)
- **`@framelink/core` must stay Figma-type-free.** It consumes `NodeSnapshot`, never REST or plugin types — that's what lets both the REST adapter and the plugin feed it. Gated by `core/tests/figma-free.test.ts`; a core change that shifts output fails both the goldens and the REST↔plugin parity snapshots.
- **Generated files are never hand-edited.** `plugin/docs/authoring/flcm.md` and `src/commercial/tools/flcm-docs/examples-code.generated.ts` come from the schema via `scripts/gen-flcm-doc.ts`. Change the schema, run `pnpm docs:gen`; `docs:check` fails the build on drift.
- **The plugin preamble must stay zod-free.** It runs in QuickJS; `buildSandboxPreamble()` fails the build if zod appears anywhere in the preamble's input graph. Validation there is hand-rolled on purpose.
- **zod 4 is the root dependency.** The flcm surface uses the v4 API from `"zod"`; the older read-tool schemas still import `"zod/v3"`. Migrate those deliberately, not as a drive-by.
- **Config lives in `src/config.ts`.** The exceptions read env where it's used: `FRAMELINK_STATE_DIR`/`XDG_STATE_HOME` in `src/commercial/state-dir.ts` (the state root for approvals, uploads and write access), the proxy variables in `src/utils/proxy-env.ts`, `NODE_ENV` in the logger, and `CI` in telemetry.
- **Write-path code goes in a commercial root, with the header.** The write path is commercial-licensed (LICENSING.md): new write-path code lives under `src/commercial/` or `plugin/` (or is added to `COMMERCIAL_PATHS`) and opens with the `LicenseRef-Framelink-Commercial` SPDX header. `pnpm check:license-headers` fails on a missing header or a header outside those roots; `--write` adds missing ones.
- **`~/` is a path alias for `src/`** (tsconfig + vitest).

## Scope

The server ingests designs for AI consumption and executes authored design edits — not image manipulation, CMS syncing, or code generation. Tools do one job with few arguments; options unlikely to change per-request are CLI arguments, not tool parameters. See CONTRIBUTING.md.

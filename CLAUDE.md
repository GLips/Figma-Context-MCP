# Framelink MCP for Figma

## Overview

An MCP server (`figma-developer-mcp` on npm) that gives AI coding tools access to Figma designs. It has two halves:

- **Read** — fetches files/nodes from the Figma REST API and simplifies them into a compact, LLM-shaped view of layout, styling, and component data.
- **Write ("code mode")** — an agent authors `flcm` code that a companion Figma plugin executes against the live document, over a local WebSocket relay.

It runs as a long-lived local process on user machines holding a user's Figma token, so treat auth handling, the WS relay, the upload endpoint, and anything touching the filesystem as a real trust boundary.

## Commands

`pnpm validate` is the single CI gate: tests, formatting, linting, etc.

`pnpm run` for full list of commands.

In dev (`pnpm dev`), everything reloads on its own: the server rebuilds and restarts on a source change, and the plugin hot-loads its new build in Figma. Never ask for a server restart or a plugin re-import before testing live, even after a protocol bump.

## Architecture

A pnpm workspace with three private members, never published on their own. The first two are bundled into `dist` by the root build:

- `core/` (`@framelink/core`) — the shared read transform. Depends on nothing; both producers depend on it.
- `plugin/` (`@framelink/plugin`) — the Figma plugin, and the `flcm` schema the root reads for docs.
- `tools/payload-lab/` — a dev-only tool for inspecting read payloads (`pnpm payload-lab`). Not bundled; nothing depends on it.

The root package is the shipped product. The arrows only point one way — `plugin → core`, `root → core`, `root → plugin` — so no member reaches back into another's source. Two things enforce that: each member declares its dependency in its own `package.json`, and `core` declares none at all.

### Read path

`src/services/figma.ts` (REST client, PAT or OAuth) → `src/adapters/rest/` (wire format → plan-neutral `NodeSnapshot`) → `@framelink/core` (snapshot → simplified output). The tools live in `src/mcp/tools/`: `get_figma_data`, `get_figma_comments`, `download_figma_images`.

### Write path ("code mode")

`plugin/src/preamble/schema.ts` is the single source of the `flcm` authoring surface — types, validation, and generated docs all derive from it. The preamble itself ships from the **server**, sent with every `EXECUTE_CODE` (ADR-0010), so a DSL change needs no plugin re-import; the only thing the plugin hands it is `FlcmHost` (`plugin/src/preamble/host.ts`), and changing THAT does need one. The preamble also owns egress: the factory returns `projectForEgress`, which the plugin applies to every result and console line. The wire itself — protocol version, every frame type, the reply each request is owed, and the timing both sides share — lives in `plugin/src/protocol.ts` (`@framelink/plugin/protocol`), zod-free and imported by both sides, so a protocol change is one file and one version bump. `src/commercial/plugin-bridge/` is the WS relay to the plugin (link documents, call targeting, version-skew policy, trusted image fetch), and `src/commercial/tools/code-mode-tools.ts` registers `figma_execute_code`, `get_flcm_reference`, `get_screenshot`, `await_figma_execution`, `pair_figma_plugin`. MCP clients abandon a call at about 60 s, so a run or screenshot call checks in 45 s after it started (`MCP_CHECK_IN_MS`, `src/commercial/tools/plugin-run-waiting.ts`), never cancelling for time: a run not yet sent is never sent, a run still queued is withdrawn (reported as not run only on the plugin's `withdrawn`), and a run under way is detached. Only the waiter detaches; the run, its services and its charge carry on, and the process-wide registry (`detached-runs.ts`) holds its outcome under an unpredictable run handle for `await_figma_execution` to wait on, cancel, or fetch for 10 minutes after it ends. The CLI waits with no limit. Every plugin link proves it holds a credential paired with this state dir before it is sent anything but HELLO; an unpaired link is paired by a human comparing a code on the panel with one their agent or `pair` shows. Every write call runs in exactly one document: the plugin stamps each file's root with a random document id and reports it with the file's name; an agent names a document by that id, no REST call identifies a file, and the plugin alone stores grants, one per installation, owner, project and document id. The server keeps no grant state and asks the plugin on every call. An Allow prompt is per project and document, not per call: a second call from that project waits on the one already showing, and when a call stops waiting (an MCP check-in, a CLI exit) the prompt stays in the panel as stopped waiting, so a late Allow lets the project's next call run with no new prompt. It grants only the scope it showed and runs nothing. What a call waits on (a file to reconnect, Allow, a pick, sending, its run) is one `CallWait` value, worded only by `call-wait.ts`, for progress, CLI lines and the reply when a call stops waiting. Which files are open comes from each plugin instance's presence entry in its shared clientStorage (`plugin/src/presence.ts`: name, file key, current page, page count, a small selection summary, whether its window is showing, and grant keys), read at call time through OPEN_INSTANCES on any linked plugin (`open-files.ts`), so a file whose plugin hasn't linked yet (a hidden window can take ~6 s) is still listed. A call naming nothing runs in the one open file, asking Allow there if needed; with two or more open it is refused at once with one list (`openDocumentsText`, shared by MCP, CLI and `reference --files`). Only the file a call names or is given is waited for to link, within the caller's wait; there is no grace after which a plugin counts as closed, only a presence entry gone stale (2 min). Each agent's flcm `session` is reachable only through a handle the server mints (`session-handle.ts`) and every reply names; the plugin holds the stores, and a call naming a handle runs only where that session lives. Every plugin call carries a required one-line `intent` (`call-intent.ts`, checked by `parseIntent` in the protocol on both ends): the panel shows it in a per-file activity feed and on the call's prompts, and it never selects a target. Write-path tests live in `src/commercial/tests/`.

The relay starts with the server in both transports, but the code-mode tools are **dynamically advertised**: hidden from `tools/list` until a plugin connects, then latched on for the process lifetime. `--code-mode` forces them always-on.

Beside the relay, `plugin-bridge/upload-endpoint.ts` runs a second loopback listener (`POST /uploads`) that takes image bytes for the `upload` command, with its own browser-refusal and authorization gates. Every write passes the gate in `src/commercial/entitlement/`: a free monthly allowance on a local ledger, then a seat check against the Framelink app. One execution id (`src/commercial/execution-id.ts`, shared by the bridge and the meter), minted once per call, is the run's wire id and the key it is cancelled, served and metered by; the meter settles it once, and only from the link it went out on.

### CLI and telemetry

`src/bin.ts` either starts the server or dispatches a subcommand: `src/commands/` (`fetch`, `comments`, …) and `src/commercial/commands/` (`execute`, `pair`, `reference`, `upload`, …). Each command is `defineCliCommand(definition, run)` (`src/commands/cli-command.ts`) and only returns an exit code; `runCliCommand` (`cli-runner.ts`) owns the rest of the process lifecycle: the global `--env`/`--no-telemetry` flags, credential resolution and its redaction, SIGINT/SIGTERM through the context's `signal`, a closed stdout, error → exit code, and the exit itself (`exitProcessAfterFlush` in `src/process-exit.ts`: telemetry close, a stdio flush, then `process.exit`). Every MCP tool needs a CLI counterpart or an explicit exemption in `MCP_TOOL_CLI_COUNTERPARTS` (`src/commands/index.ts`); a test enforces it. An MCP tool call and a CLI command are both one observed operation (`src/utils/observed-operation.ts`), recorded once, at its real completion (`completeLater` for a run that outlives its call), through the same `capture*Call` sinks in `src/telemetry/capture.ts`; a CLI command records its MCP twin's event with `transport: "cli"`. `src/telemetry/` sends anonymous usage events to PostHog through its own batching exporter (`posthog-exporter.ts`; no SDK), scrubbing credentials and Figma identifiers first; `--no-telemetry`, `FRAMELINK_TELEMETRY=off` or `DO_NOT_TRACK` turn it off.

## Rules of the road

- **Every output field costs context budget.** Omit values an LLM can infer — emit only deviations from the default. (`strokeAlign: INSIDE` matches the CSS `border` an LLM already writes, so it's dropped; only `OUTSIDE`/`CENTER` are emitted.)
- **`@framelink/core` must stay Figma-type-free.** It consumes `NodeSnapshot`, never REST or plugin types — that's what lets both the REST adapter and the plugin feed it. Gated by `core/tests/figma-free.test.ts`; a core change that shifts output fails both the goldens and the REST↔plugin parity snapshots.
- **Generated files are never hand-edited.** `plugin/docs/authoring/flcm.md` and `src/commercial/tools/flcm-docs/examples-code.generated.ts` come from the schema via `scripts/gen-flcm-doc.ts`. Change the schema, run `pnpm docs:gen`; `docs:check` fails the build on drift.
- **The plugin preamble must stay zod-free.** It runs in QuickJS; `buildSandboxPreamble()` fails the build if zod appears anywhere in the preamble's input graph. Validation there is hand-rolled on purpose.
- **zod 4 is the root dependency.** The flcm surface uses the v4 API from `"zod"`; the older read-tool schemas still import `"zod/v3"`. Migrate those deliberately, not as a drive-by.
- **Config lives in `src/config.ts`.** The exceptions read env where it's used: `FRAMELINK_STATE_DIR`/`XDG_STATE_HOME` in `src/commercial/state-dir.ts` (the state root for link credentials, the plugin sighting, uploads and write access), the proxy variables in `src/utils/proxy-env.ts`, `NODE_ENV` in the logger, and `CI` in telemetry.
- **Write-path code goes in a commercial root, with the header.** The write path is commercial-licensed (LICENSING.md): new write-path code lives under `src/commercial/` or `plugin/` (or is added to `COMMERCIAL_PATHS`) and opens with the `LicenseRef-Framelink-Commercial` SPDX header. `pnpm check:license-headers` fails on a missing header or a header outside those roots; `--write` adds missing ones.
- **`~/` is a path alias for `src/`** (tsconfig + vitest).

## Scope

The server ingests designs for AI consumption and executes authored design edits — not image manipulation, CMS syncing, or code generation. Tools do one job with few arguments; options unlikely to change per-request are CLI arguments, not tool parameters. See CONTRIBUTING.md.

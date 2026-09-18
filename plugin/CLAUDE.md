# @framelink/plugin

The Framelink Figma plugin — hosts **flcm**, the authoring DSL for the "code mode" write path. Private workspace member; never published to npm.

- `src/preamble/` — the flcm runtime, bundled by esbuild (`index.mjs`, the one seam, which also gates zod out of the graph) into an IIFE preamble. The **server** builds it and ships it with every execute request (ADR-0010); the plugin evals it ahead of the agent's code in the QuickJS sandbox. `host.ts` is the whole host↔preamble interface — the `FlcmHost` object arriving as the parameter of the factory `index.mjs` wraps the bundle in (`eval(preamble)(host)`), so the free identifier `__flcmHost` never leaves this directory. `schema.ts` is the single source of the authoring surface (the write edge of the canonical vocabulary); types, validation, and the generated authoring doc all derive from it.
- `src/code.ts` — the plugin host (Figma main thread): sandbox setup and approval gating; it never touches the network itself, talking to the server's WS relay (`src/services/plugin-bridge/` in the repo root) via postMessage to the headless `ui.html`, which owns the WS connection.
- `build.mjs` — esbuild build of the host shell only; the preamble is not bundled here, and nothing is asserted about the output (`index.mjs` owns both ends of the one unpinnable name). Run as `pnpm build:plugin` from the repo root.
- `harness/` — live-Figma ergonomics flows (`pnpm dogfood`); not part of CI.
- `docs/authoring/flcm.md` — **generated** from the schema by the repo-root `scripts/gen-flcm-doc.ts`; never hand-edit (`pnpm docs:check` gates drift).

Tests: `pnpm test:plugin` from the repo root (node:test, not vitest).

## Private server channel (protocol 7)

`FlcmHost.callServer(capability, payload)` carries opaque JSON. The preamble closes over the host
factory parameter; only curated `flcm` verbs reach agent code. Agent code uses indirect eval so it
cannot capture the plugin's local host or transport functions.

The wire uses `{ type: "CHANNEL_REQUEST", id, runId, capability, payload }` and one response type:
`{ type: "CHANNEL_RESPONSE", id, ok: true, payload }` or
`{ type: "CHANNEL_RESPONSE", id, ok: false, error: { code, message, details?, ...extensions } }`. The UI routes these through its existing
connection envelope without interpreting them. Keep capability-specific fields out of the frame.

Failures use an open JSON object with string `code` and `message`, optional JSON `details`, and
capability-owned JSON extension fields. Object throws retain their fields; ordinary throws receive
`COMPUTATION_FAILED`. Error instances retain their message and enumerable custom fields. Failure
properties are read once and copied to plain JSON data before encoding. Cycles, non-JSON fields,
and callable serialization hooks produce `SERIALIZATION_FAILED`; hooks are never invoked. Transport refusals have their own codes, such as
`UNKNOWN_CAPABILITY`, `INVALID_INPUT`, `RUN_INACTIVE`, and `CANCELLED`; these are examples, not a
closed catalogue. Binary data uses base64 strings.

Failures cross opaquely too: the plugin forwards the server's error value on the rejection's
`detail` rather than flattening it to prose, so a future capability can ship a structured failure
with no plugin release. A handler must not await a fresh plugin request — that request queues
behind the execution suspended on the call, and both wait forever; gather evidence, compute, then
do follow-up `figma.*` work after the reply.

The server's explicit allowlist registers only `images.fetch`, taking a source array and returning
a source-to-base64 record. Image parsing and policy live in the server and preamble adapters.
The channel owns correlation, connection ownership, dead-run refusal, the four-service concurrency
cap, and the 100 MiB frame limit. Inactivity stays suspended until the last service settles, even
across run-state traffic; the absolute run ceiling never suspends. The current caller requires an
`EXECUTE_CODE` run. The frame does not constrain future callers to that request type.

Handlers receive `(payload, { signal })`. The run aborts that signal on cancellation, disconnect,
or completion. Handlers must stop starting new work and pass the signal to interruptible I/O.
The service count remains until the handler and its cleanup settle. Uninterruptible decoding may
finish internally; its result is discarded. This is cooperative cancellation, not rollback, and
there is no aggregate admission limit. Inbound size checks use raw frame bytes before JSON parsing.

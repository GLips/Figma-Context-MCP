# Payload Lab

A private, localhost-only workbench for reviewing the REST payloads Figma MCP sends to a model. Capture a design once, replay it through a committed baseline and your working tree, then inspect emitted structure, resolved fields, exact output, and cost.

## Run

From the repository root, after `pnpm install`:

```sh
pnpm payload-lab
```

Open `http://127.0.0.1:4317`. The command builds this package's React UI and starts its Hono server. It does not start an MCP server. Set `PAYLOAD_LAB_PORT` to choose another unprivileged port. The host is always `127.0.0.1`; a LAN bind is not configurable.

Set `FIGMA_API_KEY` or `FIGMA_OAUTH_TOKEN` in the repository root `.env` or export it before starting. Both the server and CLI load that same `.env`; exported variables take precedence. Restart after changing credentials. OAuth takes precedence if both are present. Credentials are never requested in the UI, returned to it, or written into captures. It uses no remote fonts, telemetry, or model APIs.

For a credential-free walkthrough, choose **Load local sample**, then **Replay capture**. This synthetic sample was copied from an agent-authored geometry fixture. It tests the workflow, not fidelity to a live design. Personally verified live captures remain the authority.

## Capture and compare

1. Paste a Figma `/design/` or `/file/` URL, optionally with `node-id`, and give the capture a name. The backend fetches the file or that single node subtree. Fetches time out after 30 seconds and stop at 32 MiB; select a smaller subtree for larger designs.
2. The library preserves the response bytes unchanged and stores metadata separately. A SHA-256 checksum is checked before replay. Captures include the canonical source URL, file key, node IDs, time, REST v1 endpoint, and file version/last-modified metadata when present. Other URL query parameters and response headers are not persisted.
3. Choose a baseline: local `main`, merge-base of `HEAD` and local `main`, `HEAD~1`, a local release tag, or a specific commit/ref. Resolved commit IDs are shown. The lab never fetches git refs; fetch them separately if needed.
4. Replay always compares that commit with an isolated snapshot of the current source tree, including uncommitted source changes. Source edits during snapshot creation cause a retryable error; edits during execution mark the result stale. Results identify their source snapshot and dependency hashes. Replay again after subsequent edits.
5. Select a node or change to synchronize the tree, field inspector, and serialized output. **Structural diff** includes emitted tables and references. **Resolved fields** expands templates and styles, including the legacy `elements` and `globalVars.styles` tables. **Repeated values** lists exact strings of at least four characters across all emitted data, with their occurrence paths.

Field moves are inferred only for a unique matching field name and value on the same node. Ambiguous cases remain additions/removals. Node moves use IDs and surviving sibling order. Raw source nodes are matched by ID; possible wire inputs are navigation hints, not automatic proof of lineage. Ancestors, collapsed SVGs, and shared tables can affect derivation. Removed nodes remain selectable.

JSON and YAML formatting-only labels compare parsed values. Tree formatting comparison preserves quoted text and line indentation while ignoring spacing between tokens. Unknown serializer changes are treated conservatively. Exact text remains available in every case. Changes to tables that preserve resolved values are representation changes, not automatically safe optimizations.

Token estimates are **UTF-8 bytes / 4, rounded up**, not a model tokenizer. Repeated-byte counts are heuristics, not guaranteed savings. Timings measure simplification and serialization only; they exclude source copying and bundling, and naturally vary. Root depth is zero. Component counts refer to component-table entries; property counts cover resolved instance values and owner definitions.

## Replay boundaries

The reusable runner is `src/server/replay.ts`; the comparison functions are in `src/shared/analyze.ts`. The UI calls the same functions as the CLI:

```sh
pnpm --silent --filter @framelink/payload-lab runner sample
pnpm --silent --filter @framelink/payload-lab runner list
pnpm --silent --filter @framelink/payload-lab runner capture 'https://www.figma.com/design/FILE/Name?node-id=1-2' 'Checkout'
pnpm --silent --filter @framelink/payload-lab runner compare CAPTURE_ID main
pnpm --silent --filter @framelink/payload-lab runner compare CAPTURE_ID commit HEAD
```

Replay supports the current REST adapter and the earlier extractor pipeline, provided the revision has the serialization wrapper and tree/JSON/YAML serializers. Historical revisions outside those contracts fail visibly. It imports the revision's pure pipeline, not the production service or server bootstrap, and uses a fresh bounded subprocess for each side. No checkout, reset, stash, dependency installation, or git hooks run during replay.

Both revisions run with locally installed dependencies. The lab includes the older extractor's `remeda@2.20.1` so current `main` can run offline. Dependency declaration differences are reported. This is a comparison of source states under recorded local dependencies, not a recreation of every released runtime. A historical revision requiring unavailable dependencies fails rather than downloading anything.

The runner rejects network, telemetry, and process-spawning modules in the pipeline import graph, blocks global fetch/WebSocket, and strips inherited environment variables from replay subprocesses. Revisions are local code you trust, not an arbitrary-code sandbox. Only an explicit Figma capture makes a remote request.

## Local data and publication

Everything private lives under the root `.payload-lab/`, which is gitignored:

- `captures/<uuid>/response.json`: unchanged response bytes, mode 0600.
- `captures/<uuid>/metadata.json`: safe capture metadata, mode 0600.
- `runs/`: temporary source snapshots and outputs, removed after success or failure.

Deleting a capture removes it from this local library. A process crash can leave a temporary run directory; it is safe to remove when no replay is running. Capture names never become paths. HTTP mutations require the same origin, foreign hosts/origins are rejected, and responses are not cached.

This package is private and absent from root production dependencies, build entries, and published files. The root `build` command does not build it. `prepack` runs the production build followed by the tarball verifier; packing inside the verifier disables lifecycle scripts to avoid recursion.

```sh
pnpm test:payload-lab
pnpm --filter @framelink/payload-lab typecheck
pnpm --filter @framelink/payload-lab build
pnpm check:package
```

`check:package` builds the production application and inspects an actual npm tarball, rejecting lab paths, bundled lab content, captures, and lab-only published dependencies. `node scripts/verify-package-boundary.mjs --no-build` inspects already-generated artifacts; it does not certify that a production build succeeded. Negative tests exercise the same verifier with deliberately contaminated entries.

Plugin/code-mode inspection, model calls, arbitrary two-sided comparisons, hosting, and history sliders are outside V1.

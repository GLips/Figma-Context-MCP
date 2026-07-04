# Headless DSL harness — port-free dogfooding

Runs code-mode DSL files against an in-memory `figma` mock in pure Node — **no plugin, no WS port** —
so any session can validate the DSL while another session holds the live connection (we have a
single-live-session constraint: the MCP server binds one WS port from the block (see `src/services/plugin-bridge/ports.ts`) per process).

```
node plugin/harness/dogfood.mjs <file.js>
# or
pnpm --filter @framelink/plugin dogfood harness/scenarios/settings-panel.js
```

It prints a compact tree (type / name / size / layout / text / fills) plus captured `console` output
and the file's return value, so a tester can eyeball correctness without pixels.

## It runs the REAL preamble — not a fork

`dogfood.mjs` esbuild-bundles `src/preamble/index.ts` fresh each run to get the actual
`SANDBOX_PREAMBLE`, then executes the file in the same `(async function(){ PREAMBLE; code })()` shape
as `executeCode` in `code.ts`. So a green run validates the real `frame`/`text`/`defineComponent`/
`override`/`find`/`hex`/reconcile/guards — if a fragment changes, the harness changes with it.

## What the mock DOES model (faithful enough to trust a green run)

- Node creation, auto-parenting (roots stay on the page, children reparent on append).
- **Auto-layout sizing**: hug / fixed / fill, including the cross-axis rule (`layoutAlign STRETCH` +
  `primaryAxisSizingMode FIXED` when the filled dimension is the child's own primary axis).
- `layoutMode`, primary/counter align + sizing modes, padding, itemSpacing, `resize`.
- Fills / strokes / opacity / cornerRadius; `fontName` / `loadFontAsync` / `figma.mixed`.
- `getNodeById` / `getNodeByIdAsync`; `setPluginData` / `getPluginData`.
- `createComponentFromNode` → `createInstance`, with instance sublayers keyed by the real
  **composite-id format** `I<instanceId>;<mainChildId>` and resolvable via `getNodeById` — so
  `override()` and the reconcile diff exercise their true code paths.
- `findAll` / `findAllWithCriteria`; component `key` / `remote`.
- **Shapes**: `createEllipse` / `createLine` / `createPolygon` / `createStar` with intrinsic default
  sizes; **richer fills** (gradient paints with computed `gradientTransform`, image paints via
  `createImage` / `base64Decode`); **effects** (`shadow`/`blur` → effects array); `clipsContent`.

## What it does NOT model (live check still required for these)

- **Real font metrics / text wrapping.** Text width is a crude `chars × fontSize × 0.55` estimate and
  line wrapping is approximate — pixel-exact layout and any text-fit question need the live plugin.
- **Actual rendering / screenshots.** No `exportAsync`; use `get_screenshot` live to see real pixels.
- **The return envelope.** The harness returns raw JS; it does NOT pass through `safeSerialize`
  (`../src/serialize.ts`), so it does **not** reproduce the live-node collapse (a live `SceneNode` →
  `{id,name,type}`). Handles and read POJOs round-trip whole through `safeSerialize` anyway, but a returned
  live node behaves differently live — verify that behavior with the plugin.
- **Real component-property / variant features** (`addComponentProperty`, `componentPropertyDefinitions`,
  variant sets), constraints, effects rendering.
- **Timing / backend behavior** — the live `getNodeByIdAsync` backend-fetch flakiness, font load
  latency, etc. The mock resolves everything instantly and locally.

Rule of thumb: trust the harness for **logic, structure, composition, overrides, errors**; go live for
**pixels, fonts, screenshots, and the serialization envelope**.

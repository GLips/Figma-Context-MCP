# `preamble/` — the `flcm` std-lib

This directory is the sandbox std-lib that rides inside every `execute_code` call. Each fragment is a
**real typed ES module**; `index.mjs`'s `buildSandboxPreamble()` esbuild-bundles them into one string,
`SANDBOX_PREAMBLE`, which `code.ts` prepends to the agent's code inside the wrapping
`(async function(){ … })()`.

## Two layers: typed modules at authoring time, one IIFE at runtime

The fragments are authored as ordinary ES modules — they `import` helpers from each other by name and
`export` what they expose. Because they sit under `tsconfig`'s `include: ["src"]`, **`tsc --noEmit`
(`pnpm typecheck`) checks the actual shipped JS.**

The sandbox itself is QuickJS with **no module system**. So `buildSandboxPreamble()` runs esbuild to
bundle `runtime.ts` at **`format: 'iife'` + `globalName: 'flcm'`**. That wraps the whole module graph
in one IIFE that assigns a single `flcm` global. The agent calls `flcm.frame(...)`,
`await flcm.render(...)`, etc.

### Why this gives clean, prefix-free internals

Only the names `runtime.ts` re-exports become members of the `flcm` global. Every other
declaration — `toFigmaPaint`, `buildFrame`, `parseFill`, the boundary parsers — is reachable from those
roots (so esbuild keeps it in the bundle) but stays **closure-private inside the IIFE**. It is invisible
to, and uncollidable with, the agent's code that runs in the same eval scope. So **internal helpers use
plain names with no collision-safety prefix** — the closure is the namespace a module system would
otherwise provide.

> This replaced an earlier `format: 'esm'` bundle that emitted bare top-level declarations sharing one
> flat scope with the agent's code, which is why internals used to carry a `__cm*` prefix. The only
> thing that forced `esm` was a module-level top-level `await` (the font preload). The inert-spec model
> removed that need — see below — so the IIFE became possible, and the prefix unnecessary.

### No top-level await

Constructors (`flcm.frame`, `flcm.text`, …) build **inert POJO `WriteNode`s** and touch nothing live.
Only `flcm.render()` creates Figma nodes, and it's `async` — so the font preload
(`loadFontsForTree()` in `fonts.ts`, which awaits `listAvailableFontsAsync` + `loadFontAsync`) runs at
the top of `render()`, not at module top level. With no TLA to preserve, the synchronous IIFE bundle is
free, and any modern esbuild target works.

## The modules and their dependencies

esbuild derives concatenation order from the `import` edges — there is no manual order array. The graph
is a clean DAG: `ir` (types) ← `paint`/`effects` (typed constructors + mappers) ← `css` (the string
boundary) ← `flcm` (sugar) → `bridge` (typed walk).

| File | Covers | Imports from |
| --- | --- | --- |
| `ir.ts` | the typed `WriteNode` **currency** types: `PaintSpec`/`EffectSpec` discriminated unions, typed layout/text leaves (numbers, edges, terse-intent enums), `WriteType` allow-list. No logic | — |
| `paint.ts` | typed paint: `solid`/`linearGradient`/`radialGradient` constructors (the grounded 2×3 transform math, one home), `toFigmaPaint` mapper. No strings | `ir` |
| `effects.ts` | typed effects: `shadow`/`layerBlurFromCssPx`/`backgroundBlurFromCssPx` constructors (blur×2 lives in the `*FromCssPx` names), `toFigmaEffects` mapper. No strings | `ir` |
| `css.ts` | **THE string boundary — the only module that knows CSS syntax exists.** Color (#hex/rgba), gradient-string, and effect-string parsers; `parseFill`/`parseCssEffects`; `length`/`lineHeight`/`letterSpacing` coercions. Emits the typed currency | `ir`, `paint`, `effects` |
| `fonts.ts` | `loadFontsForTree()` → a `FontMap` render threads on the ctx (no module state); `listAvailableFontsAsync` nearest-style snap; `resolveFont` | `ir` |
| `bridge.ts` | the ONE mutation authority: exported appliers (paint/container/sizing/fill-intent/cover/position/constraints/percents) that every mutating verb drives against a live node — the render walk (`WriteNode` → live nodes, `BUILDERS` table) is its create-side caller, edit resolves targets into the same appliers, never a parallel path; the one terse→plugin enum map set; `handle`. **Consumes the typed currency only — never imports `css`** | `ir`, `paint`, `effects`, `fonts` |
| `flcm.ts` | the public namespace: typed-Props constructors (terse→`WriteNode`), `render`, `gradient`/`effects` sugar (build the typed currency **directly**, no string round-trip) | `ir`, `paint`, `effects`, `css`, `fonts`, `bridge` |
| `runtime.ts` | bundle entry — re-exports the public verbs (and only those) | `flcm` |

## The currency boundary: CSS at the edges, typed inside

`WriteNode` (`ir.ts`) is the **single typed currency** the whole preamble speaks — every leaf is a real
type (a number, a typed edge box, a `PaintSpec`/`EffectSpec`), never a CSS string. The sugar (`flcm.ts`)
compiles terse props straight into it; the bridge reads it and drives the plugin API. Nothing between
them parses or re-serializes a string.

CSS strings exist for read↔write unity with figma-mcp's `SimplifiedNode` (an agent reads a node as
CSS-string-bearing JSON and writes it back), but that unity only matters at the **agent I/O boundary**.
So CSS-string parsing is quarantined to `css.ts` — the one module that knows the syntax. Authors write
CSS-shaped leaves (a `#hex` color, a `linear-gradient(...)` string, a `"32px"` metric); `css.ts` parses
each **once, at construction**, into the typed currency. A future `get`-result port would rebuild
through the constructors (the one validated compile — render refuses IR they didn't mint), so the
port promise is "SimplifiedNode maps mechanically onto constructor calls," not "render it
string-for-string." (See `docs/adr/0001-…`.)

## Phase-1 scope (this build)

Create/render only: `frame`/`text`/`rect`/`ellipse`/`line` + `render`, plus the `gradient`/`effects`
sugar. Author leaves: solid color (#hex / rgba()), **gradient strings** (`linear-gradient` /
`radial-gradient`, parsed against a documented subset, fail-loud outside it) or the `flcm.gradient()`
sugar, and **effect strings** (`box-shadow` / `filter:blur` / `backdrop-filter:blur`) or the
`flcm.effects()` sugar — all normalized to the typed currency. **read/edit, components, prototype,
images, rich text are deliberately absent.** The gradient-transform math is grounded live and the blur×2
factor mirrors figma-mcp's effects transformer; see `../../findings.md` (Round 2) and
`docs/plans/2026-06-30-plan-feat-flcm-dsl-rebuild.md`.

## QuickJS envelope

The bundled IIFE runs in QuickJS as a function-body statement (eval'd inside `code.ts`'s async IIFE).
No `import`/`export` reaches the runtime (esbuild strips them) and there is no top-level await. The
host-side return-path guard (`guardReturnValue`) and `safeSerialize` live in `../serialize.ts` (imported by
`code.ts`) — they're pure TS host code, not sandbox source, so they unit-test without a figma mock.

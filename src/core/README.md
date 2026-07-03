# Simplify core

The pure transform at the center of Framelink: plan-neutral `NodeSnapshot`s in,
canonical `SimplifiedNode`s out. Adapters (`src/adapters/rest/`, and the future
plugin adapter) decode their wire format into snapshots; this module owns every
raw→CSS conversion, so the transform can never fork between producers.

The whole graph reachable from `index.ts` is bundle-pure — no Node builtins, no
external packages — because it ships into the Figma plugin's QuickJS sandbox.
Two CI gates enforce this: `core-figma-free.test.ts` (no REST types) and
`core-purity.test.ts` (esbuild `platform:'neutral'` probe).

## Entry point

```typescript
import { simplify } from "figma-developer-mcp";

// Expanded output (default): every style value inline, no refs, no crypto
const { nodes } = await simplify(snapshots);

// Egress form: deduplicated style refs + templates (what the REST tool ships)
const { nodes, styles, templates } = await simplify(snapshots, { compress: true });
```

`simplify` is async: it awaits an injectable cooperative-yield scheduler
(`options.scheduler`) so servers can keep heartbeats live on large files.
Callers without that need just await the promise.

## Layers

1. `simplify.ts` — the whole spine: the entry picks a style table, then a
   single-pass walk extracts geometry/layout, text, visuals, and component data
   from each node (and collapses SVG-heavy containers bottom-up)
2. `style-table.ts` — where the walk interns style values; the table decides
   inline emission (expanded) vs content-addressed refs (compressing)
3. `compress.ts` — opt-in egress compression: count-gated style hoisting +
   element templates (needs whole-tree counts, so it runs after the walk)
4. `transformers/` — pure per-property conversions (layout, text, style, effects)

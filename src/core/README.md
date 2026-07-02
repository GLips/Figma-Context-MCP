# Canonicalize core

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
import { canonicalize, allExtractors } from "figma-developer-mcp";

// Expanded output (default): every style value inline, no refs, no crypto
const { nodes } = await canonicalize(snapshots);

// Egress form: deduplicated style refs + element templates (what the REST tool ships)
const { nodes, globalVars, elements } = await canonicalize(snapshots, { compress: true });
```

`canonicalize` is async: it awaits an injectable cooperative-yield scheduler
(`options.scheduler`) so servers can keep heartbeats live on large files.
Callers without that need just await the promise.

## Composable extractors

Extraction is a single tree walk applying composable extractors per node:

- `layoutExtractor` — positioning, sizing, flex/grid properties
- `textExtractor` — text content and typography styles
- `visualsExtractor` — fills, strokes, effects, opacity, borders
- `componentExtractor` — component instance/definition data

Combinations: `allExtractors` (default), `layoutAndText`, `contentOnly`,
`visualsOnly`, `layoutOnly`.

```typescript
import type { ExtractorFn } from "figma-developer-mcp";

const designSystemExtractor: ExtractorFn = (node, result, context) => {
  if (node.name.startsWith("DS/")) {
    result.dsCategory = node.name.split("/")[1];
  }
};

const data = await canonicalize(snapshots, {
  extractors: [...allExtractors, designSystemExtractor],
  maxDepth: 3,
  nodeFilter: (node) => node.type !== "SECTION",
});
```

## Layers

1. `canonicalize.ts` — the entry: picks a style sink, walks, optionally compresses
2. `node-walker.ts` — single-pass traversal applying extractors per node
3. `style-sink.ts` — where extractors register style values; the sink decides
   inline emission (expanded) vs content-addressed refs (compressing)
4. `finalize.ts` — opt-in egress compression: count-gated style hoisting +
   element templates (needs whole-tree counts, so it runs after the walk)
5. `transformers/` — pure per-property conversions (layout, text, style, effects)

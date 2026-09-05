# Simplify core

`@framelink/core` — the pure transform at the center of Framelink: plan-neutral
`NodeSnapshot`s in, canonical `SimplifiedNode`s out. Both adapters (the root
package's `src/adapters/rest/`, and the plugin's `node-to-snapshot.ts`) decode
their own wire format into snapshots; this package owns every raw→CSS
conversion, so the transform can never fork between producers.

It is a private workspace member, never published on its own. Both consumers
depend on it and it depends on neither — that one-way shape is the point, and
it is why this package declares no dependencies at all.

The whole graph reachable from `src/index.ts` is bundle-pure — no Node builtins,
no external packages — because it ships into the Figma plugin's QuickJS sandbox.
Two gates in `tests/` enforce this: `figma-free.test.ts` (no REST types) and
`bundle-purity.test.ts` (esbuild `platform:'neutral'` probe).

## Entry point

```typescript
import { simplify } from "@framelink/core";

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
4. `transformers/` — pure per-property conversions (layout, text, style, effects, component)

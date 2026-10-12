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
import { simplify, project } from "@framelink/core";

// Stage 1 — the walk: the expanded runtime tree, every style value inline
const full = await simplify(snapshots);

// Stage 2 — egress projection: depth cuts, deduplicated style refs + templates (what the REST tool ships)
const { nodes, styles, templates } = project(full, { compress: true, maxDepth });
```

`simplify` is async: it awaits an injectable cooperative-yield scheduler
(`options.scheduler`) so servers can keep heartbeats live on large files.
Callers without that need just await the promise. Its result always carries
empty `styles`/`templates`; only `project` fills them.

## Layers

1. `simplify.ts` — the walk: a single pass extracts geometry/layout, text,
   visuals, and component data from each node (and collapses SVG-heavy
   containers bottom-up). It records producer facts in `read-context.ts` for
   the projection stage.
2. `project.ts` — the egress projection: picks the style table, applies
   `maxDepth` and `elided` cuts, and runs compression. Never mutates its input.
3. `style-table.ts` — where `project` interns style values; the table decides
   inline emission (expanded) vs content-addressed refs (compressing)
4. `compress.ts` — opt-in egress compression: count-gated style hoisting +
   element templates (needs whole-tree counts, so it runs over the projected tree)
5. `transformers/` — pure per-property conversions (layout, text, style, effects, component)

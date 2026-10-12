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
import { compressDesign } from "@framelink/core/compress";

// Stage 1 — the walk: the expanded runtime tree, every style value inline
const full = await simplify(snapshots);

// Stage 2 — egress projection: wire admission, depth cuts, the components sidecar, still inline
const wire = project(full, { maxDepth });

// Stage 3 — REST only: hoisted shared styles + templates (what the REST tool ships)
const { nodes, styles, templates } = compressDesign(wire);
```

`simplify` is async: it awaits an injectable cooperative-yield scheduler
(`options.scheduler`) so servers can keep heartbeats live on large files.
Callers without that need just await the promise. Its result always carries
empty `styles`/`templates`, as does `project`'s; only `compressDesign` fills them.

Compression is its own entry (`@framelink/core/compress`) and the only importer of
`sha1.ts`, so the plugin preamble — which never compresses — bundles neither
(ADR-0004). The preamble build refuses either module.

## Layers

1. `simplify.ts` — the walk: a single pass extracts geometry/layout, text,
   visuals, and component data from each node (and collapses SVG-heavy
   containers bottom-up). It records producer facts in `read-context.ts` for
   the projection stage.
2. `project.ts` — the egress projection: applies wire admission, `maxDepth`
   and `elided` cuts, and the components pass. Never mutates its input.
3. `compress.ts` — REST egress compression: content-addressed interning,
   count-gated style hoisting + element templates (needs whole-tree counts, so
   it runs over the projected tree)
4. `transformers/` — pure per-property conversions (layout, text, style, effects, component)

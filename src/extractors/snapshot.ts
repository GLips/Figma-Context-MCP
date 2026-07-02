/**
 * `NodeSnapshot` — the plan-neutral, core-owned INPUT to `canonicalize`.
 *
 * This is the raw structural form the transform consumes: the wire encodings are
 * decoded (text as runs, uniform image ref, normalized gradient, resolved
 * style/component metadata, no top-level tables), but the values are still raw
 * (RGBA floats, numeric sizes, raw layout traits) — CSS conversion + dedup is
 * `canonicalize`'s sole job, never an adapter's (Invariant 5). One core, two
 * producers: `restNodeToSnapshot` (server) and `sceneNodeToSnapshot` (plugin,
 * out of scope here) both feed this identical shape (Invariant 2).
 *
 * IMPORTANT: this type is deliberately a *structural subset* of a Figma
 * `Node` for the ~1:1 fields (same names, compatible value types), so raw Figma
 * nodes remain assignable during the incremental carve. It carries NO
 * `@figma/rest-api-spec` import — the core module graph must stay Figma-free
 * (Invariant 2 / Phase 1 Done-when). The type grows one concern at a time as
 * each transformer migrates off Figma types onto the snapshot.
 */
export interface NodeSnapshot {
  id: string;
  name: string;
  /** Raw Figma node type (e.g. FRAME, TEXT, VECTOR). The walker maps VECTOR→IMAGE-SVG. */
  type: string;
  visible?: boolean;
  /**
   * Component-property references (e.g. `{ visible: "Show Badge#341:0" }`). The
   * walker reads `visible` to rescue hidden nodes inside component definitions;
   * the component extractor simplifies the rest.
   */
  componentPropertyReferences?: Record<string, string>;
  children?: NodeSnapshot[];
}

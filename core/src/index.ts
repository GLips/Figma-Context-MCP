// Types
export type {
  NodeCounter,
  NodeDelta,
  SimplifiedComponentEntry,
  SimplifiedDesign,
  SimplifiedNode,
  WarningRecord,
  StyleRefPrefix,
  TraversalOptions,
  WalkScheduler,
  StyleValue,
  TemplateBody,
} from "./types.js";
// Canonical layout vocabulary — the flattened per-axis sizing union and the
// container-config shape. Re-exported here so consumers (the plugin's slim
// read projection) source them from the core barrel, not a deep path.
export type { SimplifiedDimension, SimplifiedLayout } from "./transformers/layout.js";
// Beyond-CSS effect object forms — re-exported so the plugin sources them from the barrel for the
// read↔create symmetry guard (see plugin effects.test.ts).
export type {
  SimplifiedGlass,
  SimplifiedNoise,
  SimplifiedTexture,
  SimplifiedProgressiveBlur,
} from "./transformers/effects.js";

// The rounding every emitted number passes through. Exported from the barrel so the plugin's write side
// (render's handle geometry) rounds identically to the read side — one numeric currency at the agent edge.
export { pixelRound } from "./utils.js";

// Figma's "container parent" exception, exported from the barrel for the same reason:
// the plugin adapter and the REST adapter must agree on which node types their children's
// coordinates skip, or the two producers place every group child differently.
export { isCoordinateTransparentType } from "./utils.js";

// Both producers place children of a rotated container with this; forking it puts every child
// of a tilted group in a different spot on each side.
export { rotateIntoParentFrame } from "./utils.js";

// Box arithmetic, shared by both directions: read asks whether a grid's children overlap, write asks how
// much of a render root landed on its page neighbours. One implementation, so the two agree on the edge
// case that matters — boxes that merely touch are not overlapping.
export { rectIntersectionArea, rectsOverlap, anyRectsOverlap } from "./rect.js";

// Figma's per-axis sizing flag → the canonical fill/hug/fixed word. Exported for the plugin's write side,
// which reports a rendered node's sizing intent (bridge.intentOf) off the live node: resolveAxisDimension
// takes the fill/hug word straight from this mapper, so sourcing it here rather than re-deriving it is what
// makes render's `intent` and find's `width`/`height` the same answer by construction.
export { convertSizing } from "./transformers/layout/common.js";

// Full runtime reads; project owns the wire representation.
export { simplify } from "./simplify.js";
export type { PlacementContext, SimplifyOptions, SimplifyResult } from "./simplify.js";

// Which components a read needs definitions for, under the same admission rule projection applies.
export { offTreeComponentIds } from "./off-tree.js";
export type { OffTreeScope } from "./off-tree.js";

// The REST adapter hashes text styles with this; two producers stringifying differently would
// emit different style refs for identical styling.
export { stableStringify } from "./utils.js";

export type { SimplifiedFill } from "./transformers/style.js";

// The read's value spellings, applied to a token's value outside any node: the plugin's
// flcm.designTokens lists a style's paints, effects or text style exactly as a read of a node
// carrying that style would spell them.
export { foldPaintStack } from "./transformers/style.js";
// One paint as a read spells it: the plugin's write verification compares a paint it asked for with
// the one the canvas holds at exactly the read's precision.
export { parsePaint } from "./transformers/style.js";
export { formatSolidColor } from "./transformers/style/color.js";
export { simplifyEffectStack } from "./transformers/effects.js";
export type { SimplifiedEffects } from "./transformers/effects.js";
export { simplifyLiteralTextStyle } from "./transformers/text.js";
export type { SimplifiedTextStyle } from "./transformers/text.js";

// Token references are one vocabulary for both directions: the read emits them, the plugin's write
// side recognizes the same shape when a read is pasted back.
export type { StyleReference, TokenIdentity, TokenReference, VariableReference } from "./tokens.js";
export {
  isStyleReference,
  isVariableReference,
  styleReference,
  variableReference,
} from "./tokens.js";

// Deliberately absent: compression. It is REST-only egress, so it ships from its own entry
// (`@framelink/core/compress`) the plugin preamble never imports — see compress.ts.

export { project, projectReadNode, isElision } from "./project.js";
export type { ProjectOptions } from "./project.js";
export type { Elision } from "./types.js";

export { projectNames } from "./project-names.js";

// Instance sublayer ids are read by core's component diff and built by the plugin's override and
// selection code — one grammar for both.
export {
  componentPath,
  definitionId,
  guidOf,
  isSublayerId,
  isNodeIdShaped,
  liveSublayerId,
  outermostInstanceId,
  sublayerPrefix,
} from "./instance-path.js";

// One pin→node guess for both the REST comments tool and the plugin's read counts, so they agree on
// which node a comment thread belongs to.
export { hitTestCommentPin } from "./comment-pin.js";
export type { CommentPinGeometry } from "./comment-pin.js";

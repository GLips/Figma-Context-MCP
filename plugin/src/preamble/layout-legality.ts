/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// layout-legality — the ONE home for "can this node realize these layout words". Every rule that
// decides a layout word's legality lives here, and BOTH verbs consult it — create via flcm.ts
// (buildLayout, render's root check) and the bridge walk, edit via assertLayoutDeltaResolvable —
// so the two cannot answer differently (ADR-0003: a word that would do nothing must reject loud,
// in every verb). Pure and figma-free by charter: rules take the authored WriteLayout plus any
// live facts as scalar values, because the callers know them from different places — the create walk
// answers from the authored node (before the node or its parent's sizing modes exist), edit from
// the live flags. A rule that needs a fact neither side can state this way doesn't belong here.
//
// Convention: `subject` (the rejecting verb's name for the error prefix) is always the LAST
// parameter. The parent-relative rules judge a built tree's interior in the verb's GATE
// (bridge.assertBuiltInteriorLegal), from the same authored-parent facts the build walk derives
// (childFlowFactsOf), so a bad child refuses with zero writes. Accepted cost: it pays prepare's
// font/image loads before rejecting.
import { AXES, effectiveLayoutMode, type LayoutMode } from "./layout-mode.js";
import { WriteLayout, isTokenRef, type Bindable } from "./ir.js";

// The live parent-flow facts the percent rule needs — edit reads them off the canvas
// (bridge.parentHugFacts), create derives them from the authored parent node.
export interface ParentFlowFacts {
  mode: LayoutMode;
  hugW: boolean;
  hugH: boolean;
}

// Node-local legality: the type, the words, and whether the node will be a auto-layout container
// after this call. `liveMode` is the one fact only edit can supply (a delta that doesn't
// name a mode inherits the live one); create passes undefined — the authored mode decides, and a
// node with no mode is never a container. `willBeAuto` is derived here, not passed, so a caller
// can't hand in a value that contradicts the very layout it also passes.
export function assertLayoutRealizableForType(nodeType: string, wl: WriteLayout, liveMode: "HORIZONTAL" | "VERTICAL" | "NONE" | "GRID" | undefined, subject: string, liveWrap = false): void {
  const mode = effectiveLayoutMode(wl, { layoutMode: liveMode });
  const willBeAuto = mode.kind !== "free";
  if (wl.alignItems === "baseline" && mode.word !== "row") {
    throw new Error(subject + ': layout.alignItems "baseline" requires layout.mode "row" (horizontal auto-layout).');
  }
  const effectiveMode = mode.word;
  if ((wl.gridTemplateColumns || wl.gridTemplateRows) && effectiveMode !== "grid") throw new Error(subject + ": grid templates require layout.mode grid.");
  if (effectiveMode === "grid") {
    if (nodeType === "SLOT") throw new Error(subject + ": Figma does not support GRID on slots.");
    if (wl.wrap !== undefined || wl.justifyContent || wl.alignItems) throw new Error(subject + ": grid uses child justifySelf/alignSelf; wrap, justifyContent and alignItems require row/column.");
    // Negative space: grid gaps don't bind variables — the contract scopes gap binding to flex.
    if (gapSides(wl.gap).some(isTokenRef)) throw new Error(subject + ": a grid gap can't bind a variable; give a number. Variables bind flex (row/column) gaps.");
    if (gapSides(wl.gap).some((v) => (v as number) < 0)) throw new Error(subject + ": grid gaps must be non-negative.");

  }
  const wraps = wl.wrap ?? liveWrap;
  if (wraps && effectiveMode !== "row") throw new Error(subject + ': layout.wrap requires layout.mode "row"; disable wrap in the same call before changing direction.');
  if (isGapPair(wl.gap) && !wraps && effectiveMode !== "grid") throw new Error(subject + ': unequal row/column gaps require layout.wrap: true on a horizontal row.');
  const rowGap = isGapPair(wl.gap) ? wl.gap.row : wl.gap;
  if (wraps && typeof rowGap === "number" && rowGap < 0) throw new Error(subject + ": wrapped row gap must be non-negative.");
  const s = wl.sizing || {};
  if ((s.horizontal === "hug" || s.vertical === "hug") && !willBeAuto && nodeType !== "TEXT") {
    // The remedy is type-gated: `layout` is a FRAME-only word, so prescribing a mode to a shape
    // would send the author straight into an unknown-prop reject.
    throw new Error(
      subject + ': "hug" sizes to content, which only an auto-layout (row/column/grid) container or text can measure — a ' +
        nodeType + " without auto-layout has no content size. " +
        (nodeType === "FRAME" || nodeType === "INSTANCE"
          ? 'Use pixel dimensions, or set layout: { mode: "row"|"column" } in the same call.'
          : "Use a pixel size (only a row/column frame or a text can measure content)."),
    );
  }
  // A TEXT that hugs its width also grows its height (Figma has no auto-width, fixed-height text
  // box), so a fixed height beside width "hug" could only land by silently freezing the width.
  // sizing.vertical is the carrier to key on: the compile writes "fixed" beside every numeric AND
  // percent height (ir.ts percentSize contract).
  if (nodeType === "TEXT" && s.vertical === "fixed" && s.horizontal === "hug") {
    throw new Error(
      subject + ': a TEXT that hugs its width also follows its content in height — a fixed height needs a fixed, "fill" or "N%" width beside it, or drop the height.',
    );
  }
  if ((wl.gap != null || wl.padding || wl.justifyContent || wl.alignItems) && !willBeAuto) {
    // The "none" branch must hold for an AUTHORED none and for create's omitted-mode default
    // alike — naming a mode the author never wrote reads as someone else's error.
    throw new Error(
      subject + ": layout gap/padding/justifyContent/alignItems need an auto-layout (row/column/grid) container — " +
        (wl.mode === "none"
          ? 'mode "none" (which is also the default when layout.mode is omitted) leaves this frame free-form'
          : "this " + (nodeType === "INSTANCE" ? "instance" : "frame") + " isn't one") +
        '. Name layout: { mode: "row" } (or "column") in the same call.',
    );
  }
}

// "fill" and "N%" resolve against a parent frame's bounded size, and a page has none. `isRoot` is
// flcm.component's root check, which judges a root before it has a destination; every other caller
// judges a node against the page it lands under.
export function assertSizingResolvesAgainstParentFrame(wl: WriteLayout, isRoot: boolean, subject: string): void {
  const s = wl.sizing || {};
  if (s.horizontal === "fill" || s.vertical === "fill" || wl.percentSize || wl.percentPos) {
    throw new Error(
      subject + ': "fill" and "N%" resolve against a parent frame, and ' +
        (isRoot ? "the root node's" : "this node's") + " parent is the page" +
        " — a page has no bounded size. Use pixel dimensions, or " +
        // isRoot doubles as the verb tell: only flcm.component's root check passes true, so the
        // remedy can speak to a node being authored vs one already on the canvas.
        (isRoot ? "nest the node inside a frame." : "move the node into a frame first."),
    );
  }
}

// The one way past that rule: a read root's `"fill"` axis carries the px it measured where it was
// read (WriteLayout.designedSize), and on a page that becomes a fixed size. Callers fold BEFORE the
// rule and hand the result to the appliers too. An axis with no designed size stays "fill" and rejects.
export function foldDesignedSizeForPage(wl: WriteLayout): WriteLayout {
  const designed = wl.designedSize;
  if (!designed) return wl;
  const out: WriteLayout = { ...wl, sizing: { ...wl.sizing }, dimensions: { ...wl.dimensions } };
  delete out.designedSize;
  if (designed.width != null && out.sizing!.horizontal === "fill") { out.sizing!.horizontal = "fixed"; out.dimensions!.width = designed.width; }
  if (designed.height != null && out.sizing!.vertical === "fill") { out.sizing!.vertical = "fixed"; out.dimensions!.height = designed.height; }
  return out;
}

// TEXT height:"fill" is realized by the parent's flow (layoutGrow/STRETCH). Out of flow — a
// free-form parent, or absolute positioning — it falls to coverChild's resize, which a text node
// in WIDTH_AND_HEIGHT ignores: the height silently doesn't stick, so reject instead.
// Self-triggering (type + words checked here, not at the call sites), so widening the trigger
// can never happen on one verb and not the other.
export function assertTextFillHeightInFlow(nodeType: string, wl: WriteLayout, parentIsAuto: boolean, isAbsolute: boolean, subject: string): void {
  if (nodeType !== "TEXT" || (wl.sizing || {}).vertical !== "fill") return;
  if (!parentIsAuto || isAbsolute) {
    throw new Error(
      subject + ": a TEXT can only fill its height as an in-flow child of an auto-layout parent — " +
        "out of flow nothing supplies that height. Set `width` (the height follows the wrap), give it a numeric height, or place it in-flow in an auto-layout frame.",
    );
  }
}

// Reject the ONE percent case a runtime read can't break: an IN-FLOW `%`-SIZE child of an
// auto-layout parent that HUGS the same axis. The child's size both defines the hug and depends
// on it — a true cycle, so fail loud rather than snapshot a bogus number. Everything else
// resolves against the parent's realized size (bridge resolvePercentLayout): a fixed/`fill` auto
// parent, ANY free-form parent, and an ABSOLUTE child (out of flow — it doesn't feed the hug).
export function assertPercentResolvable(childLayout: WriteLayout, facts: ParentFlowFacts, subject: string): void {
  const ps = childLayout.percentSize;
  if (!ps) return;
  if (facts.mode.kind === "free" || childLayout.position === "absolute") return;
  if (facts.mode.kind === "grid") throw new Error(subject + ': percent sizes on in-flow GRID children need cell geometry; use fixed pixels or "fill", or position the child absolutely.');
  if ((ps.width != null && facts.hugW) || (ps.height != null && facts.hugH)) {
    throw new Error(
      subject + ': a percent w/h ("N%") on an in-flow child of an auto-layout (row/column/grid) parent that HUGS that axis is a cycle — ' +
        'the child\'s size both sets and depends on the parent\'s. Give the parent a fixed or "fill" size on that axis, use "fill"/"hug" on the child, or lift it out of the flow with `left`/`top`.',
    );
  }
}

// A LINE is a length and nothing else: `width` IS that length, and there is no height to speak of.
// The one non-numeric length Figma realizes is FILL under a row or column — the commonest line in
// any design is a divider spanning its column — where the parent's flow supplies the number.
// Out of flow nothing would, so the refusal stands there.
export function assertLineSizingInFlow(nodeType: string, wl: WriteLayout, parentMode: LayoutMode, isAbsolute: boolean, subject: string): void {
  if (nodeType !== "LINE") return;
  const s = wl.sizing || {};
  if (s.vertical !== undefined) {
    throw new Error(subject + ": a LINE has no height — it is a length along its `width` alone. Rotate it 90° to stand it up.");
  }
  if (s.horizontal === "fill" && (parentMode.kind !== "flow" || isAbsolute)) {
    throw new Error(subject + ': a LINE fills only as an in-flow child of a row or column, where the parent supplies the length. Give it a numeric `width` here.');
  }
}

// A rotated LINE cannot fill. The parent's flow resolves "fill" along ITS OWN axis and the rotation
// composes after that sizing, so a filling line rotated 90° in a row comes out as long as the row
// and standing across it — the vertical divider nobody can get this way, because a LINE has no
// height for the cross axis to supply. Refusal rather than translation: nothing in Figma renders the
// intent, and the honest construction is a 1px-wide RECTANGLE with height: "fill".
// Self-triggering on type, like the rules above; the callers state the EFFECTIVE fill and rotation
// (authored word, else the live node's) so neither verb can be the one that forgets.
export function assertLineFillUnrotated(nodeType: string, fillsWidth: boolean, rotation: number | undefined, subject: string): void {
  if (nodeType !== "LINE" || !fillsWidth || !rotation) return;
  throw new Error(
    subject + ': a rotated LINE cannot use width: "fill" — the parent\'s flow supplies the length along its OWN axis, and the rotation turns that length across it. ' +
      "Give this line a numeric `width`, or build a rule across the parent's flow as a RECTANGLE 1px wide with height: \"fill\" (no rotation).",
  );
}

/** FLEX needs a bounded axis. Template edits cannot silently change a live HUG into FIXED. */
export function assertGridSizing(layout: WriteLayout, live: {
  layoutMode?: string;
  layoutSizingHorizontal?: string;
  layoutSizingVertical?: string;
  gridColumnSizes?: readonly { type: string }[];
  gridRowSizes?: readonly { type: string }[];
} | undefined, subject: string): void {
  if (effectiveLayoutMode(layout, live).kind !== "grid") return;
  // Figma flows a grid row-wise, so the columns are the axis no one can infer. Rows are implicit
  // (hug tracks, one per row the children need) until a template names them.
  if (live?.layoutMode !== "GRID" && !layout.gridTemplateColumns) throw new Error(subject + ": creating a grid requires gridTemplateColumns. Rows are implicit hug tracks unless gridTemplateRows names them.");
  for (const axis of ["horizontal", "vertical"] as const) {
    const fields = AXES[axis];
    const tracks = layout[fields.template] ?? live?.[fields.tracks];
    const size = layout.sizing?.[axis] ?? (live?.[fields.sizing]?.toLowerCase() || "hug");
    if (tracks?.some(t => t.type === "FLEX") && size !== "fixed" && size !== "fill") {
      throw new Error(subject + ": fractional grid tracks require explicit fixed or fill " + fields.dimension + "; a hugging axis cannot become fixed implicitly.");
    }
  }
}

/** Explicit rectangle dimensions cannot override the closed part of an instance's tree. */
export function assertInheritedRectangleDimensions(wl: WriteLayout, subject: string): void {
  if (wl.dimensions?.width === undefined && wl.dimensions?.height === undefined) return;
  throw new Error(subject + ': explicit width/height cannot resize an inherited rectangle. Edit its component or choose a suitable variant; use width: "fill" or height: "fill" when the auto-layout parent should size it. Nothing was applied.');
}

/** The `{ row, column }` gap form, as distinct from one (possibly bound) gap for both axes. */
export function isGapPair(gap: WriteLayout["gap"]): gap is { row: Bindable; column: Bindable } {
  return typeof gap === "object" && !isTokenRef(gap);
}

function gapSides(gap: WriteLayout["gap"]): Bindable[] {
  return gap === undefined ? [] : isGapPair(gap) ? [gap.row, gap.column] : [gap];
}

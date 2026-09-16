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
// parameter. The parent-relative rules fire from create's APPLY walk, not prepare — deliberate:
// the walk already holds each parent's authored facts beside the appliers, and duplicating that
// derivation in a prepare pass is where the two could drift. Accepted cost: a bad percent child
// pays prepare's font/image loads before rejecting.
import { AXES, effectiveLayoutMode, type LayoutMode } from "./layout-mode.js";
import { WriteLayout } from "./ir.js";

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
    if (wl.gap !== undefined && (typeof wl.gap === "number" ? wl.gap < 0 : wl.gap.row < 0 || wl.gap.column < 0)) throw new Error(subject + ": grid gaps must be non-negative.");

  }
  const wraps = wl.wrap ?? liveWrap;
  if (wraps && effectiveMode !== "row") throw new Error(subject + ': layout.wrap requires layout.mode "row"; disable wrap in the same call before changing direction.');
  if (typeof wl.gap === "object" && !wraps && effectiveMode !== "grid") throw new Error(subject + ': unequal row/column gaps require layout.wrap: true on a horizontal row.');
  if (wraps && wl.gap !== undefined && (typeof wl.gap === "number" ? wl.gap : wl.gap.row) < 0) throw new Error(subject + ": wrapped row gap must be non-negative.");
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
  // sizing.vertical is the ONE carrier to key on: the compile writes "fixed" beside every
  // numeric AND percent height (ir.ts percentSize contract), and only compiled IR reaches the
  // bridge — so dimensions.height/percentSize.height can never arrive without this twin. "hug" is
  // legal on a text: it is the default restated at create, and the un-fill at edit.
  if (nodeType === "TEXT" && s.vertical === "fixed") {
    throw new Error(
      subject + ": a TEXT's height follows its content and wrap — set `width` (the text re-wraps and the height follows), " +
        'or use height: "fill" inside an auto-layout parent and height: "hug" to undo it.',
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

// "fill" and "N%" resolve against a parent frame's bounded size, and a page has none. The two
// callers that can see a page-shaped parent: render's root check (isRoot) and edit's live gate.
export function assertSizingResolvesAgainstParentFrame(wl: WriteLayout, isRoot: boolean, subject: string): void {
  const s = wl.sizing || {};
  if (s.horizontal === "fill" || s.vertical === "fill" || wl.percentSize || wl.percentPos) {
    throw new Error(
      subject + ': "fill" and "N%" resolve against a parent frame, and ' +
        (isRoot ? "the root node's" : "this node's") + " parent is the page" +
        " — a page has no bounded size. Use pixel dimensions, or " +
        // isRoot doubles as the verb tell: only render's root check passes true, so the remedy
        // can speak to a node being authored vs one already on the canvas.
        (isRoot ? "nest the node inside a frame." : "move the node into a frame first."),
    );
  }
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
        "out of flow its height follows content. Set `width` instead (the height follows the wrap), or place it in-flow in an auto-layout frame.",
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

/** FLEX needs a bounded axis. Template edits cannot silently change a live HUG into FIXED. */
export function assertGridSizing(layout: WriteLayout, live: {
  layoutMode?: string;
  layoutSizingHorizontal?: string;
  layoutSizingVertical?: string;
  gridColumnSizes?: readonly { type: string }[];
  gridRowSizes?: readonly { type: string }[];
} | undefined, subject: string): void {
  if (effectiveLayoutMode(layout, live).kind !== "grid") return;
  // A native default invents track intent and may introduce FLEX on a hugging axis.
  if (live?.layoutMode !== "GRID" && (!layout.gridTemplateColumns || !layout.gridTemplateRows)) throw new Error(subject + ": creating a grid requires gridTemplateColumns and gridTemplateRows.");
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

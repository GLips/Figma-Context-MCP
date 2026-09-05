// layout-legality — the ONE home for "can this node realize these layout words". Every rule that
// decides a layout word's legality lives here, and BOTH verbs consult it — create via flcm.ts
// (buildLayout, render's root check) and the bridge walk, edit via assertLayoutDeltaResolvable —
// so the two cannot answer differently (ADR-0003: a word that would do nothing must reject loud,
// in every verb). Pure and figma-free by charter: rules take the authored WriteLayout plus any
// live facts as BOOLEANS, because the callers know them from different places — the create walk
// answers from the authored spec (before the node or its parent's sizing modes exist), edit from
// the live flags. A rule that needs a fact neither side can state this way doesn't belong here.
//
// Convention: `subject` (the rejecting verb's name for the error prefix) is always the LAST
// parameter. The parent-relative rules fire from create's APPLY walk, not prepare — deliberate:
// the walk already holds each parent's spec facts beside the appliers, and duplicating that
// derivation in a prepare pass is where the two could drift. Accepted cost: a bad percent child
// spec pays prepare's font/image loads before rejecting.
import { WriteLayout } from "./ir.js";

// The live parent-flow facts the percent rule needs — edit reads them off the canvas
// (bridge.parentHugFacts), create derives them from the authored parent spec.
export interface ParentFlowFacts {
  parentIsAuto: boolean;
  hugW: boolean;
  hugH: boolean;
}

// Node-local legality: the type, the words, and whether the node will be a row/column container
// after this call. `liveIsRowColumn` is the one fact only edit can supply (a delta that doesn't
// name a mode inherits the live one); create passes false — the authored mode decides, and a
// spec with no mode is never a container. `willBeAuto` is derived here, not passed, so a caller
// can't hand in a value that contradicts the very layout it also passes.
export function assertLayoutRealizableForType(nodeType: string, wl: WriteLayout, liveIsRowColumn: boolean, subject: string): void {
  // No per-type "can this even be a container" rule here ON PURPOSE: a mode on a non-frame is
  // unreachable in both verbs — `layout` is a frame-constructor-only word at create, edit's
  // per-type vocabulary gate rejects it upstream, and render refuses hand-built IR
  // (provenance.ts) — so the rules below may trust the compile's invariants.
  const willBeAuto = wl.mode != null ? wl.mode !== "none" : liveIsRowColumn;
  const s = wl.sizing || {};
  if ((s.horizontal === "hug" || s.vertical === "hug") && !willBeAuto && nodeType !== "TEXT") {
    // The remedy is type-gated: `layout` is a FRAME-only word, so prescribing a mode to a shape
    // would send the author straight into an unknown-prop reject.
    throw new Error(
      subject + ': "hug" sizes to content, which only an auto-layout (row/column) container or text can measure — a ' +
        nodeType + " without auto-layout has no content size. " +
        (nodeType === "FRAME"
          ? 'Use pixel dimensions, or set layout: { mode: "row"|"column" } in the same call.'
          : "Use a pixel size (only a row/column frame or a text can measure content)."),
    );
  }
  // sizing.vertical is the ONE carrier to key on: the compile writes "fixed" beside every
  // numeric AND percent height (ir.ts percentSize contract), and only compiled IR reaches the
  // bridge — so dimensions.height/percentSize.height can never arrive without this twin.
  if (nodeType === "TEXT" && (s.vertical === "fixed" || s.vertical === "hug")) {
    throw new Error(
      subject + ": a TEXT's height follows its content and wrap — set `width` (the text re-wraps and the height follows), " +
        'or use height: "fill" inside an auto-layout parent.',
    );
  }
  if ((wl.gap != null || wl.padding || wl.justifyContent || wl.alignItems) && !willBeAuto) {
    // The "none" branch must hold for an AUTHORED none and for create's omitted-mode default
    // alike — naming a mode the author never wrote reads as someone else's error.
    throw new Error(
      subject + ": layout gap/padding/justifyContent/alignItems need an auto-layout (row/column) container — " +
        (wl.mode === "none"
          ? 'mode "none" (which is also the default when layout.mode is omitted) leaves this frame free-form'
          : "this frame isn't one") +
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
export function assertTextFillHeightInFlow(nodeType: string, wl: WriteLayout, parentIsRowColumn: boolean, isAbsolute: boolean, subject: string): void {
  if (nodeType !== "TEXT" || (wl.sizing || {}).vertical !== "fill") return;
  if (!parentIsRowColumn || isAbsolute) {
    throw new Error(
      subject + ": a TEXT can only fill its height as an in-flow child of a row/column auto-layout parent — " +
        "out of flow its height follows content. Set `width` instead (the height follows the wrap), or place it in-flow in a row/column frame.",
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
  if (!facts.parentIsAuto || childLayout.position === "absolute") return;
  if ((ps.width != null && facts.hugW) || (ps.height != null && facts.hugH)) {
    throw new Error(
      subject + ': a percent w/h ("N%") on an in-flow child of an auto-layout (row/column) parent that HUGS that axis is a cycle — ' +
        'the child\'s size both sets and depends on the parent\'s. Give the parent a fixed or "fill" size on that axis, use "fill"/"hug" on the child, or lift it out of the flow with `left`/`top`.',
    );
  }
}

// GRID is outside the authored context matrix: flcm can't create one, and its cells' semantics
// are unassigned — so the PARENT-RELATIVE words reject under a grid parent rather than silently
// landing with free-form semantics ("fill" would cover the whole grid frame). Node-local words
// (fixed px, "hug", own container props) stay legal. Only edit can see a grid parent today, but
// the rule lives here with the rest so a future create path can't answer differently.
export function assertNoParentRelativeWordsUnderGrid(wl: WriteLayout, parentIsGrid: boolean, subject: string): void {
  if (!parentIsGrid) return;
  const s = wl.sizing || {};
  if (s.horizontal === "fill" || s.vertical === "fill" || wl.percentSize || wl.percentPos || wl.position || wl.pin || wl.anchor) {
    throw new Error(
      subject + ': this node\'s parent is a GRID container, which the edit vocabulary doesn\'t cover — "fill", percents, absolute, and pin have no assigned meaning there. Use fixed pixel sizes, or edit the parent.',
    );
  }
}

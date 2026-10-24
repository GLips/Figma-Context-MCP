/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// sizing-plan — how one node's size words will be realized, decided once per node and axis. Native
// sizing (Figma's FIXED/HUG modes, a text's auto-resize, a flow's fill marks) or an explicit resize
// to px: an authored number, a percent of the parent, or a free-form "fill" covering the parent's box.
//
// Two readers, which is why it is a value and not a branch inside an applier: the instance write
// policy refuses an explicit resize Figma would ignore inside an instance, and the bridge's
// executors carry out exactly the plan the policy judged. Pure: the facts it needs arrive as values.

import type { Bindable, BuiltNode, WriteLayout } from "./ir.js";
import { effectiveLayoutMode, layoutModeOf, LAYOUT_MODES, type ChildLayout, type LayoutMode } from "./layout-mode.js";
import { hasContainerLayout } from "./vocabulary.js";

type TextAutoResize = TextNode["textAutoResize"];

/** What a node brings to its own sizing, before this call's words. */
export interface NodeSizingFacts {
  readonly type: string;
  /** A container sizes through its own auto-layout modes; a leaf only resizes (and a text auto-resizes). */
  readonly role: "container" | "leaf";
  /** The node's container mode before its own words: the live one, or the component a retarget or new instance brings. */
  readonly baseMode: LayoutMode;
  readonly textAutoResize?: TextAutoResize;
  /** A fresh frame hugs every axis the author leaves unnamed (CSS fit-content). */
  readonly unnamedAxis?: "hug";
}

export type AxisResize =
  | { readonly kind: "px"; readonly value: Bindable<number> }
  | { readonly kind: "percent"; readonly percent: number }
  | { readonly kind: "cover" };

export interface AxisSizingPlan {
  readonly native?: "fixed" | "hug";
  /** Filled by the parent's layout (a flow's grow/stretch marks, a grid cell). */
  readonly fill?: "flow";
  /** An explicit resize. A free-form "fill" is a cover, which wins over px. */
  readonly resize?: AxisResize;
}

export interface NodeSizingPlan {
  readonly role: "container" | "leaf";
  readonly baseMode: LayoutMode;
  /** The container mode once the node's own words have landed. */
  readonly ownMode: LayoutMode;
  readonly horizontal: AxisSizingPlan;
  readonly vertical: AxisSizingPlan;
  readonly textAutoResize?: TextAutoResize;
  readonly bounds?: WriteLayout["bounds"];
  readonly aspect?: { readonly kind: "lock"; readonly ratio: number } | { readonly kind: "unlock" };
  readonly isLine: boolean;
}

export function planNodeSizing(words: ChildLayout, facts: NodeSizingFacts): NodeSizingPlan {
  const layout = words.layout;
  const ownMode = effectiveLayoutMode(layout, { layoutMode: facts.baseMode.native });
  const sizing = layout.sizing || {};
  const isLine = facts.type === "LINE";
  const axis = (name: "horizontal" | "vertical", dim: "width" | "height"): AxisSizingPlan => {
    const value = sizing[name] ?? facts.unnamedAxis;
    const out: { native?: "fixed" | "hug"; fill?: "flow"; resize?: AxisResize } = {};
    if (value === "fixed" || value === "hug") out.native = value;
    // Out of flow nothing hands out a share, so "fill" is the parent's whole box, resized to.
    if (value === "fill") {
      if (words.kind === "free") out.resize = { kind: "cover" };
      else out.fill = "flow";
    }
    const percent = layout.percentSize?.[dim];
    const px = layout.dimensions?.[dim];
    if (out.resize) return out;
    if (percent != null) out.resize = { kind: "percent", percent };
    // A LINE is a length: its height is exactly 0 by Figma contract and never resized. An auto-layout
    // container resizes only its FIXED axes (fill/hug are the layout's); a free-form one honours any
    // authored number.
    else if (px !== undefined && !(isLine && name === "vertical") && (facts.role === "leaf" || ownMode.kind === "free" || sizing[name] === "fixed")) {
      out.resize = { kind: "px", value: px };
    }
    return out;
  };
  const plan: { -readonly [K in keyof NodeSizingPlan]: NodeSizingPlan[K] } = {
    role: facts.role, baseMode: facts.baseMode, ownMode, isLine,
    horizontal: axis("horizontal", "width"), vertical: axis("vertical", "height"),
  };
  if (facts.type === "TEXT") {
    const decided = textAutoResizeFor(sizing, facts.textAutoResize);
    if (decided) plan.textAutoResize = decided;
  }
  if (layout.bounds) plan.bounds = layout.bounds;
  if (layout.aspectRatio !== undefined) plan.aspect = layout.aspectRatio === "none" ? { kind: "unlock" } : { kind: "lock", ratio: layout.aspectRatio };
  return plan;
}

// A text's sizing is its auto-resize: NONE holds a fixed box, HEIGHT wraps at a fixed width and grows
// the height, WIDTH_AND_HEIGHT grows both. A fixed height fixes the box; a controlled width switches
// only a width-hugging text. height:"hug" undoes a fixed or flow-filled height (Figma pins a
// vertically filled text to NONE).
function textAutoResizeFor(sizing: NonNullable<WriteLayout["sizing"]>, current: TextAutoResize | undefined): TextAutoResize | undefined {
  let decided: TextAutoResize | undefined;
  if (sizing.vertical === "fixed") decided = "NONE";
  else if (sizing.horizontal === "hug") decided = "WIDTH_AND_HEIGHT";
  else if ((sizing.horizontal === "fixed" || sizing.horizontal === "fill") && current === "WIDTH_AND_HEIGHT") decided = "HEIGHT";
  const after = decided ?? current;
  if (sizing.vertical === "hug" && (after === "NONE" || after === "TRUNCATE")) decided = "HEIGHT";
  return decided;
}

/**
 * A live node's facts. `baseMode` overrides the live mode when the call retargets an instance first:
 * its root words land on the incoming component's container, not the outgoing one's.
 */
export function liveNodeSizingFacts(node: SceneNode, baseMode?: LayoutMode): NodeSizingFacts {
  const live = node as SceneNode & { layoutMode?: string; textAutoResize?: TextAutoResize };
  const mode = baseMode ?? layoutModeOf(live);
  return {
    type: node.type,
    role: hasContainerLayout(node.type) || layoutModeOf(live).kind !== "free" ? "container" : "leaf",
    baseMode: mode,
    ...(node.type === "TEXT" ? { textAutoResize: live.textAutoResize } : {}),
  };
}

/**
 * A node the walk is about to build. Only a FRAME or an INSTANCE sizes as a container: an svg VECTOR
 * becomes a frame live, but its canvas sizes as a leaf. A fresh text starts as Figma's createText
 * leaves it, auto-resizing both ways; an instance starts in its component's mode.
 */
export function builtNodeSizingFacts(wn: BuiltNode, componentMode?: LayoutMode): NodeSizingFacts {
  const container = wn.type === "FRAME" || wn.type === "INSTANCE";
  return {
    type: wn.type,
    role: container ? "container" : "leaf",
    baseMode: wn.type === "INSTANCE" && componentMode ? componentMode : LAYOUT_MODES.none,
    ...(wn.type === "TEXT" ? { textAutoResize: "WIDTH_AND_HEIGHT" as const } : {}),
    ...(wn.type === "FRAME" ? { unnamedAxis: "hug" as const } : {}),
  };
}

/** A live node's layout words resolved against the parent they land under, with its sizing facts. */
export interface ResolvedLiveLayout {
  readonly child: ChildLayout;
  readonly sizingFacts: NodeSizingFacts;
}

/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// geometry-dependency — which writes in a call can move a layer's measured size or position. Two
// askers: the scheduler (operation-schedule.ts), which runs a write before every word it can move,
// and the gate (call-obligations.ts), which leaves a realize-only word some write in the call can
// still produce to the finalizer instead of refusing it.
//
// A write's reach follows Figma's own reflow, judged against the facts the call's own layout words
// leave (the projection): a parent's box reaches the children that follow it (constraints out of
// flow, fill in flow), a child in flow reaches a parent that hugs it (on both axes when the parent
// wraps), a layer whose aspect is locked carries one axis's size to the other, and a container's
// words reach its size and its filling children. Advisory both ways: the finalizer, not this, keeps
// the call honest.

import type { WriteLayout, WriteProps } from "./ir.js";
import { CONSTRAINT_H, CONSTRAINT_V, type Axis } from "./layout-mode.js";
import type { Obligation, PatchFieldKey } from "./obligation.js";
import type { EditOperationPhase } from "./operation-schedule.js";
import { obligationsOnNode } from "./write-point.js";

/** One measured fact of one layer: its size or position on an axis, or the flow of its children. */
export type GeometryAspect = "size-h" | "size-v" | "pos-h" | "pos-v" | "flow";

export interface GeometryEffect {
  readonly node: SceneNode;
  readonly aspect: GeometryAspect;
}

/** Each layer's layout words in the call, by id: the facts reach is judged against once they land. */
export type GeometryProjection = Readonly<Record<string, WriteLayout | undefined>>;

const SIZE = { horizontal: "size-h", vertical: "size-v" } as const;
const POS = { horizontal: "pos-h", vertical: "pos-v" } as const;
const AXES: readonly Axis[] = ["horizontal", "vertical"];
const DIMENSION = { horizontal: "width", vertical: "height" } as const;
const BOUNDS = { horizontal: ["minWidth", "maxWidth"], vertical: ["minHeight", "maxHeight"] } as const;
const CONTAINER_WORDS: readonly (keyof WriteLayout)[] = ["mode", "wrap", "gap", "padding", "justifyContent", "alignItems", "gridTemplateColumns", "gridTemplateRows"];
const PLACEMENT_WORDS: readonly (keyof WriteLayout)[] = ["gridColumn", "gridRow", "justifySelf", "alignSelf"];

export const effectKey = (effect: GeometryEffect): string => effect.node.id + "|" + effect.aspect;

const isPage = (node: BaseNode | null | undefined): boolean => !node || node.type === "PAGE" || node.type === "DOCUMENT";

function isAutoLayout(node: SceneNode, projection: GeometryProjection): boolean {
  const mode = projection[node.id]?.mode;
  if (mode !== undefined) return mode !== "none";
  const live = (node as { layoutMode?: string }).layoutMode;
  return !!live && live !== "NONE";
}

function isAbsolute(node: SceneNode, projection: GeometryProjection): boolean {
  const layout = projection[node.id];
  if (layout?.position === "none") return false;
  if (layout?.position === "absolute" || layout?.left !== undefined || layout?.top !== undefined || layout?.percentPos !== undefined) return true;
  return (node as { layoutPositioning?: string }).layoutPositioning === "ABSOLUTE";
}

function inFlow(node: SceneNode, projection: GeometryProjection): boolean {
  const parent = node.parent;
  return !isPage(parent) && isAutoLayout(parent as SceneNode, projection) && !isAbsolute(node, projection);
}

/** How `node` sizes on `axis` once the call's words land: fixed, fill or hug. */
function sizingOf(node: SceneNode, axis: Axis, projection: GeometryProjection): "fixed" | "fill" | "hug" {
  const layout = projection[node.id];
  const authored = layout?.sizing?.[axis];
  if (authored) return authored;
  const dimension = DIMENSION[axis];
  if (layout?.dimensions?.[dimension] !== undefined || layout?.percentSize?.[dimension] !== undefined) return "fixed";
  const n = node as { type: string; textAutoResize?: string; layoutSizingHorizontal?: string; layoutSizingVertical?: string };
  if (n.type === "TEXT") return n.textAutoResize === "WIDTH_AND_HEIGHT" || (axis === "vertical" && n.textAutoResize === "HEIGHT") ? "hug" : "fixed";
  const live = axis === "horizontal" ? n.layoutSizingHorizontal : n.layoutSizingVertical;
  return live === "FILL" ? "fill" : live === "HUG" ? "hug" : "fixed";
}

function constraintOf(node: SceneNode, axis: Axis, projection: GeometryProjection): string | undefined {
  const authored = projection[node.id]?.constraints?.[axis === "horizontal" ? "x" : "y"];
  if (authored !== undefined) return (axis === "horizontal" ? CONSTRAINT_H : CONSTRAINT_V)[authored as string];
  return (node as { constraints?: Record<Axis, string> }).constraints?.[axis];
}

function wraps(node: SceneNode, projection: GeometryProjection): boolean {
  const authored = projection[node.id]?.wrap;
  return authored !== undefined ? authored : (node as { layoutWrap?: string }).layoutWrap === "WRAP";
}

// Figma's lock keeps a layer's proportions through constraint and auto-layout resizes, so one axis's
// size moves the other's (targetAspectRatio).
function locksAspect(node: SceneNode, projection: GeometryProjection): boolean {
  const authored = projection[node.id]?.aspectRatio;
  if (authored !== undefined) return authored !== "none";
  return !!(node as { targetAspectRatio?: unknown }).targetAspectRatio;
}

const otherAxis = (axis: Axis): Axis => (axis === "horizontal" ? "vertical" : "horizontal");

const childrenOf = (node: SceneNode): readonly SceneNode[] => ("children" in node ? (node as ChildrenMixin).children as readonly SceneNode[] : []);

// What one changed fact moves next. A position moves nothing but a group's bounds.
function nextEffects(effect: GeometryEffect, projection: GeometryProjection): GeometryEffect[] {
  const { node, aspect } = effect;
  const out: GeometryEffect[] = [];
  const parent = node.parent;
  if (parent && parent.type === "GROUP") out.push({ node: parent as SceneNode, aspect: "size-h" }, { node: parent as SceneNode, aspect: "size-v" });
  if (aspect === "pos-h" || aspect === "pos-v") return out;
  const axes = aspect === "flow" ? AXES : [aspect === "size-h" ? "horizontal" as const : "vertical" as const];
  for (const axis of axes) {
    if (aspect === "flow") {
      if (isAutoLayout(node, projection) && sizingOf(node, axis, projection) === "hug") out.push({ node, aspect: SIZE[axis] });
    } else {
      // A child in flow resizes a parent that hugs it, and in a wrapping row moves its line breaks,
      // which a parent hugging the counter axis grows or shrinks with.
      if (inFlow(node, projection)) {
        if (sizingOf(parent as SceneNode, axis, projection) === "hug") out.push({ node: parent as SceneNode, aspect: SIZE[axis] });
        const cross = otherAxis(axis);
        if (wraps(parent as SceneNode, projection) && sizingOf(parent as SceneNode, cross, projection) === "hug") out.push({ node: parent as SceneNode, aspect: SIZE[cross] });
      }
      if (locksAspect(node, projection)) out.push({ node, aspect: SIZE[otherAxis(axis)] });
      // A text that wraps at its width grows taller as the width shrinks.
      if (axis === "horizontal" && node.type === "TEXT" && (node as TextNode).textAutoResize === "HEIGHT") out.push({ node, aspect: "size-v" });
    }
    const auto = isAutoLayout(node, projection);
    for (const child of childrenOf(node)) {
      if (auto && !isAbsolute(child, projection)) {
        if (sizingOf(child, axis, projection) === "fill") out.push({ node: child, aspect: SIZE[axis] });
        continue;
      }
      if (aspect === "flow") continue;
      const pin = constraintOf(child, axis, projection);
      if (pin === "STRETCH" || pin === "SCALE") out.push({ node: child, aspect: SIZE[axis] });
      if (pin === "MAX" || pin === "CENTER" || pin === "SCALE") out.push({ node: child, aspect: POS[axis] });
    }
  }
  return out;
}

/** Every fact `effects` can move, themselves included, by effectKey. */
export function reachedGeometry(effects: readonly GeometryEffect[], projection: GeometryProjection = {}): Map<string, GeometryEffect> {
  const reached = new Map<string, GeometryEffect>();
  const queue = [...effects];
  while (queue.length) {
    const effect = queue.pop()!;
    const key = effectKey(effect);
    if (reached.has(key)) continue;
    reached.set(key, effect);
    queue.push(...nextEffects(effect, projection));
  }
  return reached;
}

// ---- what a write changes ----

const sizeOn = (node: SceneNode, axes: Iterable<Axis>): GeometryEffect[] => [...axes].map((axis) => ({ node, aspect: SIZE[axis] }));
const flowOfParent = (node: SceneNode): GeometryEffect[] => (isPage(node.parent) ? [] : [{ node: node.parent as SceneNode, aspect: "flow" }]);

// The axes `layout`'s own size words name, minus the ones the call can't write.
function sizedAxes(layout: WriteLayout, unwritten: ReadonlySet<PatchFieldKey>, words: "own" | "percent"): Axis[] {
  return AXES.filter((axis) => {
    if (unwritten.has(`axis:${axis}`)) return false;
    const dimension = DIMENSION[axis];
    if (words === "percent") return layout.percentSize?.[dimension] !== undefined;
    return layout.sizing?.[axis] !== undefined || layout.dimensions?.[dimension] !== undefined || layout.designedSize?.[dimension] !== undefined ||
      (!unwritten.has("layout:bounds") && BOUNDS[axis].some((bound) => layout.bounds?.[bound] !== undefined));
  });
}

/**
 * The geometry one phase of a node's write changes: `patch` is the compiled delta, `unwritten` the
 * fields the instance write policy leaves realize-only (they are owed, never written).
 */
export function geometryWritesAt(node: SceneNode, patch: WriteProps, phase: EditOperationPhase, unwritten: ReadonlySet<PatchFieldKey> = new Set()): GeometryEffect[] {
  const layout = patch.layout ?? {};
  const has = (key: keyof WriteProps) => patch[key] !== undefined && !unwritten.has(`prop:${key}`);
  const hasLayout = (key: keyof WriteLayout) => layout[key] !== undefined && !unwritten.has(`layout:${key}`);
  switch (phase) {
    case "appearance":
      return has("visible") ? flowOfParent(node) : [];
    case "text": {
      if (node.type !== "TEXT" || !(has("text") || has("runs") || has("textStyle"))) return [];
      const resize = (node as TextNode).textAutoResize;
      return resize === "WIDTH_AND_HEIGHT" ? sizeOn(node, AXES) : resize === "HEIGHT" ? sizeOn(node, ["vertical"]) : [];
    }
    case "container":
      return CONTAINER_WORDS.some(hasLayout) ? [{ node, aspect: "flow" }] : [];
    case "placement": {
      const out: GeometryEffect[] = [];
      if (hasLayout("position")) out.push(...flowOfParent(node), { node, aspect: "pos-h" }, { node, aspect: "pos-v" });
      if (hasLayout("left")) out.push({ node, aspect: "pos-h" });
      if (hasLayout("top")) out.push({ node, aspect: "pos-v" });
      if (PLACEMENT_WORDS.some(hasLayout)) out.push(...flowOfParent(node), { node, aspect: "pos-h" }, { node, aspect: "pos-v" });
      return [...out, ...sizeOn(node, AXES.filter((axis) => layout.sizing?.[axis] === "fill" && !unwritten.has(`axis:${axis}`)))];
    }
    case "own-size":
      return sizeOn(node, sizedAxes(layout, unwritten, "own"));
    case "cover":
      return sizeOn(node, AXES.filter((axis) => layout.sizing?.[axis] === "fill" && !unwritten.has(`axis:${axis}`)));
    case "percent-size":
      return sizeOn(node, sizedAxes(layout, unwritten, "percent"));
    case "aspect-ratio":
      return hasLayout("aspectRatio") ? sizeOn(node, AXES) : [];
    case "text-clamp":
      return has("maxLines") ? sizeOn(node, ["vertical"]) : [];
    case "percent-position":
      return hasLayout("percentPos") ? [{ node, aspect: "pos-h" }, { node, aspect: "pos-v" }] : [];
    default:
      return [];
  }
}

/** Every geometry write `patch` makes on `node`, whatever phase lands it: what a realize-only word can wait on. */
export function geometryWritesOf(node: SceneNode, patch: WriteProps, unwritten?: ReadonlySet<PatchFieldKey>): GeometryEffect[] {
  return (["text", "container", "placement", "own-size", "cover", "percent-size", "aspect-ratio", "text-clamp", "percent-position"] as const)
    .flatMap((phase) => geometryWritesAt(node, patch, phase, unwritten));
}

/** A write that resizes `node` on both axes and changes its children (a retarget, a content change). */
export function wholeBoxWrites(node: SceneNode): GeometryEffect[] {
  return [...sizeOn(node, AXES), { node, aspect: "flow" }];
}

// ---- what a word reads ----

/** The geometry `obligation`'s observer reads on `node`: what a write must not move after it lands. */
function obligationGeometryReads(obligation: Obligation, node: SceneNode): GeometryEffect[] {
  const parent = isPage(node.parent) ? null : (node.parent as SceneNode);
  const ofParent = (axis: Axis): GeometryEffect[] => (parent ? [{ node: parent, aspect: SIZE[axis] }] : []);
  if (obligation.kind === "axisSize") {
    const { axis, intent } = (obligation as Obligation<"axisSize">).request;
    if ("hug" in intent) return [];
    if ("px" in intent) return [{ node, aspect: SIZE[axis] }];
    // A fill in flow is read as the sizing mode; a fill that covers the parent box, and a percent, as a size of the parent's.
    if ("fill" in intent && obligation.writePoint !== "cover") return [];
    return [{ node, aspect: SIZE[axis] }, ...ofParent(axis)];
  }
  if (obligation.kind === "positionOffset") {
    const { axis, offset } = (obligation as Obligation<"positionOffset">).request;
    return [{ node, aspect: POS[axis] }, ...("percent" in offset ? ofParent(axis) : [])];
  }
  if (obligation.kind === "aspectRatio") return (obligation as Obligation<"aspectRatio">).request === "none" ? [] : sizeOn(node, AXES);
  return [];
}

/**
 * What the words `node` writes at `phase` read: every write that can move one of them lands first.
 * `among` stands in for the ledger where the gate schedules words it records only later.
 */
export function writePointGeometryReads(node: SceneNode, phase: EditOperationPhase, among?: readonly Obligation[]): GeometryEffect[] {
  return obligationsOnNode(node, among)
    .filter((obligation) => obligation.writePoint === phase && obligation.writability === "writable")
    .flatMap((obligation) => obligationGeometryReads(obligation, node));
}

/**
 * Whether any of `writes` can move what `obligation` reads on `node`. A write on `node` itself is
 * the word's own, never its producer.
 */
export function geometryProducedBy(obligation: Obligation, node: SceneNode, writes: readonly GeometryEffect[], projection: GeometryProjection = {}): boolean {
  const reads = obligationGeometryReads(obligation, node);
  if (!reads.length) return false;
  const reached = reachedGeometry(writes.filter((write) => write.node !== node), projection);
  return reads.some((read) => reached.has(effectKey(read)));
}

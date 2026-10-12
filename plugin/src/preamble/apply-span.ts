/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// ApplySpan — what one verb's sealed apply span defers until its writes have landed. The lock opens
// one per verb (enterMutatingVerb) and hands it to apply; the appliers queue into it; bridge's
// settleApplySpan settles its geometry in one fixed order (sibling order → percents and ratios,
// shallowest first → pivots), and the lock flushes its style links last. A verb settles early only where it reads
// geometry before returning (a handle, a component conversion); the lock's own settle then finds
// nothing left. An applier can't queue outside a verb, because there is no span to queue into.

import type { WriteLayout } from "./ir.js";
import { holdUnrotatedCorner, settleCentrePivot, type PivotHold } from "./pivot.js";

export type StyleSlot = "fill" | "stroke" | "effect" | "text";

export interface ApplySpan {
  /** Style links, landed in order by the lock after apply: linking is async-only under dynamic-page. */
  readonly styleLinks: { node: any; slot: StyleSlot; styleId: string }[];
  /** zIndex moves, by parent: applied once the parent holds every child this span places. */
  readonly siblingOrder: Map<any, Map<any, number>>;
  /** Built children whose percent size/position waits on its parent's realized size. */
  readonly percents: { node: any; layout: WriteLayout; parent: any }[];
  /** Built nodes with an aspectRatio, locked once every size has landed. */
  readonly ratios: { node: any; layout: WriteLayout }[];
  /** Turned nodes whose centre pivot waits on their final size and position. */
  readonly pivots: { node: any; layout?: WriteLayout }[];
  /** Each held node's opening state: taken once, before anything in the span can resize it. */
  readonly pivotHolds: Map<any, PivotHold | undefined>;
}

export function openApplySpan(): ApplySpan {
  return { styleLinks: [], siblingOrder: new Map(), percents: [], ratios: [], pivots: [], pivotHolds: new Map() };
}

/** Queue a style link. The caller has already written the style's values. */
export function queueStyleLink(span: ApplySpan, node: any, slot: StyleSlot, styleId: string): void {
  span.styleLinks.push({ node, slot, styleId });
}

/**
 * Open a live node's centre-pivot hold (pivot.ts), once per span: a second hold would read the
 * already-moved translation as the turned one. Closed by settlePivot.
 */
export function holdPivot(span: ApplySpan, node: any): void {
  if (!span.pivotHolds.has(node)) span.pivotHolds.set(node, holdUnrotatedCorner(node));
}

/** Close the node's hold: turn it about the centre of its unrotated box. `layout` is the delta it took. */
export function settlePivot(span: ApplySpan, node: any, layout?: WriteLayout): void {
  settleCentrePivot(node, span.pivotHolds.get(node), layout);
  span.pivotHolds.delete(node);
}

/**
 * Hand everything the span holds for `from` to `to`, for an apply that replaced `from`
 * (createComponentFromNode). Live, every read of the replaced node but `id` and `removed` throws
 * "does not exist".
 */
export function retargetSpanNode(span: ApplySpan, from: any, to: any): void {
  for (const link of span.styleLinks) if (link.node === from) link.node = to;
  for (const list of [span.percents, span.ratios, span.pivots]) for (const entry of list) if (entry.node === from) entry.node = to;
  for (const entry of span.percents) if (entry.parent === from) entry.parent = to;
  if (span.pivotHolds.has(from)) { span.pivotHolds.set(to, span.pivotHolds.get(from)); span.pivotHolds.delete(from); }
  const order = span.siblingOrder.get(from);
  if (order) { span.siblingOrder.set(to, order); span.siblingOrder.delete(from); }
  for (const edits of span.siblingOrder.values()) {
    if (edits.has(from)) { edits.set(to, edits.get(from)!); edits.delete(from); }
  }
}

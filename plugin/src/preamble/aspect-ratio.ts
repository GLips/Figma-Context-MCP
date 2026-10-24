/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The aspectRatio word, both halves: what compile can judge from the authored sizes, and the settle
// that brings a realized box to the ratio and locks it once every size has landed. The only home of
// Figma's lockAspectRatio()/unlockAspectRatio(), so every lock is one the instance write policy judged.
import type { WriteLayout } from "./ir.js";
import { resizeToPlannedSize } from "./sizing-diagnostics.js";
import type { AuthorizedLayout } from "./instance-write-authorization.js";
import { pixelRound } from "@framelink/core";

/**
 * Whether a width × height box agrees with ratio `r` within a read's rounding. A read rounds width,
 * height and the ratio each to 2 decimals, so a paste-back can be off by the ratio's own rounding
 * plus what rounding the sizes does to width ÷ height — which grows as a size shrinks (1000 × 3.333
 * reads back 0.27 off its ratio). Doubled for slack; a ratio the box genuinely isn't still refuses.
 */
export function aspectRatioAgrees(width: number, height: number, r: number): boolean {
  const boxRatio = width / height;
  return Math.abs(boxRatio - r) <= 0.01 + boxRatio * 0.01 * (1 / width + 1 / height);
}

function bothAxesFillRefusal(subject: string): Error {
  return new Error(subject + ': with both axes "fill" neither is free to follow aspectRatio. Size one of them, or drop aspectRatio.');
}

// What can be judged before the node exists: the value, a "hug" axis (its size is its content's,
// so it can't follow a ratio), two filled axes (neither is free to follow) and two fixed sizes that
// disagree. A fixed axis beside an unnamed one derives it here, so the node is built at the ratio;
// the rest settles once every size has landed (settleAspectRatio).
export function compileAspectRatio(raw: unknown, layout: WriteLayout, subject: string): void {
  if (raw === undefined) return;
  if (raw === "none") {
    layout.aspectRatio = "none";
    return;
  }
  if (typeof raw !== "number" || !isFinite(raw) || raw <= 0) {
    throw new Error(subject + ': aspectRatio must be a positive number, width ÷ height (16 / 9), or "none" to unlock — got ' + JSON.stringify(raw) + ".");
  }
  const sizing = (layout.sizing ??= {});
  if (sizing.horizontal === "hug" || sizing.vertical === "hug") {
    throw new Error(subject + ': a "hug" axis is sized by its content, so it can\'t follow aspectRatio. Give it a size or "fill", or drop aspectRatio.');
  }
  if (sizing.horizontal === "fill" && sizing.vertical === "fill") throw bothAxesFillRefusal(subject);
  const dims = (layout.dimensions ??= {});
  const width = typeof dims.width === "number" ? dims.width : undefined;
  const height = typeof dims.height === "number" ? dims.height : undefined;
  if (width !== undefined && height !== undefined) {
    if (!aspectRatioAgrees(width, height, raw)) {
      throw new Error(subject + ": width " + width + " and height " + height + " are a " + pixelRound(width / height) + " ratio, not aspectRatio " + raw + ". Name one size and the ratio derives the other.");
    }
  } else if (width !== undefined && sizing.vertical === undefined) {
    sizing.vertical = "fixed";
    dims.height = width / raw;
  } else if (height !== undefined && sizing.horizontal === undefined) {
    sizing.horizontal = "fixed";
    dims.width = height * raw;
  }
  if (!sizing.horizontal && !sizing.vertical) delete layout.sizing;
  if (dims.width === undefined && dims.height === undefined) delete layout.dimensions;
  layout.aspectRatio = raw;
}

/**
 * Lock the node's proportions at its planned ratio (an "unlock" plan unlocks). Figma locks whatever
 * ratio the box has, so the box is brought to the ratio first: the driving axis — a "fill" or percent
 * one, else the width — keeps its size and the other follows. Runs once the sizes have landed, so it
 * judges the REALIZED sizing too: an edit or a parent's stretch can leave an axis filling or hugging
 * that compile never saw. Afterwards Figma's lock carries the pair through layout and constraint resizes.
 */
export function settleAspectRatio(node: any, layout: AuthorizedLayout): void {
  const aspect = layout.sizing.aspect;
  if (!aspect) return;
  if (aspect.kind === "unlock") {
    node.unlockAspectRatio();
    return;
  }
  const ratio = aspect.ratio;
  // Figma can't lock an auto-resizing text at all.
  if (node.type === "TEXT" && node.textAutoResize !== "NONE") {
    throw new Error("flcm: aspectRatio needs a fixed box, but this TEXT sizes itself to its text. Give it a fixed width and height, or drop aspectRatio.");
  }
  // A hug axis is sized by its content, and resize() would silently turn it fixed — driving or following.
  const hugging = node.layoutSizingHorizontal === "HUG" ? "width" : node.layoutSizingVertical === "HUG" ? "height" : undefined;
  if (hugging) {
    throw new Error("flcm: aspectRatio needs a fixed or filled box, but this " + node.type + " hugs its content on its " + hugging + ". Give it a size, or drop aspectRatio.");
  }
  const widthFills = node.layoutSizingHorizontal === "FILL" || layout.sizing.horizontal.resize?.kind === "percent";
  const heightFills = node.layoutSizingVertical === "FILL" || layout.sizing.vertical.resize?.kind === "percent";
  // resize() would set the follower, and the FILL restore below would undo it — locking fill's box.
  if (widthFills && heightFills) throw bothAxesFillRefusal("flcm");
  // An existing lock is let go first: whether resize() honours it is unverified, and a resize that
  // did would skew the box the new lock captures.
  if (node.targetAspectRatio) node.unlockAspectRatio();
  const before = { horizontal: node.layoutSizingHorizontal, vertical: node.layoutSizingVertical };
  if (heightFills) resizeToPlannedSize(node, layout, { width: Math.max(node.height * ratio, 0.01), height: node.height });
  else resizeToPlannedSize(node, layout, { width: node.width, height: Math.max(node.width / ratio, 0.01) });
  // resize() pins both axes; a driving "fill" axis must keep filling for the lock to follow it.
  if (before.horizontal === "FILL" && node.layoutSizingHorizontal !== "FILL") node.layoutSizingHorizontal = "FILL";
  if (before.vertical === "FILL" && node.layoutSizingVertical !== "FILL") node.layoutSizingVertical = "FILL";
  node.lockAspectRatio();
}

/**
 * A built VECTOR path's ratio: its box is its geometry, so a ratio can only be the one it already
 * has. A paste-back's own locks again (true); any other is the caller's to report (false).
 * `_authorized` is the proof the policy saw the node; a built node never lands in a locked tree.
 */
export function lockBuiltPathAspectRatio(node: any, _authorized: AuthorizedLayout, ratio: unknown): boolean {
  if (typeof ratio !== "number" || !aspectRatioAgrees(node.width, node.height, ratio)) return false;
  node.lockAspectRatio();
  return true;
}

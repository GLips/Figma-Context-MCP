/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { MAX_SCREENSHOT_SCALE } from "./protocol.js";
import { FlcmError } from "./preamble/flcm-error.js";

/** Opt-in prototype policy; pixel fidelity and undo/selection behavior need live verification. */
export interface CaptureOptions { scale?: number; context?: boolean; margin?: number }
export const CONTEXT_MARGIN_PROTOTYPE = { proportion: 0.1, min: 80, max: 160 } as const;

function identityOf(node: BaseNode): { type: string; name: string; id: string } {
  return { type: node.type, name: node.name, id: node.id };
}

export function contextualBounds(bounds: Rect, margin?: number): Rect {
  if (margin !== undefined && (!Number.isFinite(margin) || margin < 0)) throw new FlcmError("authoring", "must be a finite number of pixels, 0 or more — got " + margin + ".", { path: "margin" });
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) throw new FlcmError("authoring", "this layer has no visible size to frame a context:true screenshot around. Screenshot it without context, or target the frame it sits in.");
  const padding = margin ?? Math.min(CONTEXT_MARGIN_PROTOTYPE.max, Math.max(CONTEXT_MARGIN_PROTOTYPE.min, Math.max(bounds.width, bounds.height) * CONTEXT_MARGIN_PROTOTYPE.proportion));
  const result = { x: bounds.x - padding, y: bounds.y - padding, width: bounds.width + 2 * padding, height: bounds.height + 2 * padding };
  if (!Object.values(result).every(Number.isFinite)) throw new FlcmError("authoring", "is too large: the area to capture around the layer would be unbounded. Use a smaller margin.", { path: "margin" });
  return result;
}

export async function captureScreenshot(node: BaseNode, options: CaptureOptions, cancelled: () => boolean = () => false): Promise<Uint8Array> {
  const checkCancellation = () => { if (cancelled()) throw new FlcmError("run-ended", "the screenshot was cancelled before it finished, so none was taken; the temporary capture area was removed from the file."); };
  if (options.scale !== undefined && (!Number.isFinite(options.scale) || options.scale <= 0 || options.scale > MAX_SCREENSHOT_SCALE)) throw new FlcmError("authoring", `must be greater than 0 and at most ${MAX_SCREENSHOT_SCALE} — got ${options.scale}.`, { path: "scale" });
  if (options.margin !== undefined && options.context !== true) throw new FlcmError("authoring", "only applies with context: true. Add context: true, or drop margin.", { path: "margin" });
  checkCancellation();
  const settings: ExportSettingsImage = { format: "PNG", constraint: { type: "SCALE", value: options.scale ?? 1 } };
  if (!options.context) {
    if (!("exportAsync" in node)) throw new FlcmError("figma", "Figma can't export this layer as an image. Screenshot the frame it sits in instead.", { node: identityOf(node) });
    return node.exportAsync(settings);
  }
  if (!("absoluteBoundingBox" in node) || !node.absoluteBoundingBox) throw new FlcmError("authoring", "context: true needs a layer on the canvas to frame, and this has no position there. Pass the nodeId or key of a layer on the page.", { node: identityOf(node) });
  let page: BaseNode | null = node;
  while (page && page.type !== "PAGE") page = page.parent;
  if (page !== figma.currentPage) throw new FlcmError("authoring", "context: true only works on the current page, and this layer is on another. Switch to its page with flcm.page.use first, or drop context.", { node: identityOf(node) });
  const bounds = contextualBounds(node.absoluteBoundingBox, options.margin);
  const slice = figma.createSlice();
  try {
    slice.name = "Framelink contextual capture (temporary prototype)";
    slice.x = bounds.x;
    slice.y = bounds.y;
    slice.resize(bounds.width, bounds.height);
    checkCancellation();
    const bytes = await slice.exportAsync(settings);
    checkCancellation();
    return bytes;
  } finally {
    if (!slice.removed) slice.remove();
  }
}

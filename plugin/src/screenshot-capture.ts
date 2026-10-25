/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { MAX_SCREENSHOT_SCALE } from "./protocol.js";
import { FlcmError } from "./preamble/flcm-error.js";

/** Opt-in prototype policy; pixel fidelity and undo/selection behavior need live verification. */
export interface CaptureOptions { scale?: number; context?: boolean; margin?: number }
export const CONTEXT_MARGIN_PROTOTYPE = { proportion: 0.1, min: 80, max: 160 } as const;

export function contextualBounds(bounds: Rect, margin?: number): Rect {
  if (margin !== undefined && (!Number.isFinite(margin) || margin < 0)) throw new FlcmError("authoring", "Screenshot margin must be a finite nonnegative pixel value.");
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) throw new FlcmError("authoring", "Contextual screenshot needs positive finite target bounds.");
  const padding = margin ?? Math.min(CONTEXT_MARGIN_PROTOTYPE.max, Math.max(CONTEXT_MARGIN_PROTOTYPE.min, Math.max(bounds.width, bounds.height) * CONTEXT_MARGIN_PROTOTYPE.proportion));
  const result = { x: bounds.x - padding, y: bounds.y - padding, width: bounds.width + 2 * padding, height: bounds.height + 2 * padding };
  if (!Object.values(result).every(Number.isFinite)) throw new FlcmError("authoring", "Screenshot margin produces non-finite capture bounds.");
  return result;
}

export async function captureScreenshot(node: BaseNode, options: CaptureOptions, cancelled: () => boolean = () => false): Promise<Uint8Array> {
  const checkCancellation = () => { if (cancelled()) throw new FlcmError("run-ended", "Screenshot cancelled; temporary capture region removed."); };
  if (options.scale !== undefined && (!Number.isFinite(options.scale) || options.scale <= 0 || options.scale > MAX_SCREENSHOT_SCALE)) throw new FlcmError("authoring", `Screenshot scale must be greater than 0 and at most ${MAX_SCREENSHOT_SCALE}.`);
  if (options.margin !== undefined && options.context !== true) throw new FlcmError("authoring", "Screenshot margin requires context:true.");
  checkCancellation();
  const settings: ExportSettingsImage = { format: "PNG", constraint: { type: "SCALE", value: options.scale ?? 1 } };
  if (!options.context) {
    if (!("exportAsync" in node)) throw new FlcmError("figma", `Node ${node.type} (${node.id}) is not exportable`, { node: { type: node.type, id: node.id } });
    return node.exportAsync(settings);
  }
  if (!("absoluteBoundingBox" in node) || !node.absoluteBoundingBox) throw new FlcmError("authoring", "Contextual screenshot requires a scene node with bounds; pass nodeId or key.");
  let page: BaseNode | null = node;
  while (page && page.type !== "PAGE") page = page.parent;
  if (page !== figma.currentPage) throw new FlcmError("authoring", "Contextual screenshot target must be on the current page.");
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

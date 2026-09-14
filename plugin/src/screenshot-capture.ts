/** Opt-in prototype policy; pixel fidelity and undo/selection behavior need live verification. */
export interface CaptureOptions { scale?: number; context?: boolean; margin?: number }
export const CONTEXT_MARGIN_PROTOTYPE = { proportion: 0.1, min: 24, max: 160 } as const;

export function contextualBounds(bounds: Rect, margin?: number): Rect {
  if (margin !== undefined && (!Number.isFinite(margin) || margin < 0)) throw new Error("Screenshot margin must be a finite nonnegative pixel value.");
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) throw new Error("Contextual screenshot needs positive finite target bounds.");
  const padding = margin ?? Math.min(CONTEXT_MARGIN_PROTOTYPE.max, Math.max(CONTEXT_MARGIN_PROTOTYPE.min, Math.max(bounds.width, bounds.height) * CONTEXT_MARGIN_PROTOTYPE.proportion));
  const result = { x: bounds.x - padding, y: bounds.y - padding, width: bounds.width + 2 * padding, height: bounds.height + 2 * padding };
  if (!Object.values(result).every(Number.isFinite)) throw new Error("Screenshot margin produces non-finite capture bounds.");
  return result;
}

export async function captureScreenshot(node: BaseNode, options: CaptureOptions, cancelled: () => boolean = () => false): Promise<Uint8Array> {
  const checkCancellation = () => { if (cancelled()) throw new Error("Screenshot cancelled; temporary capture region removed."); };
  if (options.scale !== undefined && (!Number.isFinite(options.scale) || options.scale <= 0 || options.scale > 4)) throw new Error("Screenshot scale must be greater than 0 and at most 4.");
  if (options.margin !== undefined && options.context !== true) throw new Error("Screenshot margin requires context:true.");
  checkCancellation();
  const settings: ExportSettingsImage = { format: "PNG", constraint: { type: "SCALE", value: options.scale ?? 1 } };
  if (!options.context) {
    if (!("exportAsync" in node)) throw new Error(`Node ${node.type} (${node.id}) is not exportable`);
    return node.exportAsync(settings);
  }
  if (!("absoluteBoundingBox" in node) || !node.absoluteBoundingBox) throw new Error("Contextual screenshot requires a scene node with bounds; pass nodeId or key.");
  let page: BaseNode | null = node;
  while (page && page.type !== "PAGE") page = page.parent;
  if (page !== figma.currentPage) throw new Error("Contextual screenshot target must be on the current page.");
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

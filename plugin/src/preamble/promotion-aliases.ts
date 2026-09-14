import { sceneFigma as figma } from "./scene-access.js";
// File-scoped, undoable aliases. Read on each call so undo and reopen need no cache invalidation.
const KEY = "flcm/promotion-aliases";
function aliases(): Record<string, string> {
  const value = figma.root.getPluginData(KEY);
  if (!value) return {};
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some(v => typeof v !== "string")) throw new Error("flcm: invalid promotion alias metadata.");
  return parsed as Record<string, string>;
}
export function recordPromotionAlias(previous: string, current: string): void {
  figma.root.setPluginData(KEY, JSON.stringify({ ...aliases(), [previous]: current }));
}
export async function resolvePromotionId(id: string): Promise<SceneNode | null> {
  const visited = new Set<string>();
  let table: Record<string, string> | undefined;
  while (!visited.has(id)) {
    visited.add(id);
    const node = await figma.getNodeByIdAsync(id);
    if (node && !node.removed) return node as SceneNode;
    table ??= aliases();
    const successor = Object.prototype.hasOwnProperty.call(table, id) ? table[id] : undefined;
    if (!successor) return null;
    id = successor;
  }
  throw new Error("flcm: cycle in promotion ID aliases at " + JSON.stringify(id) + ".");
}

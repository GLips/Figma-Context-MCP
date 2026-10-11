/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { warnings } from "./warnings.js";
// A read pasted back with only its root id deleted builds a new root and MOVES every id-bearing
// child into it, emptying the source. That is the documented rule, not a bug, so this only says it
// happened. One accumulator per mutation span, like sizing-diagnostics: placement records, and the
// check runs once the whole verb has succeeded, when wrapping and removal have settled.
interface MovedNode { id: string; name?: string; removed: boolean; type: string; parent: MovedNode | null; children?: readonly MovedNode[] }
// The source's name and id are taken at the move: Figma deletes a GROUP the move empties.
interface LiveMoveIntoNewNode { node: MovedNode; from: MovedNode; fromId: string; fromName: string; into: MovedNode }
let moves: LiveMoveIntoNewNode[] = [];
let removedByVerb = new Set<string>();

export function beginMovedOutDiagnostics(): void {
  moves = [];
  removedByVerb = new Set();
}

/** A live node just placed directly into a node this verb created; `from` is its parent before the move. */
export function recordLiveMoveIntoNewNode(node: MovedNode, from: MovedNode, into: MovedNode): void {
  moves.push({ node, from, fromId: from.id, fromName: from.name ?? "", into });
}

/** A node the verb itself deletes (replace's target): emptying it, or anything inside it, is the point. */
export function recordVerbRemovedNode(node: MovedNode): void {
  removedByVerb.add(node.id);
}

/** `from` was replaced by `to` mid-verb (createComponentFromNode): name `to` at finish. Reads only `from.id`. */
export function retargetMovedOutDiagnostics(from: MovedNode, to: MovedNode): void {
  for (const move of moves) {
    if (move.node === from) move.node = to;
    if (move.into === from) move.into = to;
    if (move.from === from) { move.from = to; move.fromId = to.id; }
  }
  if (removedByVerb.delete(from.id)) removedByVerb.add(to.id);
}

function insideVerbRemoved(node: MovedNode): boolean {
  for (let n: MovedNode | null = node; n; n = n.parent) {
    if (removedByVerb.has(n.id)) return true;
    if (n.removed) return false;
  }
  return false;
}

// `removed` is set only on the node remove() was called on, so ask whether a page is still above it.
function onCanvas(node: MovedNode): boolean {
  for (let n: MovedNode | null = node; n; n = n.parent) {
    if (n.removed) return false;
    if (n.type === "PAGE" || n.type === "DOCUMENT") return true;
  }
  return false;
}

function within(node: MovedNode, ancestorId: string): boolean {
  for (let n = node.parent; n; n = n.parent) if (n.id === ancestorId) return true;
  return false;
}

export function finishMovedOutDiagnostics(verb: string): void {
  try {
    const bySource = new Map<string, LiveMoveIntoNewNode[]>();
    // Wrapping in place leaves the node inside its old parent.
    for (const move of moves) {
      if (within(move.node, move.fromId) || insideVerbRemoved(move.from)) continue;
      const group = bySource.get(move.fromId);
      if (group) group.push(move);
      else bySource.set(move.fromId, [move]);
    }
    for (const group of bySource.values()) {
      const { from, fromId, fromName } = group[0];
      const into = new Map(group.map(move => [move.into.id, move.into]));
      const [only] = into.values();
      const left = !onCanvas(from) ? "; Figma deleted the emptied source" : from.children?.length ? "" : "; the source is now empty";
      warnings.add({
        id: null,
        message: "Moved " + group.length + (group.length === 1 ? " node" : " nodes") + " out of " + JSON.stringify(fromName) + " (id " + JSON.stringify(fromId) + ") into " +
          (into.size === 1 ? "new " + JSON.stringify(only.name ?? "") + " (id " + JSON.stringify(only.id) + ")" : into.size + " new containers") +
          left + ". If you intended a copy, restore the moved nodes and use flcm.clone.",
      });
    }
  } catch (error) {
    warnings.add({ id: null, message: "flcm." + verb + ": write succeeded; the moved-node check could not inspect the result: " + String(error) });
  } finally {
    beginMovedOutDiagnostics();
  }
}

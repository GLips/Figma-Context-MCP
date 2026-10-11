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
interface LiveMoveIntoNewNode { node: MovedNode; from: MovedNode; into: MovedNode }
let moves: LiveMoveIntoNewNode[] = [];

export function beginMovedOutDiagnostics(): void {
  moves = [];
}

/** A live node just placed directly into a node this verb created; `from` is its parent before the move. */
export function recordLiveMoveIntoNewNode(node: MovedNode, from: MovedNode, into: MovedNode): void {
  moves.push({ node, from, into });
}

// `removed` is set only on the node remove() was called on, so ask whether a page is still above it.
function onCanvas(node: MovedNode): boolean {
  for (let n: MovedNode | null = node; n; n = n.parent) {
    if (n.removed) return false;
    if (n.type === "PAGE" || n.type === "DOCUMENT") return true;
  }
  return false;
}

function within(node: MovedNode, ancestor: MovedNode): boolean {
  for (let n = node.parent; n; n = n.parent) if (n.id === ancestor.id) return true;
  return false;
}

export function finishMovedOutDiagnostics(verb: string): void {
  try {
    const bySource = new Map<string, LiveMoveIntoNewNode[]>();
    // Wrapping in place leaves the node inside its old parent; a source the verb removed (replace's
    // target) has nobody left to tell.
    for (const move of moves) {
      if (!onCanvas(move.from) || within(move.node, move.from)) continue;
      const group = bySource.get(move.from.id);
      if (group) group.push(move);
      else bySource.set(move.from.id, [move]);
    }
    for (const group of bySource.values()) {
      const { from } = group[0];
      const into = new Map(group.map(move => [move.into.id, move.into]));
      const [only] = into.values();
      warnings.add({
        id: null,
        message: "Moved " + group.length + (group.length === 1 ? " node" : " nodes") + " out of " + JSON.stringify(from.name ?? "") + " (id " + JSON.stringify(from.id) + ") into " +
          (into.size === 1 ? "new " + JSON.stringify(only.name ?? "") + " (id " + JSON.stringify(only.id) + ")" : into.size + " new containers") +
          (from.children?.length ? "" : "; the source is now empty") + ". If you intended a copy, restore the moved nodes and use flcm.clone.",
      });
    }
  } catch (error) {
    warnings.add({ id: null, message: "flcm." + verb + ": write succeeded; the moved-node check could not inspect the result: " + String(error) });
  } finally {
    beginMovedOutDiagnostics();
  }
}

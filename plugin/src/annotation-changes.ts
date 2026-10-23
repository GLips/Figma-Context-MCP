/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Which nodes' annotations changed, for a server watching the file (ANNOTATION_CHANGES). The log
// lives for the plugin run and keeps node ids only: a watcher is answered with each node's
// annotations as they are when it asks, so a burst of edits to one note reads as one change.
//
// Verified live (fig-72): a human editing a note in Figma's right panel fires the page's
// "nodechange" as PROPERTY_CHANGE with properties ["annotations"], origin LOCAL. So unlike
// document-changes.ts this counts every origin: the person annotating is usually the one whose
// Figma this plugin runs in. An agent's own annotation writes are logged too, and nothing here can
// tell them apart.
//
// Negative space: a deleted node that carried notes isn't logged (its DELETE carries no properties),
// and pages Figma hasn't loaded fire no events, so only notes on pages someone has opened are seen.
import { ANNOTATION_CHANGES_MAX_NODES, type AnnotationChange, type AnnotationCursor } from "./protocol.js";

/** How many changed nodes the log remembers; past it, the oldest go and a stale cursor is told so. */
export const ANNOTATION_LOG_LIMIT = 500;

/**
 * How long the log waits after a change for the next before answering a held ask, so typing a note
 * lands as one answer rather than one per keystroke batch. Never past the ask's hold.
 */
export const ANNOTATION_QUIET_MS = 1_500;

export interface AnnotationLogSlice {
  cursor: AnnotationCursor;
  /** Changed node ids, oldest change first. */
  nodeIds: string[];
  restarted: boolean;
  overflowed: boolean;
}

interface Timers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createAnnotationChangeLog({
  epoch,
  limit = ANNOTATION_LOG_LIMIT,
  quietMs = ANNOTATION_QUIET_MS,
  timers = realTimers,
}: {
  epoch: string;
  limit?: number;
  quietMs?: number;
  timers?: Timers;
}) {
  let seq = 0;
  // Highest seq dropped to stay under `limit`: a cursor below it may have missed those nodes.
  let droppedThrough = 0;
  // node id → seq of its latest change. Insertion order is change order: a re-change moves to the end.
  const latest = new Map<string, number>();
  const wakers = new Set<() => void>();

  function slice(after: AnnotationCursor | null): AnnotationLogSlice {
    if (after === null) return { cursor: { epoch, seq }, nodeIds: [], restarted: false, overflowed: false };
    const restarted = after.epoch !== epoch;
    const from = restarted ? 0 : after.seq;
    const nodeIds: string[] = [];
    let through = from;
    for (const [id, at] of latest) {
      if (at <= from) continue;
      if (nodeIds.length === ANNOTATION_CHANGES_MAX_NODES) break;
      nodeIds.push(id);
      through = at;
    }
    // Capped: the cursor stops at the last node read out, so the rest come on the next ask.
    const cursor = { epoch, seq: nodeIds.length === ANNOTATION_CHANGES_MAX_NODES ? through : Math.max(seq, from) };
    return { cursor, nodeIds, restarted, overflowed: droppedThrough > from };
  }

  return {
    /** A node's annotations changed. */
    record(nodeId: string): void {
      seq++;
      latest.delete(nodeId);
      latest.set(nodeId, seq);
      if (latest.size > limit) {
        const [oldest, at] = latest.entries().next().value as [string, number];
        latest.delete(oldest);
        droppedThrough = at;
      }
      for (const wake of [...wakers]) wake();
    },

    slice,

    /**
     * The changes after `after`: at once when there are some (or `after` is null, or from another
     * plugin run), else at the first change once edits go quiet, else empty when `holdMs` ends.
     */
    wait(after: AnnotationCursor | null, holdMs: number): Promise<AnnotationLogSlice> {
      const now = slice(after);
      if (after === null || now.restarted || now.nodeIds.length || holdMs <= 0) return Promise.resolve(now);
      return new Promise((resolve) => {
        let quiet: unknown;
        const finish = (): void => {
          timers.clear(hold);
          if (quiet !== undefined) timers.clear(quiet);
          wakers.delete(wake);
          resolve(slice(after));
        };
        const hold = timers.set(finish, holdMs);
        const wake = (): void => {
          if (quiet !== undefined) timers.clear(quiet);
          quiet = timers.set(finish, quietMs);
        };
        wakers.add(wake);
      });
    },
  };
}

export type AnnotationChangeLog = ReturnType<typeof createAnnotationChangeLog>;

/**
 * Feed `log` from every page's "nodechange" for the life of the plugin. Pages are attached at start
 * and again whenever the human switches page, which is how a page created later gets attached.
 */
export function watchAnnotationChanges(log: AnnotationChangeLog): void {
  const attached = new Set<string>();
  const onNodeChange = (event: NodeChangeEvent): void => {
    for (const change of event.nodeChanges)
      // Looks wrong, isn't: the typings' NodeChangeProperty omits "annotations", but Figma sends it.
      if (change.type === "PROPERTY_CHANGE" && (change.properties as readonly string[]).includes("annotations"))
        log.record(change.id);
  };
  const attachNewPages = (): void => {
    for (const page of figma.root.children) {
      if (attached.has(page.id)) continue;
      attached.add(page.id);
      page.on("nodechange", onNodeChange);
    }
  };
  attachNewPages();
  figma.on("currentpagechange", attachNewPages);
}

/** Each logged node's annotations as they are now, in flcm's read vocabulary. */
export async function readAnnotationChanges(nodeIds: readonly string[]): Promise<AnnotationChange[]> {
  if (!nodeIds.length) return [];
  const categories = new Map(
    (await figma.annotations.getAnnotationCategoriesAsync()).map((category) => [category.id, category.label]),
  );
  const changes: AnnotationChange[] = [];
  for (const id of nodeIds) {
    const node = await figma.getNodeByIdAsync(id);
    if (!node || node.removed || !("annotations" in node)) {
      changes.push({ id, removed: true });
      continue;
    }
    changes.push({
      id,
      name: node.name,
      type: node.type,
      path: ancestorPath(node),
      annotations: node.annotations.map((annotation) => {
        const text = annotation.labelMarkdown ?? annotation.label;
        const category = annotation.categoryId ? categories.get(annotation.categoryId) : undefined;
        return {
          ...(text !== undefined ? { text } : {}),
          ...(category !== undefined ? { category } : {}),
          ...(annotation.properties ? { properties: annotation.properties.map((property) => property.type) } : {}),
        };
      }),
    });
  }
  return changes;
}

// The page and every ancestor above the node, joined as get_figma_comments names nodes.
function ancestorPath(node: BaseNode): string {
  const names: string[] = [];
  for (let parent = node.parent; parent && parent.type !== "DOCUMENT"; parent = parent.parent) names.unshift(parent.name);
  return names.join(" › ");
}

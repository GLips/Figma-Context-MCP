/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Did the document change while one execution ran? This is what meters a Write, so it watches the
// document itself: agent code can reach `figma` directly, and a raw figma.createRectangle() is as
// much a Write as flcm.render().
//
// Why not figma.on("documentchange"): under `documentAccess: dynamic-page` it needs
// loadAllPagesAsync first, which loads every page of a large file on each run. The granular events
// Figma recommends instead are used together:
//   • PageNode "nodechange" on every page that exists when the run starts;
//   • figma "stylechange" for local styles;
//   • a before/after snapshot of the page list (ids, order, names) for page creation, deletion,
//     reordering and renaming — changes to the page nodes themselves, and to pages born mid-run.
//
// Figma delivers these events "periodically", with no deadline, and agent code can leave raw async
// writes running past its return. So the answer at reply time is provisional: the observer stays
// attached after the reply (watchLate) and reports either the first change it sees then, or that the
// watch closed without one.
//
// Only LOCAL-origin changes count: REMOTE ones are other people in the file. Negative space, named:
// variables and document-root properties have no change event and are not observed, and a human's
// own LOCAL edit that lands inside a run's window (late window included) is indistinguishable from
// the run's.

// One macrotask turn before the reply reads the answer: most of the run's own events are flushed to
// their listeners by then, which keeps the late path the exception rather than the rule.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function pageListSignature(): string {
  return JSON.stringify(figma.root.children.map((page) => [page.id, page.name]));
}

export interface DocumentChangeObserver {
  /** Whether a change has been seen so far, after one turn for pending events to arrive. */
  changedSoFar(): Promise<boolean>;
  /**
   * Keep listening past the reply. Exactly one of the two is called, once: `onChange` at the first
   * change, or `onSettled` when the watch closes without one — after `windowMs`, or at stop().
   */
  watchLate(watcher: LateWatcher, windowMs: number): void;
  /** Detach. A late watcher is told about a page-list change that landed before this. */
  stop(): void;
}

export interface LateWatcher {
  onChange(): void;
  onSettled(): void;
}

/** Start watching. Call stop() (directly, or through watchLate's window) exactly once. */
export function observeDocumentChanges(): DocumentChangeObserver {
  let changed = false;
  let stopped = false;
  let late: LateWatcher | null = null;
  let lateWindow: ReturnType<typeof setTimeout> | undefined;
  const sawChange = (): void => {
    changed = true;
    const watcher = late;
    if (!watcher) return;
    late = null;
    stop();
    watcher.onChange();
  };
  const onNodeChange = (event: NodeChangeEvent): void => {
    if (event.nodeChanges.some((change) => change.origin === "LOCAL")) sawChange();
  };
  const onStyleChange = (event: StyleChangeEvent): void => {
    if (event.styleChanges.some((change) => change.origin === "LOCAL")) sawChange();
  };
  const before = pageListSignature();
  const pages = [...figma.root.children];
  for (const page of pages) page.on("nodechange", onNodeChange);
  figma.on("stylechange", onStyleChange);

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (lateWindow !== undefined) clearTimeout(lateWindow);
    const watcher = late;
    late = null;
    // A page the run (or anyone) deleted mid-window can't be unsubscribed; it will never fire again
    // either. Each off is guarded on its own so one bad page can't leave the rest attached — this
    // runs in the host's finally and at the next run's start, where a throw would wedge the plugin.
    for (const page of pages) {
      if (page.removed) continue;
      try {
        page.off("nodechange", onNodeChange);
      } catch {
        /* detached already; nothing left to unsubscribe */
      }
    }
    figma.off("stylechange", onStyleChange);
    // A watcher still attached here has seen no change event: only the page list can still say one.
    if (!watcher) return;
    if (pageListSignature() !== before) watcher.onChange();
    else watcher.onSettled();
  }

  return {
    async changedSoFar() {
      await settle();
      if (!changed && pageListSignature() !== before) changed = true;
      return changed;
    },
    watchLate(watcher, windowMs) {
      if (stopped) return;
      late = watcher;
      lateWindow = setTimeout(stop, windowMs);
    },
    stop,
  };
}

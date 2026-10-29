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
// The answer at reply time is final. Figma delivers these events "periodically", with no deadline,
// and agent code can leave raw async writes running past its return, so a raw write whose event lands
// after the reply goes unmetered. Deliberate: watching past the reply held every short-lived caller
// open for a minute to catch an edge case. The reply never waits a turn for pending events either:
// Figma can stall the plugin's timers, which would then hold the run and every run behind it.
//
// Only LOCAL-origin changes count: REMOTE ones are other people in the file. Negative space, named:
// variables and document-root properties have no change event and are not observed, and a human's
// own LOCAL edit that lands while a run executes is indistinguishable from the run's.

function pageListSignature(): string {
  return JSON.stringify(figma.root.children.map((page) => [page.id, page.name]));
}

export interface DocumentChangeObserver {
  /** Whether a change has been seen so far. */
  changedSoFar(): boolean;
  /** Detach. */
  stop(): void;
}

/** Start watching. Call stop() exactly once. */
export function observeDocumentChanges(): DocumentChangeObserver {
  let changed = false;
  let stopped = false;
  const onNodeChange = (event: NodeChangeEvent): void => {
    if (event.nodeChanges.some((change) => change.origin === "LOCAL")) changed = true;
  };
  const onStyleChange = (event: StyleChangeEvent): void => {
    if (event.styleChanges.some((change) => change.origin === "LOCAL")) changed = true;
  };
  const before = pageListSignature();
  const pages = [...figma.root.children];
  for (const page of pages) page.on("nodechange", onNodeChange);
  figma.on("stylechange", onStyleChange);

  function stop(): void {
    if (stopped) return;
    stopped = true;
    // A page the run (or anyone) deleted mid-run can't be unsubscribed; it will never fire again
    // either. Each off is guarded on its own so one bad page can't leave the rest attached — this
    // runs in the host's finally, where a throw would wedge the plugin.
    for (const page of pages) {
      if (page.removed) continue;
      try {
        page.off("nodechange", onNodeChange);
      } catch {
        /* detached already; nothing left to unsubscribe */
      }
    }
    figma.off("stylechange", onStyleChange);
  }

  return {
    changedSoFar() {
      if (!changed && pageListSignature() !== before) changed = true;
      return changed;
    },
    stop,
  };
}

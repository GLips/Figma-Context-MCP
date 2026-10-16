/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// What each agent call has done in this file, for the human: its intent, the session it ran in, and
// where it stands, keyed by execution id. In memory for this plugin run only, newest first, capped.
// The grant gate reports prompts and the human's answers; the host and the runner report runs.
import type { ActivityOutcome, PanelActivity } from "./panel.js";

/** One call in the feed; the panel labels its project. */
export type ActivityEntry = Omit<PanelActivity, "label"> & { project: string | null };

/** Enough to see what every agent did lately without pushing the grant rows off the panel. */
export const ACTIVITY_FEED_LIMIT = 10;

// A run's outcome moves forward only: a resubmitted id (a refused session handle) may start over,
// but nothing moves a settled run.
const SETTLED: ReadonlySet<ActivityOutcome> = new Set(["done", "failed", "cancelled"]);

// What the cap may drop: a call with nothing left to report. Anything still in flight stays, even
// past the cap, so a long run's final outcome isn't lost behind a burst of refused calls.
const FINISHED: ReadonlySet<ActivityOutcome> = new Set([...SETTLED, "refused", "denied", "not-run"]);

/** Where the plugin moves a call; waiting and not-run come from its prompt being live or not. */
export type ActivityAdvance = Exclude<ActivityOutcome, "waiting" | "not-run">;

export function createActivityFeed(show: () => void) {
  // Insertion order is age: a Map keeps it, and a new call is appended, so newest is last.
  const entries = new Map<string, ActivityEntry>();

  function entryFor(executionId: string, intent: string, project: string | null): ActivityEntry {
    let entry = entries.get(executionId);
    if (!entry) {
      entry = { executionId, intent, project, session: null, outcome: "waiting" };
      entries.set(executionId, entry);
    }
    return entry;
  }

  return {
    /** A call's prompt opened here; a call refused before may be asked again. */
    waiting(executionId: string, intent: string, project: string): void {
      const entry = entryFor(executionId, intent, project);
      if (!SETTLED.has(entry.outcome)) entry.outcome = "waiting";
      show();
    },

    /** A run arrived for a call: it joins the feed if its prompt never showed here. */
    arrived(executionId: string, intent: string, project: string | null): void {
      entryFor(executionId, intent, project);
    },

    /** Move a call on. `session` is set when it is admitted to run (null for a screenshot). */
    advance(executionId: string, outcome: ActivityAdvance, session?: string | null): void {
      const entry = entries.get(executionId);
      if (!entry || SETTLED.has(entry.outcome)) return;
      entry.outcome = outcome;
      if (session !== undefined) entry.session = session;
      show();
    },

    /**
     * Newest first. `promptLive` says whether a waiting call's prompt still shows: one that lapsed,
     * closed or was dropped reads as not run. Past the cap, the oldest finished calls are dropped.
     */
    entries(promptLive: (executionId: string) => boolean): ActivityEntry[] {
      const shown = [...entries.values()].map((entry) =>
        entry.outcome === "waiting" && !promptLive(entry.executionId) ? { ...entry, outcome: "not-run" as const } : { ...entry },
      );
      let excess = shown.length - ACTIVITY_FEED_LIMIT;
      const kept = shown.filter((entry) => {
        if (excess <= 0 || !FINISHED.has(entry.outcome)) return true;
        excess--;
        entries.delete(entry.executionId);
        return false;
      });
      return kept.reverse();
    },
  };
}

export type ActivityFeed = ReturnType<typeof createActivityFeed>;

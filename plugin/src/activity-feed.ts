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

// A run's outcome moves forward only: a late "not-run" from a prompt closing must not overwrite a
// run already under way, and a resubmitted id (a refused session handle) may start over.
const SETTLED: ReadonlySet<ActivityOutcome> = new Set(["done", "failed", "cancelled"]);

export function createActivityFeed(show: () => void) {
  // Insertion order is age: a Map keeps it, and a new call is appended, so newest is last.
  const entries = new Map<string, ActivityEntry>();

  function entryFor(executionId: string, intent: string, project: string | null): ActivityEntry {
    let entry = entries.get(executionId);
    if (!entry) {
      entry = { executionId, intent, project, session: null, outcome: "waiting" };
      entries.set(executionId, entry);
      if (entries.size > ACTIVITY_FEED_LIMIT) entries.delete(entries.keys().next().value!);
    }
    return entry;
  }

  function set(executionId: string, outcome: ActivityOutcome, session?: string): void {
    const entry = entries.get(executionId);
    if (!entry || SETTLED.has(entry.outcome)) return;
    entry.outcome = outcome;
    if (session !== undefined) entry.session = session;
    show();
  }

  return {
    /** A call's prompt opened here. */
    waiting(executionId: string, intent: string, project: string): void {
      const entry = entryFor(executionId, intent, project);
      if (entry.outcome !== "waiting") set(executionId, "waiting");
      else show();
    },

    /** A run arrived for a call: it joins the feed if its prompt never showed here. */
    arrived(executionId: string, intent: string, project: string | null): void {
      entryFor(executionId, intent, project);
    },

    /** The human answered, or the plugin decided, a call's next step. */
    update(executionId: string, outcome: Exclude<ActivityOutcome, "waiting" | "queued">): void {
      set(executionId, outcome);
    },

    /** The call's prompt ended without an answer here. */
    promptEnded(executionId: string): void {
      if (entries.get(executionId)?.outcome === "waiting") set(executionId, "not-run");
    },

    /** A run was admitted under `session` (null for a screenshot) and waits its turn. */
    queued(executionId: string, session: string | null): void {
      set(executionId, "queued", session ?? undefined);
    },

    /**
     * Newest first. `promptLive` says whether a waiting call's prompt still shows: one that lapsed
     * because its server stopped asking reads as not run.
     */
    entries(promptLive: (executionId: string) => boolean): ActivityEntry[] {
      return [...entries.values()].reverse().map((entry) =>
        entry.outcome === "waiting" && !promptLive(entry.executionId) ? { ...entry, outcome: "not-run" } : { ...entry },
      );
    },
  };
}

export type ActivityFeed = ReturnType<typeof createActivityFeed>;

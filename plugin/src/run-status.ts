/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// What a run's RUN_STATUS says, as pure functions of the plugin's run rows and a clock: what a
// running run is pending on, and where each queued run stands. The registry (run-registry.ts) holds
// the rows; nothing here keeps state.
import {
  type CallOperation,
  type QueueBlocker,
  type QueueWait,
  type RunActivity,
  type RunPhase,
} from "./protocol.js";
import type { CallToken } from "./preamble/host.js";

/** A reported call still pending: `operation` is null for a name the host refused to repeat. */
interface PendingCallRow {
  operation: CallOperation | null;
  since: number;
}

/** A code run's calls, from the moment it runs. Map order is start order, so oldest first. */
interface RunCalls {
  pending: Map<CallToken, PendingCallRow>;
  settled: number;
}

export function runActivity(calls: RunCalls | null, now: number): RunActivity {
  if (!calls) return { callsSettled: 0 };
  for (const { operation, since } of calls.pending.values())
    if (operation) return { callsSettled: calls.settled, oldestPending: { operation, sinceMs: now - since } };
  return { callsSettled: calls.settled };
}

/** One run as the queue sees it. */
export interface QueueRow {
  id: string;
  connKey: number;
  kind: "code" | "screenshot";
  intent: string;
  session: string | null;
  phase: RunPhase;
  /** When it reached the front of the write chain: from then on, every run behind waits on it. */
  frontAt: number | null;
  cancelledAt: number | null;
  /** Null for a screenshot, and for a code run until it runs. */
  calls: RunCalls | null;
}

/** The blocker as one recipient may see it: another link's session handle never crosses. */
function queueBlocker(blocker: QueueRow, recipientConnKey: number, now: number): QueueBlocker {
  const sameLink = blocker.connKey === recipientConnKey;
  const report: QueueBlocker = {
    executionId: blocker.id,
    kind: blocker.kind,
    sameLink,
    intent: blocker.intent,
    runningForMs: now - (blocker.frontAt ?? now),
  };
  if (sameLink && blocker.session !== null) report.session = blocker.session;
  if (blocker.cancelledAt !== null) report.cancelledForMs = now - blocker.cancelledAt;
  if (blocker.kind === "code" && blocker.calls) report.activity = runActivity(blocker.calls, now);
  return report;
}

/**
 * Where `row` stands in `rows`, which are in write-chain order. Every row in front of it counts, the
 * blocker included. The front row blocks only once it has reached the front: in the moment between
 * one run settling and the next being dequeued, there is no blocker yet.
 */
export function queueWait(rows: readonly QueueRow[], row: QueueRow, now: number): QueueWait {
  const ahead = rows.indexOf(row);
  const front = rows[0];
  return ahead > 0 && front.frontAt !== null ? { ahead, blocker: queueBlocker(front, row.connKey, now) } : { ahead };
}

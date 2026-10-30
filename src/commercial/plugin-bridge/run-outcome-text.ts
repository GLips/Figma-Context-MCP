/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The words for a run the server stopped waiting for, withdrew, or is still waiting on. Every
// sentence is a fact an agent acts on: what ran, what occupies the plugin, and what the plugin last
// said. Pure, so the ledger keeps only timers and correlation.
import {
  RUN_REQUEST_TYPES,
  type CancelAnswer,
  type QueueBlocker,
  type QueueWait,
  type RunActivity,
  type RunStatus,
  type ServerRequestType,
} from "@framelink/plugin/protocol";
import { figmaPausedReason } from "./figma-paused.js";

/**
 * Why the server gave up on a request: no answer to a request that is no run, the caller's budget,
 * or the caller itself. A run's silence is never one: it means Figma is busy.
 */
export type RunStopCause = "unanswered" | "budget" | "caller";

export const NO_CANCEL_ANSWER: CancelAnswer = { disposition: "unknown" };

export interface StoppedRunFacts {
  payloadType: ServerRequestType;
  cause: RunStopCause;
  /** The answer deadline or the budget, whichever `cause` names. */
  limitMs: number;
  answer: CancelAnswer;
  /** The plugin's latest RUN_STATUS for the run; null when it sent none. */
  latest: RunStatus | null;
  now: number;
}

const RUN_REQUESTS: ReadonlySet<ServerRequestType> = new Set(RUN_REQUEST_TYPES);

/**
 * The caller's rejection for a request the server stopped waiting for, worded from the plugin's
 * cancel answer. `not-submitted` only where nothing ran: a non-run request, or a run the plugin
 * confirms never started.
 */
export function stoppedRunText({
  payloadType,
  cause,
  limitMs,
  answer: { disposition, figmaPausedMs, blocker },
  latest,
  now,
}: StoppedRunFacts): { message: string; outcome: "not-submitted" | "unconfirmed" } {
  if (!RUN_REQUESTS.has(payloadType)) {
    const lead =
      cause === "unanswered"
        ? `The Figma plugin did not answer ${payloadType} within ${spelled(limitMs)}.`
        : cause === "budget"
          ? `The call's budget of ${spelled(limitMs)} ran out before the Figma plugin answered ${payloadType}.`
          : `The call was cancelled before the Figma plugin answered ${payloadType}.`;
    return { message: `${lead} Nothing was submitted.`, outcome: "not-submitted" };
  }
  const screenshot = payloadType === "SCREENSHOT";
  const lead =
    (cause === "budget"
      ? `The call's budget of ${spelled(limitMs)} ran out.`
      : "The call was cancelled.") +
    // A paused plugin is why the run made no progress, so it comes before what became of the run.
    (figmaPausedMs === undefined ? "" : ` ${figmaPausedReason(figmaPausedMs, "this file")}`);
  if (disposition === "never-executed")
    return {
      message:
        `${lead} ${notRunText(payloadType)}; this request made no changes. ` +
        (blocker
          ? blockerText(blocker)
          : "It was still queued, and the plugin will skip it. Retry as-is."),
      outcome: "not-submitted",
    };
  // A started screenshot may have placed a temporary context slice, removed only once its export
  // settles; a running status comes before the target is even resolved.
  if (screenshot)
    return {
      message:
        `${lead} Cancellation requested; the screenshot ` +
        (disposition === "was-running" ? "had started" : "may have started") +
        ", so its cleanup is unconfirmed.",
      outcome: "unconfirmed",
    };
  const state =
    disposition === "was-running"
      ? "the plugin confirmed the run was executing. It ends the run as soon as it handles the " +
        "cancel: what the run awaits is abandoned and its later figma.* calls are refused, but code " +
        "already in flight can still write to nodes it holds. Its writes so far stay."
      : "the run may still be executing.";
  return {
    message: `${lead} Cancellation requested; ${state} ${lastSeenText(latest, now)} Inspect affected nodes before retrying.`,
    outcome: "unconfirmed",
  };
}

/** The caller's rejection for a run withdrawn from the plugin's queue before it started. */
export function withdrawnRunText(
  payloadType: ServerRequestType,
  blocker: QueueBlocker | undefined,
): string {
  return (
    `${notRunText(payloadType)}: it was withdrawn from the plugin's queue, so this request made no changes.` +
    (blocker ? ` ${blockerText(blocker)}` : "")
  );
}

/** One line for a person watching a queued run: where it stands and what it waits on. */
export function queueWaitText({ ahead, blocker }: QueueWait): string {
  if (!blocker) return "Queued in the Figma plugin: next to run.";
  const cancelled =
    blocker.cancelledForMs === undefined
      ? ""
      : `, cancellation requested ${formatDuration(blocker.cancelledForMs)} ago`;
  return (
    `Queued in the Figma plugin with ${ahead} ahead, behind ${blockerLabel(blocker)}: ` +
    `running ${formatDuration(blocker.runningForMs)}${cancelled}.`
  );
}

/** What an MCP agent does about a code run its call's budget cut off. */
export function mcpBudgetAdviceText(budgetMs: number, cliName: string): string {
  return (
    `Split the work across smaller calls, or run it with \`npx ${cliName} execute\`, which has no ` +
    `${Math.round(budgetMs / 1000)}-second limit.`
  );
}

function notRunText(payloadType: ServerRequestType): string {
  return payloadType === "SCREENSHOT" ? "The screenshot was not taken" : "Your code did not run";
}

/** The run at the front of the queue, and that a retry lands behind it. */
function blockerText(blocker: QueueBlocker): string {
  const label = blockerLabel(blocker);
  return (
    `${label.charAt(0).toUpperCase()}${label.slice(1)} still occupies the plugin and has run ` +
    `${formatDuration(blocker.runningForMs)}.` +
    (blocker.cancelledForMs === undefined
      ? ""
      : ` Cancellation was requested ${formatDuration(blocker.cancelledForMs)} ago.`) +
    (blocker.activity ? ` Its last status: ${activitySummary(blocker.activity)}.` : "") +
    " Retrying now will queue behind it again."
  );
}

function blockerLabel({ kind, executionId, intent, session, sameLink }: QueueBlocker): string {
  // The protocol keeps another link's session off the wire, so `session` implies `sameLink`.
  const origin = session
    ? `, session ${session}`
    : sameLink
      ? ""
      : ", from another Framelink server";
  return `${kind === "screenshot" ? "screenshot" : "run"} ${executionId} (${JSON.stringify(intent)}${origin})`;
}

function lastSeenText(latest: RunStatus | null, now: number): string {
  if (!latest) return "The plugin sent no status for this run.";
  const ago = `Last seen ${formatDuration(Math.max(now - latest.at, 0))} ago:`;
  return latest.phase === "queued"
    ? `${ago} queued with ${latest.wait.ahead} ahead.`
    : `${ago} ${activitySummary(latest.activity)}.`;
}

function activitySummary({ callsSettled, oldestPending }: RunActivity): string {
  const waiting = oldestPending
    ? `${oldestPending.operation} pending for ${formatDuration(oldestPending.sinceMs)}`
    : "no call pending";
  return `${waiting}, ${callsSettled} ${callsSettled === 1 ? "call" : "calls"} settled`;
}

/** A limit as a sentence reads it: "15 seconds", or "100ms" for a test's short one. */
function spelled(ms: number): string {
  return ms >= 1_000 && ms % 1_000 === 0 ? `${ms / 1_000} seconds` : formatDuration(ms);
}

/** A run's length as an agent reads it: "850ms", "14s", "14m 02s". */
function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

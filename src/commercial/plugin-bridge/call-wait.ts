/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// What a plugin call is waiting on, as one value, and the only words for it. The value is produced
// where the waiting happens (targeting, the grant and pick prompts, sending, the run) and rendered
// here into every surface: MCP progress, the CLI's waiting lines, and the reply when a call stops
// waiting before anything was submitted (its deadline: an MCP check-in, a CLI's --wait). An agent acts on these, so
// each names its specific reason, and says plainly when a person has to do something.
import { RUN_STATUS_INTERVAL_MS } from "@framelink/plugin/protocol";
import { quoteFigmaName, REPORT_TO_PERSON } from "./blocked-call-guidance.js";
import { formatDuration, queueWaitText } from "./run-outcome-text.js";
import type { RunState } from "./run-ledger.js";

/**
 * What a call is waiting on now. `since` is when that wait began, for "asked 12s ago". An Allow
 * prompt is the project's, not the call's: it stays in the panel after the call stops waiting, and
 * the project's next call there waits on it rather than raising another.
 */
export type CallWait =
  // A one-shot CLI relay waits for any plugin to dial in, until the call's deadline.
  | { kind: "connecting"; deadline: number }
  // Not every open plugin has said which file it is in, so the call's file may have another copy.
  | { kind: "finding-file" }
  // Plugins open in these files haven't linked to this server yet.
  | { kind: "reconnecting"; fileNames: string[] }
  | { kind: "allow"; project: string; fileName: string; since: number }
  | { kind: "pick"; fileName: string; since: number }
  // Bound and allowed; the run hasn't reached the plugin yet.
  | { kind: "sending"; fileName: string; subject: "code" | "screenshot" }
  // Sent: null until the server's ledger holds it.
  | { kind: "run"; state: RunState | null };

/** A wait a call can stop in with nothing submitted, and be told why. */
export type UnsubmittedWait = Extract<
  CallWait,
  { kind: "finding-file" | "reconnecting" | "allow" | "pick" | "sending" }
>;

// Silence past this many heartbeats is worth telling a person watching.
const QUIET_PROGRESS_MS = 2 * RUN_STATUS_INTERVAL_MS;

/** One line for a person watching the call: MCP progress, or the CLI's line as the wait changes. */
export function callWaitLine(wait: CallWait, now: number): string {
  switch (wait.kind) {
    case "connecting":
      return `Waiting up to ${formatDuration(wait.deadline - now)} for the Framelink plugin in Figma.`;
    case "finding-file":
      return "Finding the Figma file…";
    case "reconnecting":
      return (
        `Waiting for Figma to reconnect in ${wait.fileNames.map(quoteFigmaName).join(", ")}; a hidden ` +
        `Figma window can take several seconds. Nothing has been submitted.`
      );
    case "allow":
      return (
        `Waiting for the user to click Allow for this project (${quoteFigmaName(wait.project)}) in the ` +
        `Framelink plugin panel in ${quoteFigmaName(wait.fileName)}, asked ` +
        `${formatDuration(now - wait.since)} ago. Nothing has been submitted.`
      );
    case "pick":
      return (
        `Waiting for the user to pick which open copy of ${quoteFigmaName(wait.fileName)} to edit, in ` +
        `its Framelink plugin panel, asked ${formatDuration(now - wait.since)} ago. Nothing has been submitted.`
      );
    case "sending":
      return "Sending to the Figma plugin…";
    case "run": {
      const { state } = wait;
      if (!state) return "Sending to the Figma plugin…";
      if (state.status?.phase === "queued") return queueWaitText(state.status.wait);
      const quietForMs = now - state.lastHeardAt;
      if (quietForMs > QUIET_PROGRESS_MS)
        return `No word from Figma for ${formatDuration(quietForMs)}: a long call such as a large export holds it…`;
      return state.status ? "Running…" : "Submitted; waiting for the Figma plugin to start it…";
    }
  }
}

/**
 * The answer for a call that stopped waiting with nothing submitted: on `mcp` when it checks in, on
 * `cli` when --wait runs out. `elapsedMs` is how long the call took.
 */
export function unsubmittedWaitText(
  wait: UnsubmittedWait,
  { surface, elapsedMs, now }: { surface: "mcp" | "cli"; elapsedMs: number; now: number },
): string {
  const notRun = surface === "cli" ? "the script did not run" : "nothing was submitted";
  switch (wait.kind) {
    case "allow": {
      const project = quoteFigmaName(wait.project);
      const file = quoteFigmaName(wait.fileName);
      const waited = formatDuration(now - wait.since);
      // Never "retry as-is": until the person clicks, a retry only waits on the same prompt.
      const lead =
        `Not run: approval hasn't been granted yet. This project (${project}) isn't allowed to edit ` +
        `${file}, and the user hasn't answered the Allow prompt in the Framelink plugin panel in ` +
        `${file}`;
      return surface === "mcp"
        ? `${lead} (this call waited ${waited}), so nothing was submitted. The prompt stays in that ` +
            `panel after this call. Tell the user to click Allow there. Once they have, retry this ` +
            `call as-is: it runs immediately, with no new prompt. A retry before they answer only ` +
            `waits on the same prompt.`
        : `${lead} within ${waited}, so ${notRun}. The prompt stays in that panel. Tell ` +
            `the user to click Allow there; once they have, re-running runs at once with no new ` +
            `prompt. Raise --wait to wait longer.`;
    }
    case "pick": {
      // A pick steers only the call that asked, so it goes with that call.
      const state =
        `${quoteFigmaName(wait.fileName)} is open as more than one file that share one identity (one ` +
        `is a copy), and nothing tells this server which one this call means`;
      const action =
        `someone clicks "Use this one" in the Framelink plugin of the file to edit, or "Give this ` +
        `copy its own identity" in the copy`;
      return surface === "mcp"
        ? `Blocked: ${state}, so ${notRun}. Required before retrying: ${action}. ` +
            `${REPORT_TO_PERSON} they confirm. The choice is made per call: retrying asks again.`
        : `Blocked: ${state}, so ${notRun}. Required before re-running: ${action}. ` +
            `This run waited ${formatDuration(now - wait.since)}; raise --wait if they need longer.`;
    }
    case "finding-file":
      return surface === "mcp"
        ? `Not submitted: not every open Framelink plugin had said which Figma file it is in before ` +
            `the call had to answer, so this server couldn't rule out another open copy of the file ` +
            `this call named, and nothing was submitted. Call again the same way.`
        : `Blocked: not every open Framelink plugin said which Figma file it is in within ` +
            `${formatDuration(elapsedMs)}, so this server couldn't rule out another open copy of the ` +
            `file named, and ${notRun}. Re-run, raising --wait.`;
    case "reconnecting": {
      const files = wait.fileNames.map(quoteFigmaName).join(", ");
      return surface === "mcp"
        ? `Not submitted: the Framelink plugin in ${files} is open but hadn't reconnected to this ` +
            `server before the call had to answer (a hidden Figma window can take several seconds), ` +
            `so nothing was submitted. Call again the same way; bringing that Figma window to the ` +
            `front makes it reconnect sooner.`
        : `Blocked: the Framelink plugin in ${files} is open but didn't reconnect within ` +
            `${formatDuration(elapsedMs)} (a hidden Figma window can take several seconds), so ` +
            `${notRun}. Re-run, raising --wait, or bring that Figma window to the front.`;
    }
    case "sending":
      return (
        `Not submitted: after ${formatDuration(elapsedMs)} this call had found ` +
        `${quoteFigmaName(wait.fileName)}, allowed, and was still getting ready to send ` +
        `${wait.subject === "screenshot" ? "the screenshot request" : "your code"} to ` +
        `Figma, so it stopped without sending it. Nothing ran and nothing will. No one needs to do ` +
        `anything: retry as-is.`
      );
  }
}

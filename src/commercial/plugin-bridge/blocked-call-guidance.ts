/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The wording every caller (MCP tools, the bridge's own rejections, the `execute` CLI) gives when a
// call is blocked on a state only a person can change. Agents looped on the older "…then retry"
// replies: each message names the blocker, the action required, and that retrying sooner cannot help.
// Submission status is the caller's sentence to add — only it knows whether code reached the plugin.

/** How long a disconnection counts as a redial blip before the reply escalates to a person. */
export const PLUGIN_RECONNECT_WINDOW_MS = 30_000;

const REPORT_TO_PERSON = "Report this to the user or coordinating agent, and retry only after";

/**
 * A pre-submission "plugin is not connected" reply. Inside the reconnect window the plugin is most
 * likely redialing, so the reply says to wait; past it (or with no disconnection on record) it names
 * the person's action. `elapsedMs` is `PluginBridge.disconnectedDurationMs()`.
 */
export function pluginDisconnectedNotSubmittedText(elapsedMs: number | null): string {
  if (elapsedMs !== null && elapsedMs < PLUGIN_RECONNECT_WINDOW_MS) {
    return (
      `The Framelink plugin disconnected ${Math.round(elapsedMs / 1000)}s ago and usually reconnects ` +
      `within a few seconds. This call was not submitted. Wait a few seconds, then retry.`
    );
  }
  return `Blocked: the Framelink plugin is disconnected. This call was not submitted. ${pluginDisconnectedAction()}`;
}

/** The person's action once a disconnection has outlasted any wait. */
export function pluginDisconnectedAction(): string {
  return (
    `Required before retrying: someone opens the Framelink plugin in the intended Figma file, with ` +
    `this server running. ${REPORT_TO_PERSON} the plugin is open — retrying sooner fails the same way.`
  );
}

/**
 * Approval is still pending after the wait expired, on a server that outlives the call (MCP). A later
 * Allow approves the session, never the finished call: nothing is queued to replay, so the caller
 * must submit again.
 */
export function approvalPendingAction(pairingCode: string | null, waitMs: number): string {
  const session = pairingCode ? `pairing code ${pairingCode}` : "this session";
  return (
    `Blocked: session approval is pending. Required before retrying: someone clicks Allow for ` +
    `${session} in the Framelink plugin in Figma, where the request now shows as expired. ` +
    `${REPORT_TO_PERSON} they confirm the approval — each attempt waits up to ` +
    `${Math.round(waitMs / 1000)}s and cannot succeed without them. Approving later does not run ` +
    `this call; submit it again.`
  );
}

/**
 * The `execute` CLI's form: its relay ends with the run, but the plugin keeps the expired request, and
 * an Allow there carries to the next run from this directory. Nothing replays — the person's Allow
 * approves the session, and only re-running sends the script.
 */
export function approvalPendingRerunAction(pairingCode: string | null, waitMs: number): string {
  const request = pairingCode
    ? `the request with pairing code ${pairingCode}`
    : "this run's request";
  return (
    `Blocked: session approval is pending, and this run has ended without sending the script. ` +
    `Required before re-running: someone clicks Allow on ${request} in the Framelink plugin in Figma, ` +
    `where it now shows as expired. That approves the next run from this directory while the plugin ` +
    `stays open, provided it reconnects on the same port; it does not run this one. If the next run ` +
    `prints a new pairing code instead, approve that one. ${REPORT_TO_PERSON} they confirm the approval — this run ` +
    `waited ${Math.round(waitMs / 1000)}s; raise --wait if they need longer.`
  );
}

/** The plugin is connected but never answered an approval check before the wait expired. */
export function pluginUnresponsiveText(): string {
  return (
    `Blocked: the Framelink plugin is connected but did not answer the approval check before the wait ` +
    `expired, so no code was submitted. Required before retrying: someone closes and reopens the ` +
    `Framelink plugin in Figma. ${REPORT_TO_PERSON} it is reopened.`
  );
}

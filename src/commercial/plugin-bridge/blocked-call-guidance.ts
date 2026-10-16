/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Every sentence a caller (MCP tools, the bridge's own rejections, the `execute` CLI, the reference
// tool) gives about linking, pairing and approval, worded from the state it is in. Agents looped on
// the older "…then retry" replies: each blocked message names the blocker, the action required, and
// that retrying sooner cannot help. Submission status is part of the state's sentence where only one
// is true; nothing outside this module words them.

/** How long a disconnection counts as a redial blip before the reply escalates to a person. */
export const PLUGIN_RECONNECT_WINDOW_MS = 30_000;

const REPORT_TO_PERSON = "Report this to the user or coordinating agent, and retry only after";

/**
 * Where a call stands with the plugin, as far as the wording goes. `waiting` is a call still waiting
 * on the human's Allow; `expired` is one whose wait ended with none. The `reference-` states come only
 * from get_flcm_reference's status lookup, which never waits. Approved has no sentence, so it is not a
 * state.
 */
export type ApprovalGuidanceState =
  | { kind: "disconnected"; elapsedMs: number | null }
  | { kind: "incompatible"; refusal: string }
  | { kind: "unpaired" }
  | { kind: "several-files"; count: number }
  | { kind: "reference-pending" }
  | { kind: "waiting" }
  | { kind: "expired"; waitMs: number }
  | { kind: "rejected" }
  | { kind: "unresponsive" }
  | { kind: "reference-status-unknown" };

/**
 * Who reads it. `mcp` is a tool result on a server that outlives the call; `cli` is the `execute`
 * command, whose relay ends with the run; `reference` is get_flcm_reference's note above the docs,
 * which never waits on approval and never submits code.
 */
export type GuidanceSurface = "mcp" | "cli" | "reference";

/** The sentence for `state` on `surface`. */
export function approvalGuidance(state: ApprovalGuidanceState, surface: GuidanceSurface): string {
  switch (state.kind) {
    case "incompatible":
      return state.refusal;
    case "disconnected":
      return surface === "reference"
        ? "No compatible Figma plugin is connected. Open the Framelink plugin in Figma, then check its connection before executing code. The reference is available below."
        : pluginDisconnectedNotSubmittedText(state.elapsedMs);
    case "unpaired":
      return unpairedGuidance(surface);
    case "several-files":
      return (
        `Blocked: the Framelink plugin is open in ${state.count} Figma files, and this server can't ` +
        `tell which one you mean, so nothing was submitted. Required before retrying: someone closes ` +
        `the plugin in every file except the one to work in. ${REPORT_TO_PERSON} only one is open.`
      );
    case "waiting":
      return "Waiting for approval in Figma. Code has not been submitted.";
    case "reference-pending":
      return "Approval is required before executing code. Ask the user to click Allow for this session in the Framelink plugin. This reference request does not wait for approval or submit code.";
    // On the reference, a rejected request reads like an open one: an Allow on that row still works.
    case "rejected":
      return surface === "reference"
        ? approvalGuidance({ kind: "reference-pending" }, surface)
        : "Approval rejected; no code was submitted.";
    case "expired":
      return surface === "cli"
        ? `The script did not run. ${approvalPendingRerunAction(state.waitMs)}`
        : `This call did not run. ${approvalPendingAction(state.waitMs)}`;
    case "unresponsive":
      return (
        `Blocked: the Framelink plugin is connected but did not answer the approval check before the wait ` +
        `expired, so no code was submitted. Required before retrying: someone closes and reopens the ` +
        `Framelink plugin in Figma. ${REPORT_TO_PERSON} it is reopened.`
      );
    case "reference-status-unknown":
      return "The plugin's approval status could not be checked. Check the Framelink plugin connection before executing code. The reference is available below; no code was submitted.";
  }
}

function unpairedGuidance(surface: GuidanceSurface): string {
  switch (surface) {
    case "reference":
      return "This server isn't paired with the Framelink plugin yet. Before executing code, call pair_figma_plugin, which shows a pairing code in the plugin panel for the user to confirm. The reference is available below.";
    case "cli":
      return (
        `Blocked: this server isn't paired with the Framelink plugin, so the script did not run. ` +
        `Required before re-running: someone runs \`npx figma-developer-mcp pair\` in a terminal and ` +
        `types the code the Framelink plugin panel shows. Pairing is remembered, so this is needed once.`
      );
    case "mcp":
      return "Blocked: this server isn't paired with the Framelink plugin, so nothing was submitted. Call pair_figma_plugin to start pairing.";
  }
}

/**
 * What the agent is told once a pairing code is showing and the client couldn't confirm it in a
 * prompt: ask the person, then confirm with the code they saw. Only a code the person reports seeing
 * may be confirmed — that comparison is the whole check.
 */
export function pairingConfirmationGuidance(codes: readonly string[], expiresInMs: number): string {
  const shown =
    codes.length === 1
      ? `the pairing code ${codes[0]}`
      : `one of these pairing codes: ${codes.join(", ")}`;
  const call =
    codes.length === 1
      ? `pair_figma_plugin with { "code": "${codes[0]}" }`
      : `pair_figma_plugin with { "code": "<the code they see>" }`;
  return (
    `Pairing required: this server isn't paired with the Framelink plugin yet, so nothing was ` +
    `submitted. Ask the user whether the Framelink plugin panel in Figma shows ${shown}. Only if they ` +
    `say it does, call ${call}, then retry. If the panel shows no code or a different one, do not ` +
    `pair: something other than the plugin may be connected. The code expires in ` +
    `${Math.max(1, Math.round(expiresInMs / 60_000))} minutes.`
  );
}

/** The human said the panel doesn't show the code. That attempt is over; nothing paired. */
export function pairingDeclinedText(): string {
  return (
    "The user said the Framelink plugin panel doesn't show the pairing code, so this server didn't " +
    "pair with it and nothing was submitted. Something other than the plugin may be connected. " +
    "Don't retry pairing unless the user asks to."
  );
}

export function pairingRateLimitedText(retryAfterMs: number): string {
  return (
    `Blocked: too many pairing attempts were started recently, so no new code was shown and nothing ` +
    `was submitted. Retry pairing after ${Math.ceil(retryAfterMs / 60_000)} minutes.`
  );
}

/** A confirmation naming a code no open attempt shows: expired, already used, or mistyped. */
export function pairingCodeUnknownText(code: string): string {
  return (
    `No pairing attempt is showing the code ${code}: it expired, was already used, or was mistyped. ` +
    `Nothing was paired. Call pair_figma_plugin without a code to show a fresh one.`
  );
}

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
function approvalPendingAction(waitMs: number): string {
  return (
    `Blocked: session approval is pending. Required before retrying: someone clicks Allow for this ` +
    `session in the Framelink plugin in Figma, where the request now shows as expired. ` +
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
function approvalPendingRerunAction(waitMs: number): string {
  return (
    `Blocked: session approval is pending, and this run has ended without sending the script. ` +
    `Required before re-running: someone clicks Allow on this run's request in the Framelink plugin ` +
    `in Figma, where it now shows as expired. That approves the next run from this directory while ` +
    `the plugin stays open, provided it reconnects on the same port; it does not run this one. ` +
    `${REPORT_TO_PERSON} they confirm the approval — this run waited ` +
    `${Math.round(waitMs / 1000)}s; raise --wait if they need longer.`
  );
}

/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Every sentence a caller (MCP tools, the bridge's own rejections, the CLI commands, the reference
// tool) gives about linking, pairing, documents and grants, worded from the state it is in. Agents looped on
// the older "…then retry" replies: each blocked message names the blocker, the action required, and
// that retrying sooner cannot help. Submission status is part of the state's sentence where only one
// is true; nothing outside this module words them.
import { CLI_NAME } from "~/utils/cli-help.js";
import type { UnlinkedResolution } from "./bridge.js";
import type { CallTargetBlock } from "./call-target.js";

/** How long a disconnection counts as a redial blip before the reply escalates to a person. */
export const PLUGIN_RECONNECT_WINDOW_MS = 30_000;

const REPORT_TO_PERSON = "Report this to the user or coordinating agent, and retry only after";

/**
 * Who reads it. `mcp` is a tool result on a server that outlives the call; `cli` is a command whose
 * relay ends with the run; `reference` is get_flcm_reference's note above the docs, which never
 * waits on a grant, never pairs, and never submits code.
 */
export type GuidanceSurface = "mcp" | "cli" | "reference";

/** Why a call that needs the plugin has no link to run on. */
export function linkGuidance(resolution: UnlinkedResolution, surface: GuidanceSurface): string {
  switch (resolution.kind) {
    case "incompatible":
      return resolution.refusal;
    case "disconnected":
      return surface === "reference"
        ? "No compatible Figma plugin is connected. Open the Framelink plugin in Figma, then check its connection before executing code. The reference is available below."
        : pluginDisconnectedNotSubmittedText(resolution.elapsedMs);
    case "unpaired":
      return unpairedGuidance(surface);
    case "credential-unusable":
      return (
        `Blocked: this server can't use its Framelink plugin pairing credential, so nothing was ` +
        `submitted. ${resolution.problem} ${REPORT_TO_PERSON} it is fixed.`
      );
  }
}

/** A call on a linked plugin, waiting for the human to allow this project in Figma. */
export const GRANT_WAITING_TEXT =
  "Waiting for the user to allow this project in the Framelink plugin in Figma. Code has not been submitted.";

/** Why a call got no document to run against, on `surface`. Nothing was submitted. */
export function callTargetGuidance(
  block: CallTargetBlock,
  surface: "mcp" | "cli",
  waitMs: number,
): string {
  const retry = surface === "mcp" ? "retrying" : "re-running";
  switch (block.kind) {
    case "document-not-open":
      return (
        `Blocked: the Framelink plugin isn't open in the Figma file ${block.fileKey}, so nothing was ` +
        `submitted and no plugin panel was asked. Required before ${retry}: someone opens the ` +
        `Framelink plugin in that file. ${REPORT_TO_PERSON} it is open. To work in a file that is ` +
        `already open, call again without a file key and the user picks it in Figma.`
      );
    case "document-unprovable":
      return (
        `Blocked: this server couldn't confirm which Figma file the Framelink plugin is in ` +
        `(${block.problem}), so nothing was submitted. It confirms that by reading the file with ` +
        `the Figma token, so the token must be able to open the file. ${REPORT_TO_PERSON} that is fixed.`
      );
    case "grant-denied":
      return (
        `Blocked: the user denied this project access to "${block.fileName}" in the Framelink ` +
        `plugin, so nothing was submitted. Don't retry unless the user asks to; they can click ` +
        `Allow on this project's row in the plugin.`
      );
    case "grant-unavailable":
      return (
        `Blocked: the Framelink plugin in "${block.fileName}" has no signed-in Figma user, so it ` +
        `can't let this project edit the file, and nothing was submitted. ${REPORT_TO_PERSON} ` +
        `someone signs in to Figma and reopens the plugin.`
      );
    case "grant-expired": {
      const file = block.fileName === null ? "a Figma file" : `"${block.fileName}"`;
      const action =
        block.fileName === null
          ? `someone picks the file to edit in the Framelink plugin in Figma (Allow, or Use this file), ` +
            `or pastes the file's link into the plugin if it asks for one`
          : `someone clicks Allow for this project in the Framelink plugin in ${file}`;
      return surface === "mcp"
        ? `Blocked: this project isn't allowed to edit ${file} yet, so this call did not run. ` +
            `Required before retrying: ${action}. ${REPORT_TO_PERSON} they confirm — each attempt ` +
            `waits up to ${Math.round(waitMs / 1000)}s and cannot succeed without them. Allowing ` +
            `later does not run this call; submit it again.`
        : `Blocked: this project isn't allowed to edit ${file} yet, so the script did not run. ` +
            `Required before re-running: ${action}. A grant is remembered for this project, so it is ` +
            `needed once. This run waited ${Math.round(waitMs / 1000)}s; raise --wait if they need longer.`;
    }
  }
}

/**
 * The plugin refused a run after this server bound it: the grant was revoked, or the plugin isn't in
 * that file any more. The plugin refused it before it ran.
 */
export function notGrantedText(reason: "no-grant" | "other-document", fileName: string): string {
  return reason === "no-grant"
    ? `Blocked: the Framelink plugin refused the run because this project is no longer allowed to ` +
        `edit "${fileName}" (the user revoked it), so nothing ran. Don't retry unless the user asks to.`
    : `Blocked: the Framelink plugin refused the run because it is no longer in "${fileName}", so ` +
        `nothing ran. Retry once the plugin is open in that file again.`;
}

/**
 * get_flcm_reference's note on where this project stands with the open files. It never prompts:
 * it reads grants, and says what an execute call will ask.
 */
export function referenceGrantGuidance(grantedFiles: readonly string[] | null): string | undefined {
  if (grantedFiles === null)
    return "The plugin's grants could not be checked. Check the Framelink plugin connection before executing code. The reference is available below; no code was submitted.";
  if (grantedFiles.length === 1) return undefined;
  if (grantedFiles.length > 1)
    return `This project may edit ${grantedFiles.length} open Figma files (${grantedFiles.map((name) => `"${name}"`).join(", ")}). Pass fileKey when executing code to name one; without it the user is asked to pick.`;
  return "This project isn't allowed to edit any open Figma file yet. Executing code asks the user to allow it in the Framelink plugin; pass fileKey to name the file. This reference request does not ask or submit code.";
}

function unpairedGuidance(surface: GuidanceSurface): string {
  switch (surface) {
    case "reference":
      return "This server isn't paired with the Framelink plugin yet. Before executing code, call pair_figma_plugin, which shows a pairing code in the plugin panel for the user to confirm. The reference is available below.";
    case "cli":
      return (
        `Blocked: this server isn't paired with the Framelink plugin, so the script did not run. ` +
        `Required before re-running: someone runs \`npx ${CLI_NAME} pair\` in a terminal and ` +
        `confirms the code the Framelink plugin panel shows. Pairing is remembered, so this is needed once.`
      );
    case "mcp":
      return "Blocked: this server isn't paired with the Framelink plugin, so nothing was submitted. Call pair_figma_plugin to start pairing.";
  }
}

/**
 * What the agent is told once pairing codes are showing and the client couldn't confirm them in a
 * prompt. Only a code the person reports seeing may be confirmed — that comparison is the whole
 * check. With several codes showing (a page posing as the plugin beside it, say), the reply names
 * none of them, so a bare "yes" can't confirm one the person wasn't shown.
 */
export function pairingConfirmationGuidance(codes: readonly string[], expiresInMs: number): string {
  const minutes = Math.max(1, Math.floor(expiresInMs / 60_000));
  const expires = `The code expires within ${minutes} minute${minutes === 1 ? "" : "s"}.`;
  const lead =
    "Pairing required: this server isn't paired with the Framelink plugin yet, so nothing was submitted.";
  if (codes.length === 1)
    return (
      `${lead} Ask the user whether the Framelink plugin panel in Figma shows the pairing code ` +
      `${codes[0]}. Only if they say it does, call pair_figma_plugin with { "code": "${codes[0]}" }, ` +
      `then retry. If the panel shows no code or a different one, do not pair: something other than ` +
      `the plugin may be connected. ${expires}`
    );
  return (
    `${lead} More than one connection is waiting to pair, so something other than the plugin may be ` +
    `connected. Ask the user to read out the exact pairing code the Framelink plugin panel in Figma ` +
    `shows, then call pair_figma_plugin with { "code": "<the code they read out>" }, and retry. Pass ` +
    `only the code the user reads out, never one guessed or taken from anywhere else. If the panel ` +
    `shows no code, do not pair. ${expires}`
  );
}

/** Every code shown for this call lapsed before anyone confirmed it. */
export function pairingCodeExpiredText(surface: "mcp" | "cli"): string {
  return (
    `The pairing code expired before it was confirmed, so nothing was paired or submitted. ` +
    (surface === "mcp"
      ? "Retry the call to show a fresh code."
      : "Run the command again to show a fresh code.")
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

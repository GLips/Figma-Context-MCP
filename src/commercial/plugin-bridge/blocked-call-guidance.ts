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
import {
  unnamedCallDefault,
  type CallTargetBlock,
  type NoUnnamedCallDefault,
  type OpenDocument,
  type OpenDocumentSnapshot,
} from "./call-target.js";

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

/** A call on a linked plugin, waiting for the human to allow this project, or pick a file, in Figma. */
export const GRANT_WAITING_TEXT =
  "Waiting for the user to answer this call in the Framelink plugin in Figma. Code has not been submitted.";

// A file's pages are there to tell files apart, not to list a document: a few is enough.
const LISTED_PAGES = 5;

/**
 * A file or page name as agent-facing text. Anyone who can edit an open file sets these, so they are
 * escaped: a quote or newline in one can't forge another line of the open-document list.
 */
export function quoteFigmaName(name: string): string {
  return JSON.stringify(name);
}

function documentFlag(surface: GuidanceSurface): string {
  return surface === "cli" ? "--document" : "document";
}

/** One open document, as a line an agent chooses from. */
function openDocumentLine(document: OpenDocument): string {
  const pages = document.pageNames.slice(0, LISTED_PAGES).map(quoteFigmaName);
  const more = document.pageNames.length - pages.length;
  const parts = [
    `document ${document.documentId}`,
    `pages ${pages.join(", ") || "(none)"}${more > 0 ? ` and ${more} more` : ""}`,
    ...(document.fileKey ? [`fileKey ${document.fileKey}`] : []),
    {
      granted: "this project may edit it",
      "not-granted": "this project isn't allowed yet (the user is asked to Allow)",
      unknown: "this project's access couldn't be checked",
    }[document.grant],
    ...(document.copies > 1
      ? [`open as ${document.copies} files that share this id (the user picks one in Figma)`]
      : []),
  ];
  return `- ${quoteFigmaName(document.fileName)}: ${parts.join("; ")}`;
}

/**
 * Every open plugin's document, for an agent to choose from by name: the same list a refusal, the
 * reference and the CLI show. Ends with how to name one.
 */
export function openDocumentsText(open: OpenDocumentSnapshot, surface: GuidanceSurface): string {
  const lines: string[] = [];
  if (open.documents.length) {
    lines.push("Figma files open with the Framelink plugin:");
    lines.push(...open.documents.map(openDocumentLine));
  } else lines.push("No open Framelink plugin is in a Figma file this server can use.");
  for (const problem of open.unidentified)
    lines.push(`A plugin can't be used because it couldn't mark its file: ${problem}`);
  if (!open.complete)
    lines.push(
      "Not every open plugin has reconnected and said which file it is in, or whether this project " +
        "may edit it, so " +
        "this list may be missing some.",
    );
  if (open.documents.length)
    lines.push(
      `Pick the file by its name and pages — read the project's own files, or ask the user if you ` +
        `aren't sure — and pass its id as ${documentFlag(surface)}. Never guess between files.`,
    );
  return lines.join("\n");
}

/** Why a call got no document to run against, on `surface`. Nothing was submitted. */
export function callTargetGuidance(
  block: CallTargetBlock,
  surface: "mcp" | "cli",
  waitMs: number,
): string {
  switch (block.kind) {
    case "document-not-open":
      return (
        `Blocked: no open Framelink plugin is in ${namedDocument(block.document, block.fileKey)}, ` +
        `so nothing was submitted and no plugin panel was asked. A file key matches only plugins ` +
        `that reported one; a document id is what every plugin reports. To work in that file, ` +
        `someone opens the Framelink plugin in it. ${REPORT_TO_PERSON} it is open.\n\n` +
        openDocumentsText(block.open, surface)
      );
    case "document-unchosen":
      return `${unchosenLead(block.reason)}\n\n${openDocumentsText(block.open, surface)}`;
    case "document-changed":
      return (
        `Blocked: ${quoteFigmaName(block.fileName)} was given a new identity in the Framelink plugin while this ` +
        `call waited (a copy of a file now has its own), so nothing was submitted. Choose the file ` +
        `again from the list below.\n\n${openDocumentsText(block.open, surface)}`
      );
    case "grant-denied":
      return (
        `Blocked: the user denied this call access to ${quoteFigmaName(block.fileName)} in the Framelink ` +
        `plugin, so nothing was submitted. Don't retry unless the user asks to.`
      );
    case "grant-unavailable":
      return (
        `Blocked: the Framelink plugin in ${quoteFigmaName(block.fileName)} has no signed-in Figma user, so it ` +
        `can't let this project edit the file, and nothing was submitted. ${REPORT_TO_PERSON} ` +
        `someone signs in to Figma and reopens the plugin.`
      );
    case "grant-pending":
      return waitingText(
        `this project isn't allowed to edit ${quoteFigmaName(block.fileName)} yet`,
        `someone clicks Allow for this call in the Framelink plugin in ${quoteFigmaName(block.fileName)}`,
        surface,
        waitMs,
      );
    case "pick-pending":
      return waitingText(
        `${quoteFigmaName(block.fileName)} is open as more than one file that share one identity (one is a ` +
          `copy), and nothing tells this server which one this call means`,
        `someone clicks "Use this one" in the Framelink plugin of the file to edit, or "Give this ` +
          `copy its own identity" in the copy`,
        surface,
        waitMs,
      );
    case "session-not-found":
      return sessionNotFoundText(block.session, surface);
    case "session-lookup-failed":
      return (
        `Blocked: the Framelink plugin didn't answer whether it holds the session ${block.session}, ` +
        `so nothing was submitted. The session may still be open, so ` +
        `${surface === "mcp" ? "call" : "run"} again with the same session. If it keeps failing, ` +
        `report it to the user or coordinating agent.`
      );
    case "session-ambiguous":
      return (
        `Blocked: two open Framelink plugins both hold the session ${block.session}, so this call ` +
        `can't tell which one it names, and nothing was submitted. ${freshSession(surface)}.`
      );
    case "session-document-mismatch": {
      const [documentArgs, sessionFlag] =
        surface === "mcp"
          ? ["document and fileKey", "session"]
          : ["--document and --file-key", "--session"];
      return (
        `Blocked: the session ${block.session} is in ${quoteFigmaName(block.sessionFileName)}, but this call ` +
        `named ${namedDocument(block.document, block.fileKey)}, so nothing was submitted. ` +
        `A session stays in the file it started in: drop ${documentArgs} to keep ` +
        `working in ${quoteFigmaName(block.sessionFileName)}, or drop ${sessionFlag} to start a fresh session.`
      );
    }
  }
}

function namedDocument(document: string | null, fileKey: string | null): string {
  const names = [
    ...(document ? [`document ${document}`] : []),
    ...(fileKey ? [`fileKey ${fileKey}`] : []),
  ];
  return `the Figma file named by ${names.join(" and ")}`;
}

function unchosenLead(reason: NoUnnamedCallDefault): string {
  const why =
    reason.kind === "several-granted"
      ? `this project may edit ${reason.count} open files, and this call named none`
      : {
          "no-files": "there is no open Figma file to run in",
          incomplete: "not every open file is known yet, so this server won't choose one for you",
          "none-granted":
            "this project isn't allowed to edit any open file yet, and this call named none",
        }[reason.kind];
  return (
    `Blocked: ${why}, so nothing was submitted and no plugin panel was asked. Name the file to ` +
    `edit; if this project isn't allowed there yet, the user is asked to Allow it in that file only.`
  );
}

function waitingText(
  state: string,
  action: string,
  surface: "mcp" | "cli",
  waitMs: number,
): string {
  const seconds = Math.round(waitMs / 1000);
  return surface === "mcp"
    ? `Blocked: ${state}, so this call did not run. Required before retrying: ${action}. ` +
        `${REPORT_TO_PERSON} they confirm — each attempt waits up to ${seconds}s and cannot ` +
        `succeed without them. Answering later does not run this call; submit it again.`
    : `Blocked: ${state}, so the script did not run. Required before re-running: ${action}. ` +
        `This run waited ${seconds}s; raise --wait if they need longer.`;
}

/**
 * No open plugin holds the session a call named. Nothing was submitted, and the call never runs
 * anywhere else in its place.
 */
export function sessionNotFoundText(session: string, surface: "mcp" | "cli"): string {
  return (
    `Blocked: no open Framelink plugin holds the session ${session}, so nothing was submitted. A ` +
    `session lives only in the plugin run that made it: the plugin was closed or reloaded, or the ` +
    `session was cleared to stay within its memory budget, and what it held is gone. ` +
    `${freshSession(surface)}, then rebuild what you need: re-read nodes with flcm.get rather than ` +
    `repeating edits that already landed.`
  );
}

function freshSession(surface: "mcp" | "cli"): string {
  return surface === "mcp"
    ? "Call again without session to start a fresh one"
    : "Run again without --session to start a fresh one";
}

/**
 * The plugin refused a run after this server bound it: the grant was revoked, or the plugin's file
 * no longer carries the document id the call was bound to. The plugin refused it before it ran.
 */
export function notGrantedText(reason: "no-grant" | "other-document", fileName: string): string {
  return reason === "no-grant"
    ? `Blocked: the Framelink plugin refused the run because this project is no longer allowed to ` +
        `edit ${quoteFigmaName(fileName)} (the user revoked it), so nothing ran. Don't retry unless the user asks to.`
    : `Blocked: the Framelink plugin refused the run because ${quoteFigmaName(fileName)} no longer carries the ` +
        `document id this call named (the file was given its own identity, or the plugin closed), ` +
        `so nothing ran. Call again without a document to see the open files, and choose again.`;
}

/**
 * The note the reference leads with: the open documents and how an execute call will bind. It never
 * prompts and never submits; `null` is a lookup that failed.
 */
export function referenceDocumentsGuidance(
  open: OpenDocumentSnapshot | null,
  surface: "reference" | "cli",
): string {
  if (open === null)
    return "The open Figma files could not be listed. Check the Framelink plugin connection before executing code. No code was submitted.";
  const unnamed = unnamedCallDefault(open);
  const flag = documentFlag(surface);
  const binding =
    unnamed.kind === "default"
      ? `Executing code without ${flag} runs in ${quoteFigmaName(unnamed.document.fileName)}.`
      : unnamed.kind === "incomplete"
        ? `Not every open file is known yet, so where executing code without ${flag} runs isn't settled; name the file to edit.`
        : `Executing code without ${flag} is refused until exactly one open file is allowed; name the file to edit.`;
  return `${binding}\n${openDocumentsText(open, surface)}`;
}

/**
 * Why the open files couldn't be listed, on the reference note above the docs or by `reference
 * --files`, which pairs with the `pair` command, not the MCP tool.
 */
export function referenceLinkGuidance(
  resolution: UnlinkedResolution,
  surface: "reference" | "cli",
): string {
  if (surface === "reference") return linkGuidance(resolution, "reference");
  switch (resolution.kind) {
    case "disconnected":
      return `Blocked: no compatible Figma plugin is connected, so no files were listed. ${pluginDisconnectedAction()}`;
    case "unpaired":
      return (
        `Blocked: this server isn't paired with the Framelink plugin, so no files were listed. ` +
        `Required before re-running: someone runs \`npx ${CLI_NAME} pair\` in a terminal and ` +
        `confirms the code the Framelink plugin panel shows. Pairing is remembered, so this is needed once.`
      );
    case "incompatible":
    case "credential-unusable":
      return linkGuidance(resolution, "cli");
  }
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

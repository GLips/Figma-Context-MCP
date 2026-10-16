/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// How an MCP call that needs the plugin gets its link: resolve one, and when the plugin isn't paired
// yet, pair it — confirmed in a client prompt when the client can show one, otherwise by telling the
// agent to ask the person and confirm through pair_figma_plugin.
import type { PluginBridge, PluginLink } from "~/commercial/plugin-bridge/bridge.js";
import {
  approvalGuidance,
  pairingConfirmationGuidance,
  pairingDeclinedText,
  pairingRateLimitedText,
  pluginDisconnectedNotSubmittedText,
} from "~/commercial/plugin-bridge/blocked-call-guidance.js";

/**
 * Asks the person, in the MCP client, whether the panel shows `code`. `not-shown` is only an explicit
 * No; a cancelled, failed or timed-out prompt is `unanswered`, which falls back to agent guidance.
 */
export type PairingCodeAsker = (
  code: string,
  expiresInMs: number,
  signal: AbortSignal,
) => Promise<"shown" | "not-shown" | "unanswered">;

/** Why a call got no link, as a telemetry code. */
export type PluginCallBlock =
  | "several_files"
  | "incompatible"
  | "disconnected"
  | "pairing_required"
  | "pairing_declined"
  | "pairing_rate_limited"
  | "pairing_failed";

export type PluginCallLink =
  | { kind: "linked"; link: PluginLink }
  | { kind: "blocked"; block: PluginCallBlock; text: string; isError: boolean };

/** The link a call runs on, pairing first if the plugin isn't paired yet. Nothing is submitted here. */
export async function linkForPluginCall(
  bridge: PluginBridge,
  askPairingCode: PairingCodeAsker | null,
  signal: AbortSignal,
): Promise<PluginCallLink> {
  const resolution = await bridge.resolveLink(signal);
  switch (resolution.kind) {
    case "linked":
      return resolution;
    case "several":
      return {
        kind: "blocked",
        block: "several_files",
        text: approvalGuidance({ kind: "several-files", count: resolution.count }, "mcp"),
        isError: true,
      };
    case "incompatible":
      return { kind: "blocked", block: "incompatible", text: resolution.refusal, isError: true };
    case "disconnected":
      return disconnected(resolution.elapsedMs);
    case "unpaired":
      return pairThenLink(bridge, askPairingCode, signal);
  }
}

async function pairThenLink(
  bridge: PluginBridge,
  askPairingCode: PairingCodeAsker | null,
  signal: AbortSignal,
): Promise<PluginCallLink> {
  const offer = await bridge.offerPairing();
  if (offer.kind === "rate-limited")
    return {
      kind: "blocked",
      block: "pairing_rate_limited",
      text: pairingRateLimitedText(offer.retryAfterMs),
      isError: true,
    };
  // The unpaired link closed, or another process paired it, between resolving and offering.
  if (offer.kind === "none") {
    const settled = await bridge.resolveLink(signal);
    if (settled.kind === "linked") return settled;
    return disconnected(bridge.disconnectedDurationMs());
  }
  const unanswered: { code: string; expiresAt: number }[] = [];
  let declined = false;
  // One prompt per code, in turn: each names exactly the code its panel shows, and a Yes pairs only
  // the link showing it.
  for (const attempt of offer.attempts) {
    const expiresInMs = attempt.expiresAt - Date.now();
    const answer = askPairingCode
      ? await askPairingCode(attempt.code, expiresInMs, signal)
      : "unanswered";
    if (answer === "not-shown") {
      bridge.declinePairing(attempt.code);
      declined = true;
      continue;
    }
    if (answer === "unanswered") {
      unanswered.push(attempt);
      continue;
    }
    const confirmed = await bridge.confirmPairing(attempt.code);
    if (confirmed.kind === "failed")
      return { kind: "blocked", block: "pairing_failed", text: confirmed.reason, isError: true };
    if (confirmed.kind === "paired") return linkForPluginCall(bridge, null, signal);
    unanswered.push(attempt);
  }
  if (!unanswered.length && declined)
    return {
      kind: "blocked",
      block: "pairing_declined",
      text: pairingDeclinedText(),
      isError: true,
    };
  const expiresInMs = Math.min(...unanswered.map((attempt) => attempt.expiresAt)) - Date.now();
  return {
    kind: "blocked",
    block: "pairing_required",
    text: pairingConfirmationGuidance(
      unanswered.map((attempt) => attempt.code),
      expiresInMs,
    ),
    isError: false,
  };
}

function disconnected(elapsedMs: number | null): PluginCallLink {
  return {
    kind: "blocked",
    block: "disconnected",
    text: pluginDisconnectedNotSubmittedText(elapsedMs),
    isError: false,
  };
}

/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The one compare-and-confirm driver: how a call that needs the plugin gets its link, pairing it
// first when it isn't paired yet. The MCP tools, the `pair` command and the live probes all go
// through here, each with its own way of asking the person whether the panel shows a code.
import type { LinkResolution, PluginBridge, PluginLink, UnlinkedResolution } from "./bridge.js";
import {
  linkGuidance,
  pairingCodeExpiredText,
  pairingConfirmationGuidance,
  pairingDeclinedText,
  pairingRateLimitedText,
} from "./blocked-call-guidance.js";

/**
 * Asks the person whether the plugin panel shows `code`. `not-shown` is only an explicit No; a
 * cancelled, failed or timed-out prompt is `unanswered`, which falls back to agent guidance.
 */
export type PairingCodeAsker = (
  code: string,
  expiresInMs: number,
  signal: AbortSignal,
) => Promise<"shown" | "not-shown" | "unanswered">;

/**
 * Agent guidance names a code only while it has at least this long left, so the agent can still ask
 * and confirm it. A prompt must give up in time to leave this much.
 */
export const PAIRING_GUIDANCE_MIN_LIFE_MS = 60_000;

/** Who reads the blocked text: an MCP tool result, or a terminal. */
export type PairingSurface = "mcp" | "cli";

/** Why a call got no link, as a telemetry code. */
export type PluginCallBlock =
  | "several_files"
  | "incompatible"
  | "disconnected"
  | "credential_unusable"
  | "pairing_required"
  | "pairing_declined"
  | "pairing_expired"
  | "pairing_rate_limited"
  | "pairing_failed";

type PluginCallBlocked = {
  kind: "blocked";
  block: PluginCallBlock;
  text: string;
  isError: boolean;
};

export type PluginCallLink = { kind: "linked"; link: PluginLink } | PluginCallBlocked;

/**
 * Where pairing left this server. An `already-paired` link is null when several files hold
 * authenticated links: pairing is done, even though a call couldn't pick one.
 */
export type PluginPairing =
  | { kind: "paired"; link: PluginLink }
  | { kind: "already-paired"; link: PluginLink | null }
  | PluginCallBlocked;

/** The link a call runs on, pairing first if the plugin isn't paired yet. Nothing is submitted here. */
export async function linkForPluginCall(
  bridge: PluginBridge,
  askPairingCode: PairingCodeAsker | null,
  signal: AbortSignal,
  surface: PairingSurface = "mcp",
): Promise<PluginCallLink> {
  const resolution = await bridge.resolveLink(signal);
  if (resolution.kind === "linked") return resolution;
  if (resolution.kind !== "unpaired") return unlinked(resolution, surface);
  const paired = await confirmShownCode(bridge, askPairingCode, signal, surface);
  if (paired.kind === "blocked") return paired;
  // Resolved again, never taken from the pairing: another file may have authenticated alongside,
  // and a call doesn't pick between files.
  const settled = await bridge.resolveLink(signal);
  return settled.kind === "linked" ? settled : unlinked(settled, surface);
}

/** Pair this server with the plugin unless it already is. Nothing is submitted here. */
export async function pairPluginLink(
  bridge: PluginBridge,
  askPairingCode: PairingCodeAsker | null,
  signal: AbortSignal,
  surface: PairingSurface,
): Promise<PluginPairing> {
  const resolution = await bridge.resolveLink(signal);
  if (resolution.kind === "unpaired")
    return confirmShownCode(bridge, askPairingCode, signal, surface);
  return alreadyPaired(resolution, surface);
}

/**
 * Offer codes, and ask about each in turn: each prompt names exactly the code its panel shows, and
 * a Yes pairs only the link showing it.
 */
async function confirmShownCode(
  bridge: PluginBridge,
  askPairingCode: PairingCodeAsker | null,
  signal: AbortSignal,
  surface: PairingSurface,
): Promise<PluginPairing> {
  const offer = await bridge.offerPairing();
  if (offer.kind === "rate-limited")
    return blocked("pairing_rate_limited", pairingRateLimitedText(offer.retryAfterMs), true);
  // The unpaired link closed, or another process paired it, between resolving and offering.
  if (offer.kind === "none") return alreadyPaired(await bridge.resolveLink(signal), surface);
  const unanswered: string[] = [];
  for (const attempt of offer.attempts) {
    const answer = askPairingCode
      ? await askPairingCode(attempt.code, attempt.expiresAt - Date.now(), signal)
      : "unanswered";
    if (answer === "not-shown") {
      bridge.declinePairing(attempt.code);
      continue;
    }
    if (answer === "unanswered") {
      unanswered.push(attempt.code);
      continue;
    }
    const confirmed = await bridge.confirmPairing(attempt.code);
    if (confirmed.kind === "paired") return { kind: "paired", link: confirmed.link };
    if (confirmed.kind === "failed") return blocked("pairing_failed", confirmed.reason, true);
    // Unknown by now: it lapsed while the person looked. The liveness check below drops it.
    unanswered.push(attempt.code);
  }
  // Re-read, never the offer's expiry: a slow prompt may have outlived a code, and guidance naming a
  // dead code sends the agent round a loop.
  const now = Date.now();
  const live = unanswered.flatMap((code) => {
    const expiresAt = bridge.pairingCodeExpiresAt(code);
    return expiresAt !== null && expiresAt - now >= PAIRING_GUIDANCE_MIN_LIFE_MS
      ? [{ code, expiresAt }]
      : [];
  });
  if (live.length)
    return blocked(
      "pairing_required",
      pairingConfirmationGuidance(
        live.map((attempt) => attempt.code),
        Math.min(...live.map((attempt) => attempt.expiresAt)) - now,
      ),
      false,
    );
  if (unanswered.length) return blocked("pairing_expired", pairingCodeExpiredText(surface), false);
  return blocked("pairing_declined", pairingDeclinedText(), true);
}

function alreadyPaired(resolution: LinkResolution, surface: PairingSurface): PluginPairing {
  if (resolution.kind === "linked") return { kind: "already-paired", link: resolution.link };
  if (resolution.kind === "several") return { kind: "already-paired", link: null };
  return unlinked(resolution, surface);
}

const BLOCK_FOR_RESOLUTION: Record<UnlinkedResolution["kind"], PluginCallBlock> = {
  several: "several_files",
  incompatible: "incompatible",
  disconnected: "disconnected",
  "credential-unusable": "credential_unusable",
  unpaired: "pairing_required",
};

function unlinked(resolution: UnlinkedResolution, surface: PairingSurface): PluginCallBlocked {
  return blocked(
    BLOCK_FOR_RESOLUTION[resolution.kind],
    linkGuidance(resolution, surface),
    // A redial or a pairing is a wait, not a failure.
    resolution.kind !== "disconnected" && resolution.kind !== "unpaired",
  );
}

function blocked(block: PluginCallBlock, text: string, isError: boolean): PluginCallBlocked {
  return { kind: "blocked", block, text, isError };
}

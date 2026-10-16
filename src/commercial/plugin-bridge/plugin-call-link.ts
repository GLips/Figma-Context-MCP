/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The one driver for how a call that needs the plugin gets where it runs: its links, pairing first
// when the plugin isn't paired yet, then its one document and a grant on it. The MCP tools, the CLI
// commands and the live probes all go through here, each with its own way of asking the person
// whether the panel shows a code, or none at all.
import type {
  CallTargetBlock,
  DocumentReader,
  LinkResolution,
  PluginBridge,
  PluginLink,
  UnlinkedResolution,
} from "./bridge.js";
import type { FigmaFileKey } from "~/utils/figma-url.js";
import type { CallTargetOptions } from "./call-target.js";
import type { PluginCallTarget } from "./execution.js";
import {
  callTargetGuidance,
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

/** Why a call got nowhere to run, as a telemetry code. */
export type PluginCallBlock =
  | "document_not_open"
  | "document_unprovable"
  | "grant_denied"
  | "grant_unavailable"
  | "grant_pending"
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

export type PluginCallTargeting = ({ kind: "targeted" } & PluginCallTarget) | PluginCallBlocked;

/** Where pairing left this server. */
export type PluginPairing =
  | { kind: "paired"; link: PluginLink }
  | { kind: "already-paired" }
  | PluginCallBlocked;

/**
 * What an unpaired plugin gets: a pairing attempt confirmed through `ask` (agent guidance when it is
 * null), or a refusal pointing at the `pair` command, for a caller that can't count on a person.
 */
export type PluginCallPairing =
  | { kind: "offer"; ask: PairingCodeAsker | null }
  | { kind: "refuse" };

export interface PluginCallTargetOptions {
  /** The file the call names, or null to run in the one granted file or let the human pick. */
  fileKey: FigmaFileKey | null;
  pairing: PluginCallPairing;
  signal: AbortSignal;
  surface: PairingSurface;
  /** The call's own file reader, for proofs; the bridge's process-wide one when absent. */
  reader?: DocumentReader | null;
  waitMs: number;
  pollMs?: number;
  onWaiting?: CallTargetOptions["onWaiting"];
}

/**
 * Where a call runs: pair first if the plugin isn't paired yet, then bind the call to one document
 * under a grant (call-target.ts). Prompts the human; submits nothing.
 */
export async function targetForPluginCall(
  bridge: PluginBridge,
  { fileKey, pairing, signal, surface, reader, waitMs, pollMs, onWaiting }: PluginCallTargetOptions,
): Promise<PluginCallTargeting> {
  let resolution = await bridge.resolveLink(signal);
  if (resolution.kind === "unpaired" && pairing.kind === "offer") {
    const paired = await confirmShownCode(bridge, pairing.ask, signal, surface);
    if (paired.kind === "blocked") return paired;
    resolution = await bridge.resolveLink(signal);
  }
  if (resolution.kind !== "linked") return unlinked(resolution, surface);
  const target = await bridge.targetCall(fileKey, { reader, signal, waitMs, pollMs, onWaiting });
  if (target.kind === "targeted") return target;
  return blocked(
    BLOCK_FOR_TARGET[target.block.kind],
    callTargetGuidance(target.block, surface, waitMs),
    // Waiting on a person is not a failure; everything else is.
    target.block.kind !== "grant-pending",
  );
}

const BLOCK_FOR_TARGET: Record<CallTargetBlock["kind"], PluginCallBlock> = {
  "document-not-open": "document_not_open",
  "document-unprovable": "document_unprovable",
  "grant-denied": "grant_denied",
  "grant-unavailable": "grant_unavailable",
  "grant-pending": "grant_pending",
};

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
  if (resolution.kind === "linked") return { kind: "already-paired" };
  return unlinked(resolution, surface);
}

const BLOCK_FOR_RESOLUTION: Record<UnlinkedResolution["kind"], PluginCallBlock> = {
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

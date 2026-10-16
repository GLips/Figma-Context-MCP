/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import type { ApprovalStatus, LinkResolution, PluginLink } from "./bridge.js";
import { approvalGuidance, type ApprovalGuidanceState } from "./blocked-call-guidance.js";

/** The two lookups the reference note makes: which link, then that link's approval. */
export interface ReferenceLinkLookup {
  resolveLink(signal: AbortSignal): Promise<LinkResolution>;
  approvalStatus(link: PluginLink, signal: AbortSignal): Promise<ApprovalStatus>;
}

/** What to say about a call that resolved no link. */
export function unlinkedGuidanceState(
  resolution: Exclude<LinkResolution, { kind: "linked" }>,
): ApprovalGuidanceState {
  switch (resolution.kind) {
    case "incompatible":
      return { kind: "incompatible", refusal: resolution.refusal };
    case "disconnected":
      return { kind: "disconnected", elapsedMs: resolution.elapsedMs };
    case "unpaired":
      return { kind: "unpaired" };
    case "several":
      return { kind: "several-files", count: resolution.count };
  }
}

/**
 * The note get_flcm_reference leads with: one bounded, read-only lookup. Reference delivery never
 * starts pairing, never enters the human approval wait, and never submits code.
 */
export async function referenceSessionGuidance(
  lookup: ReferenceLinkLookup,
  timeoutMs = 1500,
): Promise<string | undefined> {
  const state = await referenceState(lookup, timeoutMs);
  return state ? approvalGuidance(state, "reference") : undefined;
}

async function referenceState(
  lookup: ReferenceLinkLookup,
  timeoutMs: number,
): Promise<ApprovalGuidanceState | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Reference status lookup timed out"));
    }, timeoutMs);
  });
  try {
    const resolution = await Promise.race([lookup.resolveLink(controller.signal), timedOut]);
    if (resolution.kind !== "linked") return unlinkedGuidanceState(resolution);
    const reply = await Promise.race([
      lookup.approvalStatus(resolution.link, controller.signal),
      timedOut,
    ]);
    if (reply.type === "APPROVAL_GRANTED") return null;
    if (reply.type === "APPROVAL_REJECTED") return { kind: "rejected" };
    return { kind: "reference-pending" };
  } catch {
    return { kind: "reference-status-unknown" };
  } finally {
    clearTimeout(timer);
  }
}

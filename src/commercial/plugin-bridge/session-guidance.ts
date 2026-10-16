/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import type { ApprovalStatus, LinkResolution, PluginLink } from "./bridge.js";
import { approvalGuidance, linkGuidance } from "./blocked-call-guidance.js";

/** The two lookups the reference note makes: which link, then that link's approval. */
export interface ReferenceLinkLookup {
  resolveLink(signal: AbortSignal): Promise<LinkResolution>;
  approvalStatus(link: PluginLink, signal: AbortSignal): Promise<ApprovalStatus>;
}

/**
 * The note get_flcm_reference leads with: one bounded, read-only lookup. Reference delivery never
 * starts pairing, never enters the human approval wait, and never submits code.
 */
export async function referenceSessionGuidance(
  lookup: ReferenceLinkLookup,
  timeoutMs = 1500,
): Promise<string | undefined> {
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
    if (resolution.kind !== "linked") return linkGuidance(resolution, "reference");
    const reply = await Promise.race([
      lookup.approvalStatus(resolution.link, controller.signal),
      timedOut,
    ]);
    if (reply.type === "APPROVAL_GRANTED") return undefined;
    return approvalGuidance(
      { kind: reply.type === "APPROVAL_REJECTED" ? "rejected" : "reference-pending" },
      "reference",
    );
  } catch {
    return approvalGuidance({ kind: "reference-status-unknown" }, "reference");
  } finally {
    clearTimeout(timer);
  }
}

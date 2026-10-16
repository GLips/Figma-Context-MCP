/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import type { LinkResolution } from "./bridge.js";
import { linkGuidance, referenceGrantGuidance } from "./blocked-call-guidance.js";
import { grantedOpenDocuments, type GrantedDocumentLookup } from "./call-target.js";

/** The lookups the reference note makes: which links, then the granted documents among them. */
export interface ReferenceLinkLookup extends GrantedDocumentLookup {
  resolveLink(signal: AbortSignal): Promise<LinkResolution>;
}

/**
 * The note get_flcm_reference leads with: one bounded, read-only lookup, counting granted documents
 * by the same rule an unnamed execute call binds by. It never starts pairing, never prompts for a
 * grant, never proves a document, and never submits code.
 */
export async function referenceGrantNote(
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
    const census = await Promise.race([
      grantedOpenDocuments(resolution.links, lookup, controller.signal),
      timedOut,
    ]);
    return referenceGrantGuidance({
      fileNames: [...census.granted.values()].map(({ document }) => document.fileName),
      complete: census.complete,
    });
  } catch {
    return referenceGrantGuidance(null);
  } finally {
    clearTimeout(timer);
  }
}

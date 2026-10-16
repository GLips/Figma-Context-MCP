/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import type { LinkResolution } from "./bridge.js";
import { referenceDocumentsGuidance, referenceLinkGuidance } from "./blocked-call-guidance.js";
import type { OpenDocumentSnapshot } from "./call-target.js";

/** The lookups the reference note makes: which links, then the open documents on them. */
export interface ReferenceDocumentsLookup {
  resolveLink(signal: AbortSignal): Promise<LinkResolution>;
  openDocuments(signal: AbortSignal): Promise<OpenDocumentSnapshot>;
}

/** The note's text, and whether it lists the open documents or says why they couldn't be listed. */
export interface ReferenceDocumentsNote {
  text: string;
  listed: boolean;
}

/**
 * The note the reference leads with: one bounded, read-only lookup listing the open documents, by the
 * same snapshot an unnamed execute call binds by. It never starts pairing, never prompts, and never
 * submits code.
 */
export async function referenceDocumentsNote(
  lookup: ReferenceDocumentsLookup,
  surface: "reference" | "cli",
  timeoutMs = 1500,
): Promise<ReferenceDocumentsNote> {
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
    if (resolution.kind !== "linked")
      return { text: referenceLinkGuidance(resolution, surface), listed: false };
    const open = await Promise.race([lookup.openDocuments(controller.signal), timedOut]);
    return { text: referenceDocumentsGuidance(open, surface), listed: true };
  } catch {
    return { text: referenceDocumentsGuidance(null, surface), listed: false };
  } finally {
    clearTimeout(timer);
  }
}

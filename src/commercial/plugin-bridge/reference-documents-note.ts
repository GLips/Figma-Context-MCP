/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import type { LinkResolution } from "./bridge.js";
import { linkGuidance, referenceDocumentsGuidance } from "./blocked-call-guidance.js";
import type { OpenDocumentSnapshot } from "./call-target.js";

/** The lookups the reference note makes: which links, then the open documents on them. */
export interface ReferenceDocumentsLookup {
  resolveLink(signal: AbortSignal): Promise<LinkResolution>;
  openDocuments(signal: AbortSignal): Promise<OpenDocumentSnapshot>;
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
): Promise<string> {
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
    const open = await Promise.race([lookup.openDocuments(controller.signal), timedOut]);
    return referenceDocumentsGuidance(open, surface);
  } catch {
    return referenceDocumentsGuidance(null, surface);
  } finally {
    clearTimeout(timer);
  }
}

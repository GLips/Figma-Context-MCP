/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import type { GrantPrompt, GrantState } from "@framelink/plugin/protocol";
import type { LinkResolution, PluginLink } from "./bridge.js";
import { linkGuidance, referenceGrantGuidance } from "./blocked-call-guidance.js";

/** The lookups the reference note makes: which links, then each proven link's grant. */
export interface ReferenceLinkLookup {
  resolveLink(signal: AbortSignal): Promise<LinkResolution>;
  grantStatus(
    link: PluginLink,
    fileKey: string,
    prompt: GrantPrompt,
    signal: AbortSignal,
  ): Promise<GrantState>;
}

/**
 * The note get_flcm_reference leads with: one bounded, read-only lookup. Reference delivery never
 * starts pairing, never prompts for a grant, never proves a document, and never submits code.
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
    const proven = resolution.links.flatMap((link) =>
      link.document.kind === "proven" ? [{ link, document: link.document }] : [],
    );
    const states = await Promise.race([
      Promise.all(
        proven.map(({ link, document }) =>
          lookup.grantStatus(link, document.fileKey, "none", controller.signal),
        ),
      ),
      timedOut,
    ]);
    const granted = new Map<string, string>();
    proven.forEach(({ document }, index) => {
      if (states[index] === "granted") granted.set(document.fileKey, document.fileName);
    });
    return referenceGrantGuidance([...granted.values()]);
  } catch {
    return referenceGrantGuidance(null);
  } finally {
    clearTimeout(timer);
  }
}

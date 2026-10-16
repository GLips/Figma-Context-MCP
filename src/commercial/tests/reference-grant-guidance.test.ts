/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { describe, it, expect, vi } from "vitest";
import type {
  LinkDocument,
  LinkResolution,
  PluginLink,
} from "~/commercial/plugin-bridge/bridge.js";
import {
  referenceGrantNote,
  type ReferenceLinkLookup,
} from "~/commercial/plugin-bridge/reference-grant-guidance.js";
import { figmaFileKey } from "~/utils/figma-url.js";

const documents = new Map<PluginLink, LinkDocument>();
function linkIn(document: LinkDocument): PluginLink {
  const link = {} as PluginLink;
  documents.set(link, document);
  return link;
}
const provenIn = (fileKey: string, fileName: string) =>
  linkIn({ kind: "proven", fileKey: figmaFileKey(fileKey), fileName });
const unproven = linkIn({ kind: "unclaimed" });

function lookupOf(
  resolution: LinkResolution,
  grantStatus: ReferenceLinkLookup["grantStatus"] = vi.fn(),
): ReferenceLinkLookup {
  return {
    resolveLink: async () => resolution,
    documentOf: (link) => documents.get(link) ?? { kind: "unknown" },
    grantStatus,
  };
}

describe("link-aware reference guidance", () => {
  it("one granted file needs no note, even open twice; several name the files; none says executing will ask", async () => {
    const granted = vi.fn(async () => "granted" as const);
    const one = provenIn("A", "Alpha");
    const sameFile = provenIn("A", "Alpha");
    expect(
      await referenceGrantNote(
        lookupOf({ kind: "linked", links: [one, sameFile, unproven] }, granted),
      ),
    ).toBeUndefined();
    expect(granted).toHaveBeenCalledTimes(2);
    expect(granted).toHaveBeenCalledWith(one, "A", "none", expect.any(AbortSignal));

    const several = await referenceGrantNote(
      lookupOf({ kind: "linked", links: [one, provenIn("B", "Beta")] }, granted),
    );
    expect(several).toContain('"Alpha", "Beta"');
    expect(several).toContain("fileKey");

    const none = await referenceGrantNote(
      lookupOf({ kind: "linked", links: [one] }, async () => "absent" as const),
    );
    expect(none).toContain("isn't allowed to edit any open Figma file");
  });

  it("an unlinked plugin keeps docs available without grant traffic or starting pairing", async () => {
    const status = vi.fn();
    expect(
      await referenceGrantNote(lookupOf({ kind: "disconnected", elapsedMs: null }, status)),
    ).toContain("Open the Framelink plugin");
    expect(await referenceGrantNote(lookupOf({ kind: "unpaired" }, status))).toContain(
      "call pair_figma_plugin",
    );
    expect(
      await referenceGrantNote(
        lookupOf({ kind: "incompatible", refusal: "Re-import this plugin" }, status),
      ),
    ).toBe("Re-import this plugin");
    expect(status).not.toHaveBeenCalled();
  });

  it("failed or unresponsive lookups return guidance within the bound", async () => {
    expect(
      await referenceGrantNote(
        lookupOf({ kind: "linked", links: [provenIn("A", "Alpha")] }, async () => {
          throw Error("gone");
        }),
      ),
    ).toContain("could not be checked");
    let signal: AbortSignal | undefined;
    expect(
      await referenceGrantNote(
        {
          resolveLink: (s) => {
            signal = s;
            return new Promise(() => {});
          },
          documentOf: () => ({ kind: "unknown" }),
          grantStatus: vi.fn(),
        },
        5,
      ),
    ).toContain("could not be checked");
    expect(signal?.aborted).toBe(true);
  });
});

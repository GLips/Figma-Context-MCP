/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { describe, it, expect, vi } from "vitest";
import type { LinkResolution, PluginLink } from "~/commercial/plugin-bridge/bridge.js";
import {
  referenceSessionGuidance,
  type ReferenceLinkLookup,
} from "~/commercial/plugin-bridge/session-guidance.js";

const provenIn = (fileKey: string, fileName: string) =>
  ({ document: { kind: "proven", fileKey, fileName } }) as PluginLink;
const unproven = { document: { kind: "unclaimed" } } as PluginLink;

function lookupOf(
  resolution: LinkResolution,
  grantStatus: ReferenceLinkLookup["grantStatus"] = vi.fn(),
): ReferenceLinkLookup {
  return { resolveLink: async () => resolution, grantStatus };
}

describe("link-aware reference guidance", () => {
  it("one granted file needs no note; several name the files; none says executing will ask", async () => {
    const granted = vi.fn(async () => "granted" as const);
    const one = provenIn("A", "Alpha");
    expect(
      await referenceSessionGuidance(lookupOf({ kind: "linked", links: [one, unproven] }, granted)),
    ).toBeUndefined();
    expect(granted).toHaveBeenCalledTimes(1);
    expect(granted).toHaveBeenCalledWith(one, "A", "none", expect.any(AbortSignal));

    const several = await referenceSessionGuidance(
      lookupOf({ kind: "linked", links: [one, provenIn("B", "Beta")] }, granted),
    );
    expect(several).toContain('"Alpha", "Beta"');
    expect(several).toContain("fileKey");

    const none = await referenceSessionGuidance(
      lookupOf({ kind: "linked", links: [one] }, async () => "absent" as const),
    );
    expect(none).toContain("isn't allowed to edit any open Figma file");
  });

  it("an unlinked plugin keeps docs available without grant traffic or starting pairing", async () => {
    const status = vi.fn();
    expect(
      await referenceSessionGuidance(lookupOf({ kind: "disconnected", elapsedMs: null }, status)),
    ).toContain("Open the Framelink plugin");
    expect(await referenceSessionGuidance(lookupOf({ kind: "unpaired" }, status))).toContain(
      "call pair_figma_plugin",
    );
    expect(
      await referenceSessionGuidance(
        lookupOf({ kind: "incompatible", refusal: "Re-import this plugin" }, status),
      ),
    ).toBe("Re-import this plugin");
    expect(status).not.toHaveBeenCalled();
  });

  it("failed or unresponsive lookups return guidance within the bound", async () => {
    expect(
      await referenceSessionGuidance(
        lookupOf({ kind: "linked", links: [provenIn("A", "Alpha")] }, async () => {
          throw Error("gone");
        }),
      ),
    ).toContain("could not be checked");
    let signal: AbortSignal | undefined;
    expect(
      await referenceSessionGuidance(
        {
          resolveLink: (s) => {
            signal = s;
            return new Promise(() => {});
          },
          grantStatus: vi.fn(),
        },
        5,
      ),
    ).toContain("could not be checked");
    expect(signal?.aborted).toBe(true);
  });
});

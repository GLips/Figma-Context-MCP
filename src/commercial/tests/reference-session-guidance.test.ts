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

const link = {} as PluginLink;

function lookupOf(
  resolution: LinkResolution,
  approvalStatus: ReferenceLinkLookup["approvalStatus"] = vi.fn(),
): ReferenceLinkLookup {
  return { resolveLink: async () => resolution, approvalStatus };
}

describe("link-aware reference guidance", () => {
  it("approved sessions receive no preamble and perform one status query", async () => {
    const status = vi.fn(async () => ({ type: "APPROVAL_GRANTED", session: null }) as const);
    expect(
      await referenceSessionGuidance(lookupOf({ kind: "linked", link }, status)),
    ).toBeUndefined();
    expect(status).toHaveBeenCalledTimes(1);
  });

  it("pending and rejected approvals ask for an Allow without waiting", async () => {
    for (const type of ["PENDING_APPROVAL", "APPROVAL_REJECTED"] as const) {
      const status = vi.fn(async () => ({ type }));
      expect(await referenceSessionGuidance(lookupOf({ kind: "linked", link }, status))).toContain(
        "click Allow",
      );
      expect(status).toHaveBeenCalledTimes(1);
    }
  });

  it("an unlinked plugin keeps docs available without status traffic or starting pairing", async () => {
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
        lookupOf({ kind: "linked", link }, async () => {
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
          approvalStatus: vi.fn(),
        },
        5,
      ),
    ).toContain("could not be checked");
    expect(signal?.aborted).toBe(true);
  });
});

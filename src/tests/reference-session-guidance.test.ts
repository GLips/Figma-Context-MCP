import { describe, it, expect, vi } from "vitest";
import { referenceSessionGuidance } from "~/mcp/tools/flcm-docs/session-guidance.js";

describe("approval-aware reference guidance", () => {
  it("approved sessions receive no pairing preamble and perform one status query", async () => {
    const status = vi.fn(async () => ({ type: "APPROVAL_GRANTED" }));
    expect(
      await referenceSessionGuidance({ pairingCode: "1234", protocolRefusal: null, status }),
    ).toBeUndefined();
    expect(status).toHaveBeenCalledTimes(1);
  });
  it("pending and rejected approvals give the live code without waiting", async () => {
    for (const type of ["PENDING_APPROVAL", "APPROVAL_REJECTED"]) {
      const status = vi.fn(async () => ({ type }));
      expect(
        await referenceSessionGuidance({ pairingCode: "4321", protocolRefusal: null, status }),
      ).toContain("4321");
      expect(status).toHaveBeenCalledTimes(1);
    }
  });
  it("disconnection and incompatibility keep docs available without status traffic", async () => {
    const status = vi.fn();
    expect(
      await referenceSessionGuidance({ pairingCode: null, protocolRefusal: null, status }),
    ).toContain("Open the Framelink plugin");
    expect(
      await referenceSessionGuidance({
        pairingCode: "1234",
        protocolRefusal: "Re-import this plugin",
        status,
      }),
    ).toBe("Re-import this plugin");
    expect(status).not.toHaveBeenCalled();
  });
  it("failed or unresponsive status requests return guidance within the bounded lookup", async () => {
    expect(
      await referenceSessionGuidance({
        pairingCode: "1234",
        protocolRefusal: null,
        status: async () => {
          throw Error("gone");
        },
      }),
    ).toContain("could not be checked");
    let signal: AbortSignal | undefined;
    expect(
      await referenceSessionGuidance({
        pairingCode: "1234",
        protocolRefusal: null,
        timeoutMs: 5,
        status: async (s) => {
          signal = s;
          return new Promise(() => {});
        },
      }),
    ).toContain("could not be checked");
    expect(signal?.aborted).toBe(true);
  });
});

import { describe, it, expect, vi } from "vitest";
import { requestUntilApproved } from "~/services/plugin-bridge/await-approval.js";
const pending = { type: "PENDING_APPROVAL" };
const granted = { type: "APPROVAL_GRANTED" };

function clock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
  };
}

describe("approval before single submission", () => {
  it("waits for Allow without sending code, then executes once and stops progress", async () => {
    let polls = 0;
    const submit = vi.fn(async () => "committed");
    const stop = vi.fn(async () => {});
    expect(
      await requestUntilApproved(async () => (++polls < 3 ? pending : granted), submit, {
        ...clock(),
        onWaiting: () => stop,
      }),
    ).toBe("committed");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it("never resends an approved run that committed and then timed out", async () => {
    let commits = 0;
    let polls = 0;
    await expect(
      requestUntilApproved(
        async () => (++polls < 2 ? pending : granted),
        async () => {
          commits++;
          throw new Error("completion unconfirmed");
        },
        clock(),
      ),
    ).rejects.toThrow("unconfirmed");
    expect(commits).toBe(1);
  });
  it.each(["APPROVAL_REJECTED", "disconnect"])(
    "%s while waiting submits nothing and stops progress",
    async (outcome) => {
      let polls = 0;
      const stop = vi.fn(async () => {});
      const submit = vi.fn();
      await expect(
        requestUntilApproved(
          async () => {
            if (++polls === 1) return pending;
            if (outcome === "disconnect") throw new Error("disconnected");
            return { type: outcome };
          },
          submit,
          { ...clock(), onWaiting: () => stop },
        ),
      ).rejects.toThrow();
      expect(submit).not.toHaveBeenCalled();
      expect(stop).toHaveBeenCalledTimes(1);
    },
  );
  it("a late Allow after caller cancellation never submits the abandoned body", async () => {
    const caller = new AbortController();
    const submit = vi.fn();
    const stop = vi.fn(async () => {});
    let polls = 0;
    await expect(
      requestUntilApproved(
        async () => {
          if (++polls === 1) return pending;
          caller.abort(new Error("caller disconnected"));
          return granted;
        },
        submit,
        { ...clock(), signal: caller.signal, onWaiting: () => stop },
      ),
    ).rejects.toThrow("caller disconnected");
    expect(submit).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it("expires locally without submitting or polling beyond the deadline", async () => {
    const submit = vi.fn();
    const status = vi.fn(async () => pending);
    expect(
      await requestUntilApproved(status, submit, { ...clock(), waitMs: 1000, pollMs: 500 }),
    ).toEqual(pending);
    expect(status).toHaveBeenCalledTimes(2);
    expect(submit).not.toHaveBeenCalled();
  });
});

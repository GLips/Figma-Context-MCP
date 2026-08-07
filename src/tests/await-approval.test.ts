import { describe, it, expect } from "vitest";
import {
  requestUntilApproved,
  isPendingApproval,
} from "~/services/plugin-bridge/await-approval.js";

// A fake clock so the deadline is exercised without waiting real seconds: `sleep` advances it rather
// than scheduling a timer, which makes the poll/expiry behaviour deterministic.
function fakeClock() {
  let t = 0;
  const advance = (ms: number) => {
    t += ms;
  };
  return { now: () => t, advance, sleep: async (ms: number) => advance(ms) };
}

const PENDING = { type: "PENDING_APPROVAL" };

describe("holding a gated call open across the human's Allow", () => {
  it("returns the real result from the poll that sees the approval, without the agent retrying", async () => {
    const clock = fakeClock();
    let calls = 0;
    // Approval lands on the 4th send — the human clicked partway through the wait.
    const send = async () => {
      calls += 1;
      return calls < 4 ? PENDING : { result: "ok", console: [], errors: null };
    };

    const reply = await requestUntilApproved(send, {
      now: clock.now,
      sleep: clock.sleep,
      pollMs: 750,
    });

    expect(reply).toEqual({ result: "ok", console: [], errors: null });
    expect(calls).toBe(4);
  });

  it("gives up at the deadline and hands back the gated reply for the caller to shape", async () => {
    const clock = fakeClock();
    let calls = 0;
    const send = async () => {
      calls += 1;
      return PENDING; // the human never clicks
    };

    const reply = await requestUntilApproved(send, {
      now: clock.now,
      sleep: clock.sleep,
      waitMs: 3_000,
      pollMs: 1_000,
    });

    expect(isPendingApproval(reply)).toBe(true);
    // Bounded by wall-clock, so it stops rather than spinning: sends at t=0,1000,2000,3000.
    expect(calls).toBe(4);
  });

  it("does not poll at all when the session is already approved", async () => {
    const clock = fakeClock();
    let calls = 0;
    const send = async () => {
      calls += 1;
      return { result: 42, console: [], errors: null };
    };

    await requestUntilApproved(send, { now: clock.now, sleep: clock.sleep });

    expect(calls).toBe(1);
  });

  it("rides through a socket drop mid-wait instead of dying on the blip it exists to outlast", async () => {
    const clock = fakeClock();
    let calls = 0;
    // The plugin's socket drops on sends 2–4 (PluginBridge rejects in-flight and fresh requests while
    // it's down), then ui.html redials and the human's Allow lands.
    const send = async () => {
      calls += 1;
      if (calls === 1) return PENDING;
      if (calls <= 4) throw new Error("Figma plugin disconnected before replying.");
      return { result: "survived", console: [], errors: null };
    };

    const reply = await requestUntilApproved(send, {
      now: clock.now,
      sleep: clock.sleep,
      waitMs: 30_000,
      pollMs: 750,
    });

    expect(reply).toEqual({ result: "survived", console: [], errors: null });
  });

  it("fails fast when no plugin is connected at all, rather than hanging for the whole window", async () => {
    const clock = fakeClock();
    let calls = 0;
    const send = async () => {
      calls += 1;
      throw new Error("No Figma plugin connected. Open the Framelink plugin in Figma desktop.");
    };

    await expect(
      requestUntilApproved(send, { now: clock.now, sleep: clock.sleep }),
    ).rejects.toThrow(/No Figma plugin connected/);
    expect(calls).toBe(1);
    expect(clock.now()).toBe(0); // never slept
  });

  it("lets a reconnecting plugin land before the first send, instead of reporting none connected", async () => {
    const clock = fakeClock();
    // The server restarted: the relay is bound and holds the reloaded token, but ui.html hasn't
    // redialed yet, so a send right now would hit the bridge's hard rejection.
    let pluginConnected = false;
    let calls = 0;
    const send = async () => {
      calls += 1;
      if (!pluginConnected) throw new Error("No Figma plugin connected.");
      return { result: "ok", console: [], errors: null };
    };

    const reply = await requestUntilApproved(send, {
      now: clock.now,
      sleep: clock.sleep,
      awaitPluginConnection: async () => {
        pluginConnected = true;
      },
    });

    expect(reply).toEqual({ result: "ok", console: [], errors: null });
    // One send, and none of the human's approval budget spent on the machine's reconnect.
    expect(calls).toBe(1);
    expect(clock.now()).toBe(0);
  });

  it("surfaces the transport error, not a consent message, when the wait ends with the plugin gone", async () => {
    const clock = fakeClock();
    let calls = 0;
    const send = async () => {
      calls += 1;
      if (calls === 1) return PENDING;
      throw new Error("Figma plugin disconnected before replying.");
    };

    // "not approved yet" would be a lie about a plugin that went away.
    await expect(
      requestUntilApproved(send, {
        now: clock.now,
        sleep: clock.sleep,
        waitMs: 3_000,
        pollMs: 1_000,
      }),
    ).rejects.toThrow(/disconnected before replying/);
  });

  it("counts time spent inside a slow send against the deadline, not just the sleeps", async () => {
    const clock = fakeClock();
    let calls = 0;
    // Each send itself burns 2s — with an attempt-count bound this would overshoot the window badly.
    const send = async () => {
      calls += 1;
      clock.advance(2_000);
      return PENDING;
    };

    await requestUntilApproved(send, {
      now: clock.now,
      sleep: clock.sleep,
      waitMs: 5_000,
      pollMs: 500,
    });

    // t after each round: 2000, 4500, 7000 — the third send crosses the 5s deadline and stops.
    expect(calls).toBe(3);
  });
});

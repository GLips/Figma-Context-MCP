import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginBridge } from "~/services/plugin-bridge/bridge.js";
import { ApprovalStore } from "~/services/plugin-bridge/approval-store.js";

/**
 * What a restarted server decides about a plugin it can't see yet, driven through the REAL bind path
 * (temp store on disk → `start()` → `listening` → the record it reloads) rather than a stubbed
 * boolean. The wiring is the part that breaks: an approval sitting in its 24h TTL is not evidence that
 * a plugin is around, and reading it as though it were left write tools advertised all day to someone
 * whose Figma was closed.
 *
 * Ports are far outside WS_PORT_BLOCK so this never races a real dev server on the same machine.
 */

const CWD = "/project/root";
const RECENT_APPROVAL_MS = 30 * 60 * 1000;

let dirs: string[] = [];
let bridges: PluginBridge[] = [];

afterEach(() => {
  for (const bridge of bridges) bridge.stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  bridges = [];
  dirs = [];
});

/** Seed a store with an approval last used `ageMs` ago, bind a bridge to `port`, and wait for it. */
async function bridgeBoundOnApproval(port: number, ageMs: number | null): Promise<PluginBridge> {
  const dir = mkdtempSync(join(tmpdir(), "flcm-recency-test-"));
  dirs.push(dir);
  const store = new ApprovalStore(CWD, dir);
  if (ageMs !== null) store.save(port, "tok-abc", CWD, Date.now() - ageMs);
  const bridge = new PluginBridge(store);
  bridges.push(bridge);
  bridge.start([port]);
  // `listening` is async, and every claim here is about what the bind reloaded.
  for (let i = 0; i < 200 && !bridge.getSessionToken() && ageMs !== null; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  if (ageMs === null) await new Promise((r) => setTimeout(r, 50));
  return bridge;
}

describe("what a freshly bound relay believes about a plugin it hasn't seen", () => {
  it("expects a plugin when the approval on this port was used minutes ago", async () => {
    const bridge = await bridgeBoundOnApproval(45231, 5 * 60 * 1000);

    expect(bridge.hasRecentApproval()).toBe(true);
    // Still nothing on the wire — recency is a guess about the plugin, never a liveness claim.
    expect(bridge.isPluginConnected()).toBe(false);
  });

  it("does not, when the approval is merely unexpired — the case that leaked write tools all day", async () => {
    // Well inside the store's 24h TTL (so the token still loads and will still be echoed) but far
    // outside any window in which a plugin is plausibly still open.
    const bridge = await bridgeBoundOnApproval(45232, RECENT_APPROVAL_MS + 60 * 60 * 1000);

    expect(bridge.getSessionToken()).toBe("tok-abc");
    expect(bridge.hasRecentApproval()).toBe(false);
  });

  it("does not, on a genuine cold start with nothing persisted", async () => {
    const bridge = await bridgeBoundOnApproval(45233, null);

    expect(bridge.hasRecentApproval()).toBe(false);
  });
});

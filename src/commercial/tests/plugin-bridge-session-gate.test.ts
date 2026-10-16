/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Approval-mutating relay messages are honored only from an authenticated link. A local process or
// a page using `Origin: null` that never proves the installation credential must not plant or wipe
// the durable approval, whether it answers HELLO or not; a paired plugin's handover must land.
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { WebSocket } from "ws";
import { PluginBridge } from "~/commercial/plugin-bridge/bridge.js";
import { ApprovalStore } from "~/commercial/plugin-bridge/approval-store.js";
import { answerLinkSetup } from "./fixtures/plugin-link-peer.js";

const SEEDED = "seededsessiontoken0000000";
const PLANTED = "plantedsessiontoken000000";
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

async function freePort(): Promise<number> {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as { port: number };
  probe.close();
  return port;
}

async function startBridge() {
  const store = new ApprovalStore(
    "/session-gate-test",
    mkdtempSync(join(tmpdir(), "session-gate-")),
  );
  const port = await freePort();
  store.save(port, SEEDED, "test", Date.now());
  const bridge = new PluginBridge(store);
  bridge.start([port]);
  cleanup.push(() => bridge.stop());
  await expect.poll(() => bridge.approvedSession()?.token).toBe(SEEDED);
  return { bridge, store, port, url: `ws://127.0.0.1:${port}` };
}

async function connect(url: string, setup: "silent" | "unpaired" | "paired"): Promise<WebSocket> {
  const ws = new WebSocket(url);
  cleanup.push(() => ws.close());
  ws.on("message", (raw) => {
    const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
    if (setup === "silent") return;
    answerLinkSetup((reply) => ws.send(JSON.stringify(reply)), frame, {
      paired: setup === "paired",
    });
  });
  await once(ws, "open");
  return ws;
}

it.each(["silent", "unpaired"] as const)(
  "a %s link can neither plant nor revoke approval",
  async (setup) => {
    const { bridge, store, port, url } = await startBridge();
    const squatter = await connect(url, setup);
    await new Promise((resolve) => setTimeout(resolve, 50));
    squatter.send(JSON.stringify({ type: "SESSION_TOKEN", sessionToken: PLANTED }));
    squatter.send(JSON.stringify({ type: "REVOKE_SESSION" }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(bridge.approvedSession()?.token).toBe(SEEDED);
    expect(store.loadRecord(port, Date.now())?.token).toBe(SEEDED);
  },
);

it("a paired plugin's handover lands", async () => {
  const { bridge, url } = await startBridge();
  const plugin = await connect(url, "paired");
  await expect.poll(() => bridge.authenticatedLinks().length).toBe(1);
  plugin.send(JSON.stringify({ type: "SESSION_TOKEN", sessionToken: PLANTED }));
  await expect.poll(() => bridge.approvedSession()?.token).toBe(PLANTED);
});

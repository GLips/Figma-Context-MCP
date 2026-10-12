/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Approval-mutating relay messages are honored only from a connection that passed the version
// handshake. A squatter holding the free slot (any Origin-less local process, or a page using
// `Origin: null`) must not plant or wipe the durable approval; a real plugin's handover, which can
// arrive right behind its GET_VERSION reply, must still land.
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { WebSocket } from "ws";
import { PluginBridge } from "~/commercial/plugin-bridge/bridge.js";
import { ApprovalStore } from "~/commercial/plugin-bridge/approval-store.js";
import { PROTOCOL_VERSION } from "@framelink/plugin/protocol";

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
  store.save(port, SEEDED, "test", null, Date.now());
  const bridge = new PluginBridge(store);
  bridge.start([port]);
  cleanup.push(() => bridge.stop());
  await expect.poll(() => bridge.approvedSession()?.token).toBe(SEEDED);
  return { bridge, store, port, url: `ws://127.0.0.1:${port}` };
}

async function connect(url: string, answerVersion: boolean): Promise<WebSocket> {
  const ws = new WebSocket(url);
  cleanup.push(() => ws.close());
  ws.on("message", (raw) => {
    const frame = JSON.parse(raw.toString()) as { id?: string; type?: string };
    if (!answerVersion || frame.type !== "GET_VERSION") return;
    ws.send(
      JSON.stringify({
        type: "VERSION",
        id: frame.id,
        protocolVersion: PROTOCOL_VERSION,
        pluginVersion: "t",
      }),
    );
    // Back-to-back with the reply, before the bridge can have settled its verdict.
    ws.send(JSON.stringify({ type: "SESSION_TOKEN", sessionToken: PLANTED }));
  });
  await once(ws, "open");
  return ws;
}

it("a connection that never passed the version handshake can neither plant nor revoke approval", async () => {
  const { bridge, store, port, url } = await startBridge();
  const squatter = await connect(url, false);
  squatter.send(JSON.stringify({ type: "SESSION_TOKEN", sessionToken: PLANTED }));
  squatter.send(JSON.stringify({ type: "REVOKE_SESSION" }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(bridge.approvedSession()?.token).toBe(SEEDED);
  expect(store.loadRecord(port, Date.now())?.token).toBe(SEEDED);
});

it("a compatible plugin's handover lands even when it arrives before the verdict", async () => {
  const { bridge, url } = await startBridge();
  await connect(url, true);
  await expect.poll(() => bridge.approvedSession()?.token).toBe(PLANTED);
});

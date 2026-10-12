/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The wire contract, end to end: the production relay and the real plugin (ui.ts + code.ts, built
// from source) over a real socket. Every other bridge test talks to a stand-in, so this is the one
// place a change made on one side of plugin/src/protocol.ts alone fails.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPluginBridge, type PluginBridgeRuntime } from "~/commercial/plugin-bridge/index.js";
import { executePluginCode } from "~/commercial/plugin-bridge/execution.js";
import { WriteAccessStore } from "~/commercial/entitlement/write-access-store.js";
import { writesUsedThisMonth } from "~/commercial/entitlement/write-ledger.js";
import { startLoopbackPlugin, type LoopbackPlugin } from "./fixtures/loopback-plugin.js";

const ports = vi.hoisted(() => [] as number[]);
vi.mock("@framelink/plugin/protocol", async (actual) => ({
  ...(await actual<typeof import("@framelink/plugin/protocol")>()),
  WS_PORT_BLOCK: ports,
}));

let dir: string;
let runtime: PluginBridgeRuntime;
let plugin: LoopbackPlugin;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flcm-loopback-"));
  vi.stubEnv("FRAMELINK_STATE_DIR", dir);
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  ports.splice(0, ports.length, address.port);
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  // Unroutable: write access works offline, from the free allowance.
  runtime = startPluginBridge({ assetRoot: dir, framelinkApiUrl: "http://127.0.0.1:9" });
  plugin = startLoopbackPlugin(ports[0]);
  await expect
    .poll(() => runtime.bridge.protocolCompatibility(), { timeout: 5_000 })
    .toBe("compatible");
});

afterEach(async () => {
  plugin.close();
  runtime.stop?.();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const execute = (code: string) =>
  executePluginCode(runtime, code, {
    onWaiting: () => {
      void plugin.allow();
      return async () => {};
    },
  });

it("handshakes, waits for Allow, then settles a clean run uncharged and charges a late change", async () => {
  const read = await execute("return 1 + 1;");
  expect(read).toMatchObject({ kind: "executed", reply: { result: 2, console: [], errors: null } });

  // The next run closes the read's late-change watch clean (RUN_SETTLED, long before the ceiling),
  // and Figma reports the raw write's change only after its reply: RUN_CHANGED charges it then.
  const write = await execute("figma.createRectangle(); return 'drawn';");
  expect(write).toMatchObject({ kind: "executed", reply: { result: "drawn" } });
  const drained = runtime.writeMeter.drain(new AbortController().signal);
  plugin.deliverChanges();
  await drained;
  const writesUsed = () =>
    writesUsedThisMonth(new WriteAccessStore().read().ledger, "loopback-user", new Date());
  expect(writesUsed()).toBe(1);
});

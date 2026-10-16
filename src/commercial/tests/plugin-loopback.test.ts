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
import { PassThrough } from "node:stream";
import { startPluginBridge, type PluginBridgeRuntime } from "~/commercial/plugin-bridge/index.js";
import { PluginBridge, type PluginLink } from "~/commercial/plugin-bridge/bridge.js";
import { ApprovalStore } from "~/commercial/plugin-bridge/approval-store.js";
import { LinkCredentialStore } from "~/commercial/plugin-bridge/link-credential.js";
import { executePluginCode } from "~/commercial/plugin-bridge/execution.js";
import { runPair } from "~/commercial/commands/pair.js";
import { WriteAccessStore } from "~/commercial/entitlement/write-access-store.js";
import { writesUsedThisMonth } from "~/commercial/entitlement/write-ledger.js";
import { startLoopbackPlugin, type LoopbackPlugin } from "./fixtures/loopback-plugin.js";

const ports = vi.hoisted(() => [] as number[]);
vi.mock("@framelink/plugin/protocol", async (actual) => ({
  ...(await actual<typeof import("@framelink/plugin/protocol")>()),
  WS_PORT_BLOCK: ports,
}));

let dir: string;
const cleanups: (() => void)[] = [];

async function reservePort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  return address.port;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flcm-loopback-"));
  vi.stubEnv("FRAMELINK_STATE_DIR", dir);
  ports.splice(0, ports.length, await reservePort());
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

function startRuntime(): PluginBridgeRuntime {
  // Unroutable: write access works offline, from the free allowance.
  const runtime = startPluginBridge({ assetRoot: dir, framelinkApiUrl: "http://127.0.0.1:9" });
  cleanups.push(() => runtime.stop?.());
  return runtime;
}

function startPlugin(...args: Parameters<typeof startLoopbackPlugin>): LoopbackPlugin {
  const plugin = startLoopbackPlugin(...args);
  cleanups.push(() => plugin.close());
  return plugin;
}

/** A bare relay with its own state dir, for tests about which servers share a pairing. */
function startBridge(stateDir: string, port: number): PluginBridge {
  const bridge = new PluginBridge(new ApprovalStore("/loopback", stateDir), {
    linkCredentials: new LinkCredentialStore(stateDir),
  });
  bridge.start([port]);
  cleanups.push(() => bridge.stop());
  return bridge;
}

/** Wait until `bridge` resolves a link of `kind` — a plugin redials and sets up on its own clock. */
async function settlesTo(bridge: PluginBridge, kind: string) {
  await expect.poll(async () => (await bridge.resolveLink()).kind, { timeout: 5_000 }).toBe(kind);
}

/** Pair through the bridge the way an agent does: offer, read the panel, confirm what it shows. */
async function pairByPanel(bridge: PluginBridge, plugin: LoopbackPlugin): Promise<PluginLink> {
  await settlesTo(bridge, "unpaired");
  const offer = await bridge.offerPairing();
  if (offer.kind !== "offered") throw new Error(`no pairing offered: ${offer.kind}`);
  const shown = await plugin.pairingCode();
  expect(offer.attempts.map((attempt) => attempt.code)).toContain(shown);
  const confirmed = await bridge.confirmPairing(shown);
  if (confirmed.kind !== "paired") throw new Error(`not paired: ${confirmed.kind}`);
  return confirmed.link;
}

it("pairs by the code the panel shows, waits for Allow, then settles a clean run uncharged and charges a late change", async () => {
  const runtime = startRuntime();
  const plugin = startPlugin(ports[0]);
  const link = await pairByPanel(runtime.bridge, plugin);
  expect(link.owner).toEqual({ figmaUserId: "loopback-user", name: "Loopback Human" });
  const execute = (code: string) =>
    executePluginCode(runtime, link, code, {
      onWaiting: () => {
        void plugin.allow();
        return async () => {};
      },
    });

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

it("after one confirmation, a reconnect and a server restart authenticate without a prompt", async () => {
  const first = startRuntime();
  const plugin = startPlugin(ports[0]);
  await pairByPanel(first.bridge, plugin);

  plugin.drop();
  await settlesTo(first.bridge, "disconnected");
  await settlesTo(first.bridge, "linked");

  first.stop?.();
  const restarted = startRuntime();
  await settlesTo(restarted.bridge, "linked");
  expect(plugin.showsPairingCode()).toBe(false);
});

it("the pair command confirms at its terminal what the panel shows, and pairs every server on its state dir", async () => {
  const plugin = startPlugin(ports[0]);
  const input = new PassThrough();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const paired = runPair({ wait: 5 }, { input });
  await plugin.pairingCode();
  input.write("y\n");
  expect(await paired).toBe(0);

  const runtime = startRuntime();
  await settlesTo(runtime.bridge, "linked");
});

it("servers sharing a state dir need one confirmation; pairing another state dir leaves the first working", async () => {
  ports.push(await reservePort(), await reservePort());
  const otherDir = await mkdtemp(join(tmpdir(), "flcm-loopback-other-"));
  cleanups.push(() => void rm(otherDir, { recursive: true, force: true }));
  const first = startBridge(dir, ports[0]);
  const sibling = startBridge(dir, ports[1]);
  const elsewhere = startBridge(otherDir, ports[2]);
  const plugin = startPlugin(ports);

  await pairByPanel(first, plugin);
  await settlesTo(sibling, "linked");
  await settlesTo(elsewhere, "unpaired");

  await pairByPanel(elsewhere, plugin);
  await settlesTo(first, "linked");
  await settlesTo(sibling, "linked");
});

it("two files of one installation authenticate side by side, and a call refuses to pick between them", async () => {
  const runtime = startRuntime();
  const storage = new Map<string, unknown>();
  const one = startPlugin(ports[0], { storage });
  await pairByPanel(runtime.bridge, one);
  startPlugin(ports[0], { storage });

  await expect.poll(() => runtime.bridge.authenticatedLinks().length, { timeout: 5_000 }).toBe(2);
  expect(await runtime.bridge.resolveLink()).toEqual({ kind: "several", count: 2 });
});

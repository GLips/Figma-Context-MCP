/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// What a plugin link must prove before it is driven, and what pairing may confirm.
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "@framelink/plugin/protocol";
import { PluginBridge } from "~/commercial/plugin-bridge/bridge.js";
import { LinkCredentialStore } from "~/commercial/plugin-bridge/link-credential.js";
import { Logger } from "~/utils/logger.js";
import { connectFakePlugin, FakePluginSocket } from "./fixtures/fake-plugin-socket.js";

const bridges: PluginBridge[] = [];
function create(options: ConstructorParameters<typeof PluginBridge>[1] = {}) {
  const bridge = new PluginBridge(undefined, options);
  bridges.push(bridge);
  return bridge;
}
afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.stop();
  vi.restoreAllMocks();
});

it("an unpaired link is sent only the setup envelope, and nothing it sends is heard", async () => {
  const onRunEvent = vi.fn();
  const capability = vi.fn();
  const bridge = create({
    events: { onRunEvent },
    capabilities: new Map([["images.fetch", capability]]),
  });
  const socket = await connectFakePlugin(bridge, { paired: false });

  socket.receive({ type: "SESSION_TOKEN", sessionToken: "squattersessiontoken000" });
  socket.receive({ type: "RUN_CHANGED", runId: "r" });
  socket.receive({
    type: "CHANNEL_REQUEST",
    id: "q",
    runId: "r",
    capability: "images.fetch",
    payload: [],
  });
  await Promise.resolve();

  expect(await bridge.resolveLink()).toEqual({ kind: "unpaired" });
  expect(bridge.authenticatedLinks()).toEqual([]);
  expect(bridge.approvedSession()).toBeNull();
  expect(onRunEvent).not.toHaveBeenCalled();
  expect(capability).not.toHaveBeenCalled();
  // resolveLink challenged it again; nothing else was sent, not even a channel refusal.
  expect(new Set(socket.frames.map((frame) => frame.type))).toEqual(new Set(["AUTHENTICATE"]));
});

it("a plugin on another protocol is told to re-import by HELLO alone and sent nothing else", async () => {
  vi.spyOn(Logger, "log").mockImplementation(() => {});
  const bridge = create();
  const socket = new FakePluginSocket(false, null);
  socket.onFrame = (frame) => {
    if (frame.type === "HELLO")
      socket.receive({ type: "HELLO_RESULT", id: frame.id, protocolVersion: PROTOCOL_VERSION - 1 });
  };
  bridge.accept(socket as unknown as WebSocket);

  const resolution = await bridge.resolveLink();
  expect(resolution).toMatchObject({ kind: "incompatible" });
  expect(JSON.stringify(resolution)).toContain("re-import the latest Framelink plugin");
  expect(socket.frames.map((frame) => frame.type)).toEqual(["HELLO"]);
  expect(await bridge.offerPairing()).toEqual({ kind: "none" });
});

it("a wrong proof closes the link", async () => {
  vi.spyOn(Logger, "log").mockImplementation(() => {});
  const bridge = create();
  const socket = new FakePluginSocket(true, { id: "wrong", secret: "guessed" });
  socket.onFrame = (frame) => {
    if (frame.type === "AUTHENTICATE")
      socket.receive({ type: "LINK_PROOF", id: frame.id, proof: "0".repeat(64), owner: null });
  };
  bridge.accept(socket as unknown as WebSocket);

  expect(await bridge.resolveLink()).toMatchObject({ kind: "disconnected" });
  expect(socket.readyState).toBe(3);
});

it("a credential file the server can't read blocks calls with the reason, until it is fixed", async () => {
  vi.spyOn(Logger, "log").mockImplementation(() => {});
  const dir = await mkdtemp(join(tmpdir(), "flcm-credential-"));
  const file = join(dir, "plugin-link-credential.json");
  await writeFile(file, "not json");
  const bridge = create({ linkCredentials: new LinkCredentialStore(dir) });
  bridge.accept(new FakePluginSocket(true, null) as unknown as WebSocket);

  const blocked = await bridge.resolveLink();
  expect(blocked).toMatchObject({ kind: "credential-unusable" });
  expect(JSON.stringify(blocked)).toContain("is malformed. Delete it and pair");

  await rm(file);
  expect(await bridge.resolveLink()).toEqual({ kind: "unpaired" });
  await rm(dir, { recursive: true });
});

it("a confirmation pairs only the link showing its code, once", async () => {
  const bridge = create();
  const shown = await connectFakePlugin(bridge, { paired: false });
  const other = await connectFakePlugin(bridge, { paired: false });

  const offer = await bridge.offerPairing();
  if (offer.kind !== "offered") throw new Error(offer.kind);
  const codeOf = (socket: FakePluginSocket) =>
    String(socket.frames.find((frame) => frame.type === "PAIRING_OFFER")?.code);
  expect(offer.attempts.map((attempt) => attempt.code).sort()).toEqual(
    [codeOf(shown), codeOf(other)].sort(),
  );

  const confirmed = await bridge.confirmPairing(codeOf(shown).toLowerCase().replace("-", " "));
  expect(confirmed).toMatchObject({ kind: "paired", link: { socket: shown } });
  expect(other.frames.some((frame) => frame.type === "PAIR_CONFIRMED")).toBe(false);
  expect(await bridge.resolveLink()).toMatchObject({ kind: "linked", link: { socket: shown } });
  expect(await bridge.confirmPairing(codeOf(shown))).toEqual({ kind: "unknown-code" });
});

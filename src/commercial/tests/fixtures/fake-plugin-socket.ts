/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "@framelink/plugin/protocol";
import type { PluginBridge } from "~/commercial/plugin-bridge/bridge.js";

/**
 * An in-memory plugin socket, handed to `PluginBridge.accept` the way the listener hands it a real
 * one. `frames` records what the bridge sent; `receive` delivers a frame as the plugin would.
 */
export class FakePluginSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly frames: Array<Record<string, unknown>> = [];
  /** Sees every frame the bridge sends, after its JSON round trip — to relay it on to a plugin. */
  onFrame?: (frame: Record<string, unknown>) => void;

  constructor(private readonly answersVersion: boolean) {
    super();
  }

  send(raw: string): void {
    const frame = JSON.parse(raw) as Record<string, unknown>;
    this.frames.push(frame);
    this.onFrame?.(frame);
    if (this.answersVersion && frame.type === "GET_VERSION")
      this.receive({
        type: "VERSION",
        id: frame.id,
        protocolVersion: PROTOCOL_VERSION,
        pluginVersion: "test",
      });
  }

  receive(frame: Record<string, unknown>): void {
    this.receiveRaw(JSON.stringify(frame));
  }

  receiveRaw(raw: string): void {
    this.emit("message", Buffer.from(raw));
  }

  ping(): void {}

  terminate(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
}

/**
 * Connect a fake plugin and wait out its version handshake. `answersVersion: false` leaves the
 * connection `checking` — a socket that never proves which protocol it speaks. `frames` starts empty
 * after the handshake, so a test reads only what its own requests sent.
 */
export async function connectFakePlugin(
  bridge: PluginBridge,
  { answersVersion = true }: { answersVersion?: boolean } = {},
): Promise<FakePluginSocket> {
  const socket = new FakePluginSocket(answersVersion);
  bridge.accept(socket as unknown as WebSocket);
  for (let i = 0; answersVersion && bridge.protocolCompatibility() === "checking"; i++) {
    if (i > 50) throw new Error("the fake plugin's version handshake never settled");
    await Promise.resolve();
  }
  socket.frames.length = 0;
  return socket;
}

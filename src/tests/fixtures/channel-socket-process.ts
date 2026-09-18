// Run in a child process: an unhandled ws error must fail the test, not escape Vitest's worker.
import assert from "node:assert/strict";
import { connect } from "node:net";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, type WebSocketServer } from "ws";
import { PluginBridge } from "../../services/plugin-bridge/bridge.js";
import { ApprovalStore } from "../../services/plugin-bridge/approval-store.js";
import { MIN_PROTOCOL_VERSION } from "../../services/plugin-bridge/version.js";

const mode = process.argv[2];
const directory = await mkdtemp(join(tmpdir(), "fig70-socket-"));
let release!: () => void;
const cleanup = new Promise<void>((resolve) => {
  release = resolve;
});
let started!: () => void;
const serviceStarted = new Promise<void>((resolve) => {
  started = resolve;
});
let aborted!: () => void;
const serviceAborted = new Promise<void>((resolve) => {
  aborted = resolve;
});
const bridge = new PluginBridge(new ApprovalStore(directory, directory), {
  requestTimeoutMs: 30_000,
  capabilities: new Map([
    [
      "test.wait",
      async (_payload, { signal }) => {
        const stop = new Promise<void>((resolve) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted();
              resolve();
            },
            { once: true },
          ),
        );
        started();
        await stop;
        await cleanup;
        return "late";
      },
    ],
  ]),
});
// Port 0 avoids conflicts between test processes. Only discovery uses internals; traffic is real.
bridge.start([0]);
let server: WebSocketServer | undefined;
while (!(server = Reflect.get(bridge, "wss")))
  await new Promise((resolve) => setImmediate(resolve));
const address = server.address();
assert(address && typeof address !== "string");
const port = address.port;

async function peer() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "null" });
  ws.on("error", () => {});
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "GET_VERSION")
      ws.send(
        JSON.stringify({ type: "VERSION", id: message.id, protocolVersion: MIN_PROTOCOL_VERSION }),
      );
    if (message.type === "PING") ws.send(JSON.stringify({ type: "PONG", id: message.id }));
    if (message.type === "EXECUTE_CODE")
      ws.send(
        JSON.stringify({
          type: "CHANNEL_REQUEST",
          id: "work",
          runId: message.id,
          capability: "test.wait",
          payload: null,
        }),
      );
  });
  await once(ws, "open");
  return ws;
}
function oversizedHeader() {
  const header = Buffer.alloc(14);
  header[0] = 0x82; // FIN, binary
  header[1] = 0xff; // masked, 64-bit length
  header.writeBigUInt64BE(BigInt(100 * 1024 * 1024 + 1), 2);
  return header; // four zero mask bytes; deliberately no payload
}
try {
  if (mode === "unhandshaked") {
    const tcp = connect(port, "127.0.0.1");
    tcp.on("error", () => {});
    await once(tcp, "connect");
    const closed = new Promise<void>((resolve) => tcp.once("close", () => resolve()));
    const upgraded = new Promise<string>((resolve) => {
      let reply = "";
      tcp.on("data", (chunk) => {
        reply += chunk.toString("latin1");
        if (reply.includes("\r\n\r\n")) resolve(reply);
      });
    });
    tcp.write(
      `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: null\r\n\r\n`,
    );
    assert.match(await upgraded, /^HTTP\/1\.1 101 /);
    tcp.write(oversizedHeader());
    await closed;
  } else {
    const ws = await peer();
    const result = bridge
      .request({ type: "EXECUTE_CODE", code: "unused", preamble: "unused" })
      .catch((error) => error);
    await serviceStarted;
    const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
    if (mode === "disconnect") ws.close();
    else {
      // Write an intentionally malformed frame onto the real client transport; ws.send cannot
      // express a declared length without allocating its payload.
      const transport = Reflect.get(ws, "_socket") as import("node:net").Socket;
      transport.write(oversizedHeader());
    }
    await serviceAborted;
    assert.match(String(await result), /disconnected/);
    const accounting = Reflect.get(bridge, "inFlightServices") as Map<string, number>;
    assert.equal(
      [...accounting.values()].reduce((a, b) => a + b, 0),
      1,
    );
    release();
    while (accounting.size) await new Promise((resolve) => setImmediate(resolve));
    await closed;
  }
  assert.equal((Reflect.get(bridge, "pending") as Map<string, unknown>).size, 0);
  // Prove the same server process remains usable and accepts a replacement connection.
  const replacement = await peer();
  const pong = await bridge.request({ type: "PING", payload: "alive" });
  assert.equal((pong as { type: string }).type, "PONG");
  replacement.close();
  await once(replacement, "close");
  process.stdout.write(`PASS ${mode}\n`);
} finally {
  release();
  bridge.stop();
  await rm(directory, { recursive: true, force: true });
}

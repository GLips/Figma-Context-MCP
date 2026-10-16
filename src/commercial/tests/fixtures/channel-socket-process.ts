/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Run in a child process: an unhandled ws error must fail the test, not escape Vitest's worker.
import assert from "node:assert/strict";
import { connect } from "node:net";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { PluginBridge } from "../../plugin-bridge/bridge.js";
import { mintExecutionId } from "../../execution-id.js";
import { answerLinkSetup } from "./plugin-link-peer.js";
import { TEST_DOCUMENT, TEST_SESSION_REQUEST } from "./write-access.js";

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
const bridge = new PluginBridge({
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
// Port 0 avoids conflicts between test processes; `bridge.port` reads back the one the OS picked.
bridge.start([0]);
let port: number | null;
while (!(port = bridge.port)) await new Promise((resolve) => setImmediate(resolve));

async function peer() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "null" });
  ws.on("error", () => {});
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    answerLinkSetup((frame) => ws.send(JSON.stringify(frame)), message);
    if (message.type === "GRANT_STATUS")
      ws.send(JSON.stringify({ type: "GRANT", id: message.id, state: "absent" }));
    if (message.type === "EXECUTE_CODE")
      ws.send(
        JSON.stringify({
          type: "CHANNEL_REQUEST",
          id: "work",
          executionId: message.id,
          capability: "test.wait",
          payload: null,
        }),
      );
  });
  await once(ws, "open");
  const resolution = await bridge.resolveLink();
  assert.equal(resolution.kind, "linked");
  return { ws, link: (resolution as Extract<typeof resolution, { kind: "linked" }>).links[0] };
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
    const { ws, link } = await peer();
    const result = bridge
      .submitRun(
        link,
        {
          type: "EXECUTE_CODE",
          session: TEST_SESSION_REQUEST,
          documentId: TEST_DOCUMENT.documentId,
          code: "unused",
          preamble: "unused",
          lateChangeWindowMs: 60_000,
        },
        mintExecutionId(),
      )
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
    release();
    await closed;
  }
  // Prove the same server process remains usable and accepts a replacement connection.
  const { ws: replacement, link } = await peer();
  const status = await bridge.request(link, {
    type: "GRANT_STATUS",
    executionId: mintExecutionId(),
    documentId: TEST_DOCUMENT.documentId,
    prompt: "none",
  });
  assert.equal(status.type, "GRANT");
  replacement.close();
  await once(replacement, "close");
  process.stdout.write(`PASS ${mode}\n`);
} finally {
  release();
  bridge.stop();
  await rm(directory, { recursive: true, force: true });
}

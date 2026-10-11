/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { runExecute } from "~/commercial/commands/execute.js";
import { WriteAccessStore } from "~/commercial/entitlement/write-access-store.js";
import {
  FREE_WRITE_ALLOWANCE,
  writesUsedThisMonth,
} from "~/commercial/entitlement/write-ledger.js";
import { PluginBridge } from "~/commercial/plugin-bridge/bridge.js";
import { MIN_PROTOCOL_VERSION } from "~/commercial/plugin-bridge/version.js";

// Exercise production startup/handshake/images/execution on an ephemeral test port.
// Figma only scans its fixed production block, so these tests cannot drive a live document.
const ports = vi.hoisted(() => [] as number[]);
vi.mock("~/commercial/plugin-bridge/ports.js", () => ({ WS_PORT_BLOCK: ports }));

type Frame = Record<string, unknown>;
let dir: string;
let file: string;
let stdout: string;
let sockets: WebSocket[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flcm-execute-"));
  file = join(dir, "workflow.js");
  await writeFile(file, "console.log('saved workflow'); return { answer: 42 };");
  await writeFile(join(dir, ".env"), "");
  vi.stubEnv("FRAMELINK_STATE_DIR", join(dir, "state"));
  vi.stubEnv("FRAMELINK_API_URL", "http://127.0.0.1:9");
  stdout = "";
  sockets = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  ports.splice(0, ports.length, address.port);
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
});

afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

function run(flags: Parameters<typeof runExecute>[0] = {}) {
  return runExecute({ env: join(dir, ".env"), wait: 2, ...flags }, [file]);
}

async function plugin(handle: (frame: Frame, socket: WebSocket) => void, approval = true) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const socket = new WebSocket(`ws://127.0.0.1:${ports[0]}`, { origin: "null" });
    sockets.push(socket);
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.on("message", (data) => {
      const frame: Frame = JSON.parse(data.toString());
      if (frame.type === "GET_VERSION") {
        socket.send(
          JSON.stringify({
            id: frame.id,
            protocolVersion: MIN_PROTOCOL_VERSION,
            pluginVersion: "test",
          }),
        );
      } else if (frame.type === "PING" || frame.type === "SESSION_INFO") {
        socket.send(JSON.stringify({ id: frame.id }));
      }
      if (frame.type === "SESSION_INFO" && approval)
        socket.send(
          JSON.stringify({
            type: "SESSION_TOKEN",
            sessionToken: "test-token",
            authorizingUser: { figmaUserId: "cli-test-user", name: "Test User" },
          }),
        );
      if (frame.type === "APPROVAL_STATUS" && approval)
        reply(socket, frame, { type: "APPROVAL_GRANTED" });
      handle(frame, socket);
    });
    const opened = await new Promise<boolean>((resolve) => {
      socket.once("open", () => resolve(true));
      socket.once("error", () => resolve(false));
    });
    if (opened) return { socket, closed };
    await delay(10);
  }
  throw new Error("CLI relay did not bind its test port");
}

function reply(socket: WebSocket, frame: Frame, value: Frame) {
  socket.send(
    JSON.stringify({
      id: frame.id,
      ...(frame.type === "EXECUTE_CODE" ? { documentChanged: true } : {}),
      ...value,
    }),
  );
}

describe("saved-script CLI using production plugin services", () => {
  it("checks approval, ships the real runtime, serves local images, saves JSON/PNG, and closes", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    );
    await writeFile(join(dir, "asset.png"), png);
    const output = join(dir, "artifacts", "result.json");
    const screenshot = join(dir, "artifacts", "card.png");
    const finished = run({ output, screenshot, key: "card", scale: 2, assetRoot: dir });
    let attempts = 0;
    let execution: Frame | undefined;
    let imageReply: Frame | undefined;
    let screenshotRequest: Frame | undefined;
    let session: Frame | undefined;
    const { closed } = await plugin((frame, socket) => {
      if (frame.type === "SESSION_INFO") session = frame;
      if (frame.type === "EXECUTE_CODE") {
        attempts++;
        {
          execution = frame;
          socket.send(
            JSON.stringify({
              type: "CHANNEL_REQUEST",
              id: "image-1",
              runId: frame.id,
              capability: "images.fetch",
              payload: ["./asset.png"],
            }),
          );
        }
      }
      if (frame.type === "CHANNEL_RESPONSE") {
        imageReply = frame;
        if (execution)
          reply(socket, execution, {
            result: { answer: 42 },
            console: ["saved workflow"],
            errors: null,
          });
      }
      if (frame.type === "SCREENSHOT") {
        screenshotRequest = frame;
        reply(socket, frame, { image: png.toString("base64") });
      }
    });
    expect(await finished).toBe(0);
    await closed;
    expect(attempts).toBe(1);
    expect(execution?.code).toBe(await readFile(file, "utf8"));
    expect(execution?.preamble).toContain("(function (__flcmHost) {");
    expect(session).toMatchObject({
      identity: process.cwd(),
      pairingCode: expect.stringMatching(/^\d{4}$/),
    });
    expect(imageReply).toMatchObject({
      type: "CHANNEL_RESPONSE",
      ok: true,
      payload: { "./asset.png": png.toString("base64") },
    });
    expect(screenshotRequest).toMatchObject({ key: "card", scale: 2 });
    expect(JSON.parse(stdout)).toEqual({
      result: { answer: 42 },
      console: ["saved workflow"],
      errors: null,
    });
    expect(await readFile(output, "utf8")).toBe(stdout);
    expect(await readFile(screenshot)).toEqual(png);
  });

  it("returns failure status while preserving script errors and a screenshot of partial work", async () => {
    const screenshot = join(dir, "partial.png");
    const finished = run({ screenshot });
    const { closed } = await plugin((frame, socket) => {
      if (frame.type === "EXECUTE_CODE")
        reply(socket, frame, { console: ["before throw"], errors: "boom" });
      if (frame.type === "SCREENSHOT") reply(socket, frame, { image: "cG5n" });
    });
    expect(await finished).toBe(1);
    await closed;
    expect(JSON.parse(stdout)).toEqual({ console: ["before throw"], errors: "boom" });
    expect(await readFile(screenshot, "utf8")).toBe("png");
  });

  it("rejects a malformed execution reply without saving a success artifact or replaying", async () => {
    const finished = expect(run()).rejects.toThrow();
    let attempts = 0;
    const { closed } = await plugin((frame, socket) => {
      if (frame.type === "EXECUTE_CODE") {
        attempts++;
        reply(socket, frame, { result: "missing console/errors" });
      }
    });
    await finished;
    await closed;
    expect(attempts).toBe(1);
    expect(stdout).toBe("");
  });

  it("keeps execution JSON when screenshot fails and rejects the command", async () => {
    const finished = expect(run({ screenshot: join(dir, "missing.png") })).rejects.toThrow(
      "Screenshot failed: unknown key",
    );
    const { closed } = await plugin((frame, socket) => {
      if (frame.type === "EXECUTE_CODE")
        reply(socket, frame, { result: 42, console: [], errors: null });
      if (frame.type === "SCREENSHOT") reply(socket, frame, { errors: "unknown key" });
    });
    await finished;
    await closed;
    expect(JSON.parse(stdout).result).toBe(42);
  });

  it("rejects a mid-run disconnect without replaying the saved script", async () => {
    const finished = expect(run()).rejects.toThrow("disconnected");
    let attempts = 0;
    const { closed } = await plugin((frame, socket) => {
      if (frame.type === "EXECUTE_CODE") {
        attempts++;
        socket.close();
      }
    });
    await finished;
    await closed;
    expect(attempts).toBe(1);
    expect(stdout).toBe("");
  });

  it("reports approval timeout without fabricating an execution reply", async () => {
    const finished = expect(run({ wait: 1 })).rejects.toThrow(
      /did not run. Blocked: session approval is pending, and this run's session has ended/,
    );
    const { closed } = await plugin((frame, socket) => {
      if (frame.type === "APPROVAL_STATUS") reply(socket, frame, { type: "PENDING_APPROVAL" });
    }, false);
    await finished;
    await closed;
    expect(stdout).toBe("");
  });

  it.each([
    { args: ["--scale", "40"], error: "Screenshot scale 40" },
    { args: ["--node_id", "1:2"], error: "Unknown flag" },
  ])("rejects invalid CLI flags before starting a relay: $args", async ({ args, error }) => {
    await expect(
      promisify(execFile)(
        process.execPath,
        [
          "--import",
          "tsx",
          "src/bin.ts",
          "execute",
          file,
          "--screenshot",
          join(dir, "invalid.png"),
          ...args,
        ],
        { env: { ...process.env, NODE_ENV: "test" } },
      ),
    ).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringContaining(error),
    });
  });

  it("fails on connection timeout and removes its signal handlers", async () => {
    const before = process.listenerCount("SIGINT");
    await expect(run({ wait: 0 })).rejects.toThrow("Blocked: no Figma plugin connected");
    expect(process.listenerCount("SIGINT")).toBe(before);
    expect(stdout).toBe("");
  });

  it("rejects invalid screenshot options before connecting or running a script", async () => {
    await expect(
      run({ screenshot: join(dir, "bad.png"), key: "card", nodeId: "1:2" }),
    ).rejects.toThrow("ambiguous");
    await expect(run({ screenshot: join(dir, "bad.png"), scale: 40 })).rejects.toThrow("40");
    await expect(runExecute({}, [join(dir, "workflow.ts")])).rejects.toThrow(".js");
    expect(stdout).toBe("");
  });
});

describe("one-shot bridge lifecycle", () => {
  it("stop rejects pending requests immediately and closes the plugin socket", async () => {
    const bridge = new PluginBridge();
    try {
      const request = new Promise((resolve, reject) => {
        bridge.start(ports, () => {
          bridge
            .request({ type: "EXECUTE_CODE", code: "return 1", preamble: "test runtime" })
            .then(resolve, reject);
        });
      });
      const finished = expect(request).rejects.toThrow("Bridge stopped");
      const { closed } = await plugin((frame) => {
        if (frame.type === "EXECUTE_CODE") bridge.stop();
      });
      await finished;
      await closed;
      expect(bridge.isPluginConnected()).toBe(false);
    } finally {
      bridge.stop();
    }
  }, 2000);
});

it("CLI cannot execute without an Authorizing User even when approval status claims granted", async () => {
  const finished = expect(run()).rejects.toThrow("which Figma user approved");
  let executions = 0;
  const { closed } = await plugin((frame, socket) => {
    if (frame.type === "APPROVAL_STATUS") reply(socket, frame, { type: "APPROVAL_GRANTED" });
    if (frame.type === "EXECUTE_CODE") executions++;
  }, false);
  await finished;
  await closed;
  expect(executions).toBe(0);
});

it("caller signal cancels the submitted run and returns conventional exit status without replay", async () => {
  const finished = run();
  let executions = 0;
  let cancelled = false;
  const { closed } = await plugin((frame) => {
    if (frame.type === "EXECUTE_CODE") {
      executions++;
      process.emit("SIGINT");
    }
    if (frame.type === "CANCEL") cancelled = true;
  });
  expect(await finished).toBe(130);
  await closed;
  expect(executions).toBe(1);
  expect(cancelled).toBe(true);
});

it("CLI refuses an exhausted free allowance before sending any execution", async () => {
  const store = new WriteAccessStore();
  store.update((state) => ({
    ...state,
    ledger: {
      "cli-test-user": {
        executions: Array.from({ length: FREE_WRITE_ALLOWANCE }, (_, i) => ({
          executionId: String(i),
          at: new Date().toISOString(),
          reported: false,
        })),
        serverReported: null,
      },
    },
  }));
  const finished = expect(run()).rejects.toThrow(/allowance|Writes/);
  let executions = 0;
  const { closed } = await plugin((frame) => {
    if (frame.type === "EXECUTE_CODE") executions++;
  });
  await finished;
  await closed;
  expect(executions).toBe(0);
  expect(writesUsedThisMonth(store.read().ledger, "cli-test-user", new Date())).toBe(
    FREE_WRITE_ALLOWANCE,
  );
});

it("CLI records partial writes on script failure", async () => {
  const store = new WriteAccessStore();
  const finished = run();
  const { closed } = await plugin((frame, socket) => {
    if (frame.type === "EXECUTE_CODE")
      reply(socket, frame, { console: [], errors: "partial write failure", documentChanged: true });
  });
  expect(await finished).toBe(1);
  await closed;
  expect(writesUsedThisMonth(store.read().ledger, "cli-test-user", new Date())).toBe(1);
});

it("delivers JSON before settlement and charges a late document change before closing", async () => {
  let done = false;
  const finished = run().then((result) => {
    done = true;
    return result;
  });
  let runId: unknown;
  const { socket, closed } = await plugin((frame, socket) => {
    if (frame.type === "EXECUTE_CODE") {
      runId = frame.id;
      reply(socket, frame, { console: [], errors: null, result: "read", documentChanged: false });
    }
  });
  for (let i = 0; i < 100 && !stdout; i++) await delay(5);
  expect(JSON.parse(stdout).result).toBe("read");
  expect(done).toBe(false);
  socket.send(JSON.stringify({ type: "RUN_CHANGED", runId }));
  expect(await finished).toBe(0);
  await closed;
  expect(
    writesUsedThisMonth(new WriteAccessStore().read().ledger, "cli-test-user", new Date()),
  ).toBe(1);
});

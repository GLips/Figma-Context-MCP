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
import { realpathSync } from "node:fs";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { runExecute } from "~/commercial/commands/execute.js";
import { WriteAccessStore } from "~/commercial/entitlement/write-access-store.js";
import {
  FREE_WRITE_ALLOWANCE,
  writesUsedThisMonth,
} from "~/commercial/entitlement/write-ledger.js";
import { PluginBridge } from "~/commercial/plugin-bridge/bridge.js";
import { SESSION_HANDLE_PATTERN, type DocumentReport } from "@framelink/plugin/protocol";
import { answerLinkSetup } from "./fixtures/plugin-link-peer.js";
import { TEST_DOCUMENT, TEST_SESSION_REQUEST } from "./fixtures/write-access.js";
import { mintExecutionId } from "~/commercial/execution-id.js";

// Exercise production startup/handshake/images/execution on an ephemeral test port.
// Figma only scans its fixed production block, so these tests cannot drive a live document.
const ports = vi.hoisted(() => [] as number[]);
vi.mock("@framelink/plugin/protocol", async (actual) => ({
  ...(await actual<typeof import("@framelink/plugin/protocol")>()),
  WS_PORT_BLOCK: ports,
}));

type Frame = Record<string, unknown>;
let dir: string;
let file: string;
let stdout: string;
let sockets: WebSocket[];
// The Figma file the test plugins are open in, as they report it.
const FIGMA_FILE = { documentId: "c11d0c0000000001", fileName: "CLI file", fileKey: "CLIfile1" };
const FIGMA_FILE_REPORT: DocumentReport = {
  kind: "identified",
  ...FIGMA_FILE,
  pageNames: ["Page 1"],
};
let figmaCalls: Array<{ url: string; token: string | null }>;
const COMMENT = {
  id: "c1",
  message: "Tighten this",
  client_meta: { node_id: "1:2", node_offset: { x: 4, y: 8 } },
  resolved_at: null,
  created_at: "2026-01-01T00:00:00Z",
  user: { handle: "Reviewer" },
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flcm-execute-"));
  file = join(dir, "workflow.js");
  await writeFile(file, "console.log('saved workflow'); return { answer: 42 };");
  await writeFile(join(dir, ".env"), "");
  vi.stubEnv("FRAMELINK_STATE_DIR", join(dir, "state"));
  vi.stubEnv("FRAMELINK_API_URL", "http://127.0.0.1:9");
  stdout = "";
  sockets = [];
  figmaCalls = [];
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://api.figma.com/")) return realFetch(input, init);
    figmaCalls.push({ url, token: new Headers(init?.headers).get("X-Figma-Token") });
    if (url.includes(`/v1/files/${FIGMA_FILE.fileKey}/comments`))
      return Promise.resolve(Response.json({ comments: [COMMENT] }));
    return Promise.resolve(Response.json({ err: "Not found" }, { status: 404 }));
  });
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
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

function run(flags: Parameters<typeof runExecute>[0] = {}) {
  return runExecute(
    {
      env: join(dir, ".env"),
      wait: 2,
      figmaApiKey: "figd_cli_test",
      intent: "Test run",
      document: FIGMA_FILE.documentId,
      ...flags,
    },
    [file],
  );
}

const CLI_TEST_OWNER = { figmaUserId: "cli-test-user", name: "Test User" };

/** A plugin open in `document` (FIGMA_FILE by default) that answers every grant poll with `grant`. */
async function plugin(
  handle: (frame: Frame, socket: WebSocket) => void,
  {
    grant = "granted",
    owner = CLI_TEST_OWNER as typeof CLI_TEST_OWNER | null,
    paired = true,
    document = FIGMA_FILE_REPORT,
  }: {
    grant?: string;
    owner?: typeof CLI_TEST_OWNER | null;
    paired?: boolean;
    document?: DocumentReport;
  } = {},
) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const socket = new WebSocket(`ws://127.0.0.1:${ports[0]}`, { origin: "null" });
    sockets.push(socket);
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.on("message", (data) => {
      const frame: Frame = JSON.parse(data.toString());
      const answer = (value: Frame) => socket.send(JSON.stringify({ id: frame.id, ...value }));
      answerLinkSetup((value) => socket.send(JSON.stringify(value)), frame, {
        owner,
        paired,
        document,
      });
      if (frame.type === "GRANT_STATUS") answer({ type: "GRANT", state: grant });
      if (frame.type === "GRANT_PROMPT_CLOSED") answer({ type: "GRANT_PROMPT_CLOSED_ACK" });
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

// The reply type a request is owed; `value` may override it.
const REPLY_TYPE: Record<string, Frame> = {
  EXECUTE_CODE: { type: "EXECUTE_CODE_RESULT", documentChanged: true },
  SCREENSHOT: { type: "SCREENSHOT_RESULT" },
};
function reply(socket: WebSocket, frame: Frame, value: Frame) {
  socket.send(JSON.stringify({ id: frame.id, ...REPLY_TYPE[String(frame.type)], ...value }));
}

describe("saved-script CLI using production plugin services", () => {
  it("binds the named document without a REST call, ships the real runtime, serves local images, saves JSON/PNG, and closes", async () => {
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
    let introduction: Frame | undefined;
    const { closed } = await plugin((frame, socket) => {
      if (frame.type === "INTRODUCE") introduction = frame;
      if (frame.type === "EXECUTE_CODE") {
        attempts++;
        {
          execution = frame;
          socket.send(
            JSON.stringify({
              type: "CHANNEL_REQUEST",
              id: "image-1",
              executionId: frame.id,
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
    expect(introduction).toMatchObject({ project: realpathSync(process.cwd()) });
    expect(execution?.documentId).toBe(FIGMA_FILE.documentId);
    // The plugin's stamp names the file: nothing is read from Figma to identify it.
    expect(figmaCalls).toEqual([]);
    expect(imageReply).toMatchObject({
      type: "CHANNEL_RESPONSE",
      ok: true,
      payload: { "./asset.png": png.toString("base64") },
    });
    expect(screenshotRequest).toMatchObject({
      key: "card",
      scale: 2,
      documentId: FIGMA_FILE.documentId,
    });
    // The screenshot is its own execution, never the script's id reused.
    expect(screenshotRequest?.id).not.toBe(execution?.id);
    expect(execution?.session).toEqual({ handle: expect.any(String), create: true });
    expect(JSON.parse(stdout)).toEqual({
      file: FIGMA_FILE,
      session: (execution?.session as { handle: string }).handle,
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
    expect(JSON.parse(stdout)).toEqual({
      file: FIGMA_FILE,
      session: expect.stringMatching(SESSION_HANDLE_PATTERN),
      console: ["before throw"],
      errors: "boom",
    });
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

  it("waits for Allow, and a run whose wait ran out sends nothing and says who must allow", async () => {
    const executions: Frame[] = [];
    const expired = expect(run({ wait: 1 })).rejects.toThrow(
      /Blocked: this project isn't allowed to edit "CLI file" yet, so the script did not run. Required before re-running: someone clicks Allow/,
    );
    const first = await plugin(
      (frame) => {
        if (frame.type === "EXECUTE_CODE") executions.push(frame);
      },
      { grant: "pending" },
    );
    await expired;
    await first.closed;
    expect(stdout).toBe("");
    expect(executions).toHaveLength(0);
    // Nothing was stored server-side: the next run asks the plugin again, which now holds the grant.
    const next = run({ wait: 2 });
    const second = await plugin((frame, socket) => {
      if (frame.type === "EXECUTE_CODE") {
        executions.push(frame);
        reply(socket, frame, { result: { answer: 42 }, console: [], errors: null });
      }
    });
    await expect(next).resolves.toBe(0);
    await second.closed;
    expect(executions).toHaveLength(1);
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

  it("reads the run's own file's comment pins over REST with the CLI's Figma token", async () => {
    const finished = run();
    let pinsReply: Frame | undefined;
    let execution: Frame | undefined;
    await plugin((frame, socket) => {
      if (frame.type === "EXECUTE_CODE") {
        execution = frame;
        socket.send(
          JSON.stringify({
            type: "CHANNEL_REQUEST",
            id: "pins-1",
            executionId: frame.id,
            capability: "comments.pins",
            payload: {},
          }),
        );
      }
      if (frame.type === "CHANNEL_RESPONSE") {
        pinsReply = frame;
        reply(socket, execution!, { result: null, console: [], errors: null });
      }
    });
    expect(await finished).toBe(0);
    expect(figmaCalls).toContainEqual({
      url: expect.stringContaining(`/v1/files/${FIGMA_FILE.fileKey}/comments`),
      token: "figd_cli_test",
    });
    expect(pinsReply).toMatchObject({
      ok: true,
      payload: { pins: [{ nodeId: "1:2", x: 4, y: 8 }] },
    });
  });

  it("an untargeted run is refused with the open files to choose from, and prompts no panel", async () => {
    const finished = expect(run({ document: undefined })).rejects.toThrow(
      new RegExp(`"CLI file": document ${FIGMA_FILE.documentId}.*\\n.*--document`),
    );
    const prompts: unknown[] = [];
    const { closed } = await plugin(
      (frame) => {
        if (frame.type === "GRANT_STATUS") prompts.push(frame.prompt);
      },
      { grant: "absent" },
    );
    await finished;
    await closed;
    expect(new Set(prompts)).toEqual(new Set(["none"]));
  });

  it("a plugin that reports no file key gets no comment pins, quietly, and no REST call", async () => {
    const finished = run();
    let pinsReply: Frame | undefined;
    let execution: Frame | undefined;
    await plugin(
      (frame, socket) => {
        if (frame.type === "EXECUTE_CODE") {
          execution = frame;
          socket.send(
            JSON.stringify({
              type: "CHANNEL_REQUEST",
              id: "pins-1",
              executionId: frame.id,
              capability: "comments.pins",
              payload: {},
            }),
          );
        }
        if (frame.type === "CHANNEL_RESPONSE") {
          pinsReply = frame;
          reply(socket, execution!, { result: null, console: [], errors: null });
        }
      },
      { document: { ...FIGMA_FILE_REPORT, fileKey: undefined } },
    );
    expect(await finished).toBe(0);
    expect(pinsReply).toMatchObject({ ok: false, error: { code: "FILE_KEY_UNAVAILABLE" } });
    expect(figmaCalls).toEqual([]);
  });

  it("rejects a missing or multi-line intent before connecting or running a script", async () => {
    await expect(run({ intent: undefined })).rejects.toThrow("--intent is required");
    await expect(run({ intent: "Build\nthe card" })).rejects.toThrow("line break");
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
            .resolveLink()
            .then((resolution) => {
              if (resolution.kind !== "linked") throw new Error(`plugin ${resolution.kind}`);
              return bridge.submitRun(
                resolution.links[0],
                {
                  type: "EXECUTE_CODE",
                  intent: "Test run",
                  session: TEST_SESSION_REQUEST,
                  documentId: TEST_DOCUMENT.documentId,
                  code: "return 1",
                  preamble: "test runtime",
                  lateChangeWindowMs: 60_000,
                },
                mintExecutionId(),
              );
            })
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

it("CLI sends nothing to an unpaired plugin and points at the pair command", async () => {
  const finished = expect(run()).rejects.toThrow("npx figma-developer-mcp pair");
  const frames: string[] = [];
  const { closed } = await plugin((frame) => void frames.push(String(frame.type)), {
    paired: false,
  });
  await finished;
  await closed;
  expect(new Set(frames)).toEqual(new Set(["HELLO", "AUTHENTICATE"]));
});

it("CLI cannot execute without a plugin owner even when the plugin claims a grant", async () => {
  const finished = expect(run()).rejects.toThrow("which Figma user it is signed in as");
  let executions = 0;
  const { closed } = await plugin(
    (frame) => {
      if (frame.type === "EXECUTE_CODE") executions++;
    },
    { owner: null },
  );
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
  let executionId: unknown;
  const { socket, closed } = await plugin((frame, socket) => {
    if (frame.type === "EXECUTE_CODE") {
      executionId = frame.id;
      reply(socket, frame, { console: [], errors: null, result: "read", documentChanged: false });
    }
  });
  for (let i = 0; i < 100 && !stdout; i++) await delay(5);
  expect(JSON.parse(stdout).result).toBe("read");
  expect(done).toBe(false);
  socket.send(JSON.stringify({ type: "RUN_CHANGED", executionId }));
  expect(await finished).toBe(0);
  await closed;
  expect(
    writesUsedThisMonth(new WriteAccessStore().read().ledger, "cli-test-user", new Date()),
  ).toBe(1);
});

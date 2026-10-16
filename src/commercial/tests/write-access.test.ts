/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Write authorization against a fake Framelink app speaking the real HTTP contract (usage reports,
// entitlement checks, the device sign-in), with state in a temp dir. Each test pins a rule from
// licensing/LICENSE-Framelink-Commercial.md "Limit of the grant" that would otherwise regress silently: the refusal before an over-allowance
// execution starts, what counts as a Write, and when a seat does — and does not — end.
import { chmodSync } from "node:fs";
import { codeModeExtension } from "~/commercial/tools/code-mode-tools.js";
import { createServer, type Server } from "node:http";
import { dirname } from "node:path";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer as createMcpServer } from "~/mcp/index.js";
import {
  PluginBridge,
  type LinkRequest,
  type PluginLink,
  type RunRequest,
} from "~/commercial/plugin-bridge/bridge.js";
import { mintExecutionId } from "~/commercial/plugin-bridge/execution-id.js";
import type { PluginBridgeRuntime } from "~/commercial/plugin-bridge/index.js";
import type { WriteAccess } from "~/commercial/entitlement/write-access.js";
import type { WriteMeter } from "~/commercial/entitlement/write-meter.js";
import type { PluginReply, ReplyFor, WriteAccessNotice } from "@framelink/plugin/protocol";
import { FREE_WRITE_ALLOWANCE } from "~/commercial/entitlement/write-ledger.js";
import {
  createTestWriteAccess,
  linkedTestResolution,
  targetedTestCall,
  TEST_PLUGIN_LINK,
  TEST_PLUGIN_OWNER,
} from "./fixtures/write-access.js";

/** The app's write endpoints, faithful to the contract, with knobs for what the test needs it to say. */
async function startFakeFramelinkApp() {
  const app = {
    down: false,
    seat: true,
    revoked: false,
    // Writes the Plugin Owner made on other devices, which only the server knows about.
    otherDeviceWrites: 0,
    reportedExecutionIds: [] as string[],
    tokenPolls: 0,
    // What the next completed device sign-in hands out; only tok-1 passes the entitlement check.
    issuedToken: "tok-1",
  };
  const recorded = new Set<string>();
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (app.down) return json(503, { error: "unavailable" });
      const body = raw ? JSON.parse(raw) : {};
      if (req.url === "/api/write/usage") {
        for (const { executionId } of body.executions) {
          app.reportedExecutionIds.push(executionId);
          recorded.add(executionId); // idempotent on executionId, like the app
        }
        const now = new Date();
        return json(200, {
          figmaUserId: body.figmaUserId,
          usedThisMonth: recorded.size + app.otherDeviceWrites,
          resetsAt: new Date(
            Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
          ).toISOString(),
        });
      }
      if (req.url === "/api/write/entitlement") {
        if (app.revoked || req.headers.authorization !== "Bearer tok-1")
          return json(401, { error: "invalid_token" });
        return json(200, {
          figmaUserId: TEST_PLUGIN_OWNER.figmaUserId,
          seat: app.seat,
          validatedAt: new Date().toISOString(),
        });
      }
      if (req.url === "/api/auth/device/code")
        return json(200, {
          device_code: "device-1",
          user_code: "ABCD-EFGH",
          verification_uri: `${baseUrl}/device`,
          verification_uri_complete: `${baseUrl}/device?user_code=ABCD-EFGH`,
          expires_in: 60,
          interval: 0,
        });
      if (req.url === "/api/auth/device/token") {
        app.tokenPolls++;
        if (app.tokenPolls === 1) return json(400, { error: "authorization_pending" });
        return json(200, { access_token: app.issuedToken, token_type: "Bearer", expires_in: 3600 });
      }
      json(404, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    app,
    baseUrl,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup() {
  const fake = await startFakeFramelinkApp();
  cleanups.push(fake.close);
  const notices: WriteAccessNotice[] = [];
  // The panel is the other reader of every refusal; capture what its owner would be shown.
  const access = createTestWriteAccess({
    apiUrl: fake.baseUrl,
    notifyPanel: (figmaUserId, notice) => {
      expect(figmaUserId).toBe(TEST_PLUGIN_OWNER.figmaUserId);
      notices.push(notice);
    },
  });
  return { ...fake, ...access, notices };
}

const USER_ID = TEST_PLUGIN_OWNER.figmaUserId;

/** What the gate would say to a new execution now. Hands back the reservation it takes. */
async function gateAnswer(writeMeter: WriteMeter) {
  const admission = await writeMeter.authorize(TEST_PLUGIN_LINK, mintExecutionId());
  if (admission.kind === "refused") return admission.refusal;
  admission.charge.lost({ mayHaveRun: false });
  return admission.authorization;
}

function spendAllowance(writeAccess: WriteAccess, count: number): void {
  for (let i = 0; i < count; i++) writeAccess.recordWrite(USER_ID, randomUUID());
}

// A plugin granted on the test document, whose executions report the document-changed answers queued here.
class MeteredBridge extends PluginBridge {
  documentChanged: boolean[] = [];
  executions = 0;
  override resolveLink() {
    return linkedTestResolution();
  }
  override targetCall() {
    return targetedTestCall();
  }
  override async request<T extends Exclude<LinkRequest, RunRequest>>(
    _link: PluginLink,
    payload: T,
  ): Promise<ReplyFor<T["type"]>> {
    if (payload.type !== "GRANT_PROMPT_CLOSED") throw new Error(`unexpected ${payload.type}`);
    return { type: "GRANT_PROMPT_CLOSED_ACK" } as ReplyFor<T["type"]>;
  }
  override async submitRun<T extends RunRequest>(): Promise<ReplyFor<T["type"]>> {
    this.executions++;
    const reply: PluginReply = {
      type: "EXECUTE_CODE_RESULT",
      result: "ok",
      console: [],
      errors: null,
      documentChanged: this.documentChanged.shift()!,
    };
    return reply as ReplyFor<T["type"]>;
  }
}

async function connectTools(writeMeter: WriteMeter) {
  const bridge = new MeteredBridge();
  const runtime: PluginBridgeRuntime = {
    bridge,
    writeMeter,
    readSavedScript: () => Promise.reject(new Error("no saved scripts in this test")),
    readLocalImage: () => Promise.reject(new Error("no local images in this test")),
    pluginPresence: () => "connected",
    onFirstConnect: () => {},
  };
  const server = createMcpServer(
    { credential: { kind: "pat", token: "test" }, imageDir: process.cwd(), plugin: runtime },
    { transport: "stdio", extensions: [codeModeExtension(runtime, { codeMode: false })] },
  );
  const client = new Client({ name: "write-access-test", version: "1" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(c), server.connect(s)]);
  cleanups.push(() => Promise.all([client.close(), server.close()]));
  const execute = (documentChanged: boolean) => {
    bridge.documentChanged.push(documentChanged);
    return client.request(
      { method: "tools/call", params: { name: "figma_execute_code", arguments: { code: "x" } } },
      CallToolResultSchema,
    );
  };
  return { bridge, execute };
}

describe("write authorization", () => {
  it("counts only executions that change the document, and refuses to start one past the allowance", async () => {
    const { writeAccess, notices, writeMeter } = await setup();
    const { bridge, execute } = await connectTools(writeMeter);
    spendAllowance(writeAccess, FREE_WRITE_ALLOWANCE - 1);

    // Read-only: runs, and spends nothing — so the next mutating one still fits.
    expect((await execute(false)).isError).toBeFalsy();
    const last = await execute(true);
    expect(last.isError).toBeFalsy();
    expect(JSON.stringify(last.content)).not.toContain("documentChanged");

    const refused = await execute(true);
    expect(refused.isError).toBe(true);
    const text = (refused.content[0] as { text: string }).text;
    expect(text).toContain("nothing ran");
    expect(text).toContain("Sign in to Framelink");
    // Refused before it started: the plugin never saw the third execution.
    expect(bridge.executions).toBe(2);
    expect(notices.at(-1)).toMatchObject({ kind: "allowance-exhausted", signedIn: false });
  });

  it("counts an execution id once, and adds Writes not yet reported to the server's all-device count", async () => {
    const { app, writeAccess, writeMeter } = await setup();
    const executionId = randomUUID();
    writeAccess.recordWrite(USER_ID, executionId);
    writeAccess.recordWrite(USER_ID, executionId);
    expect(await gateAnswer(writeMeter)).toMatchObject({
      kind: "authorized",
      usedThisMonth: 1,
    });

    app.otherDeviceWrites = FREE_WRITE_ALLOWANCE - 2;
    await writeAccess.reportWriteUsage(TEST_PLUGIN_OWNER.figmaUserId);
    expect(app.reportedExecutionIds).toEqual([executionId]);
    // During an outage the server's count can't grow, so the Writes it hasn't seen add to it.
    app.down = true;
    writeAccess.recordWrite(USER_ID, randomUUID());
    expect(await gateAnswer(writeMeter)).toMatchObject({
      kind: "refused",
      reason: "allowance-exhausted",
    });
  });

  it("keeps a validated seat writing through an outage and through a rejected re-sign-in", async () => {
    const { app, writeAccess, notices, store, writeMeter, signIn } = await setup();
    await signIn.start(TEST_PLUGIN_OWNER);
    expect(notices).toEqual([
      {
        kind: "sign-in-pending",
        userCode: "ABCD-EFGH",
        verificationUri: expect.stringContaining("user_code=ABCD-EFGH"),
      },
      { kind: "signed-in", seat: true },
    ]);
    spendAllowance(writeAccess, FREE_WRITE_ALLOWANCE);

    // Signing in again with a token Framelink turns down leaves the validated seat as it was.
    app.issuedToken = "tok-rejected";
    await signIn.start(TEST_PLUGIN_OWNER);
    expect(notices.at(-1)).toMatchObject({ kind: "sign-in-failed" });
    expect(store.read().seats[USER_ID]).toMatchObject({ token: "tok-1", seat: true });

    app.down = true;
    await writeAccess.syncWriteAccess(TEST_PLUGIN_OWNER, { force: true });
    expect(await gateAnswer(writeMeter)).toEqual({
      kind: "authorized",
      via: "seat",
      figmaUserId: TEST_PLUGIN_OWNER.figmaUserId,
    });
  });

  it("counts executions still in flight, and Writes the state file couldn't save", async () => {
    const { app, writeAccess, store, writeMeter } = await setup();
    spendAllowance(writeAccess, FREE_WRITE_ALLOWANCE - 2);
    // Three parallel calls for the last two Writes: the third must not start.
    const writesId = mintExecutionId();
    const [readOnly, writes, oneTooMany] = await Promise.all(
      [mintExecutionId(), writesId, mintExecutionId()].map((id) =>
        writeMeter.authorize(TEST_PLUGIN_LINK, id),
      ),
    );
    expect([readOnly, writes, oneTooMany].map((d) => d.kind)).toEqual([
      "authorized",
      "authorized",
      "refused",
    ]);
    if (readOnly.kind !== "authorized" || writes.kind !== "authorized")
      throw new Error("unreachable");
    readOnly.charge.replied(false);

    // The state dir stops taking writes just as a Write lands: it still counts, and still reports.
    const stateDir = dirname(store.file);
    chmodSync(stateDir, 0o500);
    cleanups.push(async () => chmodSync(stateDir, 0o700));
    writes.charge.replied(true);
    expect(await gateAnswer(writeMeter)).toMatchObject({
      kind: "authorized",
      usedThisMonth: FREE_WRITE_ALLOWANCE - 1,
    });
    chmodSync(stateDir, 0o700);
    await writeAccess.reportWriteUsage(USER_ID);
    expect(app.reportedExecutionIds).toContain(writesId);
    expect(store.read().ledger[USER_ID]?.executions.map((e) => e.executionId)).toContain(writesId);
  });

  it("charges an execution once, however many times and ways it is settled", async () => {
    const { app, writeAccess, writeMeter } = await setup();
    spendAllowance(writeAccess, FREE_WRITE_ALLOWANCE - 2);
    const executionId = mintExecutionId();
    const admission = await writeMeter.authorize(TEST_PLUGIN_LINK, executionId);
    if (admission.kind !== "authorized") throw new Error("a Write still fits the allowance");
    // The reply said "no change", then the plugin saw one — and said so twice, then its result
    // arrived again late, and the caller ended the charge a second time.
    admission.charge.replied(false);
    const link = TEST_PLUGIN_LINK;
    writeMeter.runEvent({ type: "changed", executionId, link });
    writeMeter.runEvent({ type: "changed", executionId, link });
    writeMeter.runEvent({
      type: "orphanReply",
      executionId,
      link,
      reply: { type: "EXECUTE_CODE_RESULT", console: [], errors: null, documentChanged: true },
    });
    admission.charge.lost({ mayHaveRun: true });
    writeMeter.runEvent({ type: "changed", executionId: mintExecutionId(), link });
    // One Write spent, so exactly one of the last two remains.
    expect(await gateAnswer(writeMeter)).toMatchObject({ kind: "authorized" });
    await writeAccess.reportWriteUsage(USER_ID);
    expect(app.reportedExecutionIds.filter((id) => id === executionId)).toHaveLength(1);
  });

  it("fails the call on an unreadable state file without erasing it, and decides without a writable one", async () => {
    const { store, writeMeter, signIn } = await setup();
    await signIn.start(TEST_PLUGIN_OWNER);
    chmodSync(store.file, 0o000);
    cleanups.push(async () => chmodSync(store.file, 0o600));
    await expect(gateAnswer(writeMeter)).rejects.toThrow(/EACCES/);
    chmodSync(store.file, 0o600);
    expect(store.read().seats[USER_ID]).toMatchObject({ token: "tok-1", seat: true });

    // A state dir that has never taken a file and can't: the gate still answers from an empty state.
    const fresh = createTestWriteAccess();
    const freshDir = dirname(fresh.store.file);
    chmodSync(freshDir, 0o500);
    cleanups.push(async () => chmodSync(freshDir, 0o700));
    expect(await gateAnswer(fresh.writeMeter)).toMatchObject({
      kind: "authorized",
      via: "allowance",
    });
  });

  it("ends the seat on seat:false, and drops the token on a 401", async () => {
    const { app, writeAccess, store, writeMeter, signIn } = await setup();
    await signIn.start(TEST_PLUGIN_OWNER);
    spendAllowance(writeAccess, FREE_WRITE_ALLOWANCE);

    app.seat = false;
    await writeAccess.validateSeat(TEST_PLUGIN_OWNER.figmaUserId);
    expect(await gateAnswer(writeMeter)).toMatchObject({
      kind: "refused",
      signedIn: true,
    });

    app.revoked = true;
    await writeAccess.validateSeat(TEST_PLUGIN_OWNER.figmaUserId);
    expect(store.read().seats[TEST_PLUGIN_OWNER.figmaUserId]).toBeUndefined();
    expect(await gateAnswer(writeMeter)).toMatchObject({
      kind: "refused",
      signedIn: false,
    });
  });
});

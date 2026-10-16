/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The wire contract, end to end: the production relay and the real plugin (ui.ts + code.ts, built
// from source) over a real socket. Every other bridge test talks to a stand-in, so this is the one
// place a change made on one side of plugin/src/protocol.ts alone fails.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { startPluginBridge, type PluginBridgeRuntime } from "~/commercial/plugin-bridge/index.js";
import {
  PluginBridge,
  type CallTarget,
  type CallTargetRequest,
  type DocumentReader,
  type PluginLink,
} from "~/commercial/plugin-bridge/bridge.js";
import {
  parseSessionHandle,
  type SessionHandle,
} from "~/commercial/plugin-bridge/session-handle.js";
import { LinkCredentialStore } from "~/commercial/plugin-bridge/link-credential.js";
import { executePluginCode, type ExecutionOutcome } from "~/commercial/plugin-bridge/execution.js";
import { runPair } from "~/commercial/commands/pair.js";
import { WriteAccessStore } from "~/commercial/entitlement/write-access-store.js";
import { writesUsedThisMonth } from "~/commercial/entitlement/write-ledger.js";
import {
  LoopbackFigma,
  startLoopbackPlugin,
  type LoopbackPlugin,
} from "./fixtures/loopback-plugin.js";
import { createTestWriteAccess } from "./fixtures/write-access.js";
import { figmaFileKey } from "~/utils/figma-url.js";

const ports = vi.hoisted(() => [] as number[]);
vi.mock("@framelink/plugin/protocol", async (actual) => ({
  ...(await actual<typeof import("@framelink/plugin/protocol")>()),
  WS_PORT_BLOCK: ports,
}));

let dir: string;
let figma: LoopbackFigma;
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
  figma = new LoopbackFigma();
  ports.splice(0, ports.length, await reservePort());
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

function startRuntime(): PluginBridgeRuntime {
  // Unroutable: write access works offline, from the free allowance.
  const runtime = startPluginBridge({
    assetRoot: dir,
    framelinkApiUrl: "http://127.0.0.1:9",
    figmaCredential: undefined,
  });
  cleanups.push(() => runtime.stop?.());
  return runtime;
}

function startPlugin(...args: Parameters<typeof startLoopbackPlugin>): LoopbackPlugin {
  const plugin = startLoopbackPlugin(...args);
  cleanups.push(() => plugin.close());
  return plugin;
}

/**
 * A bare relay for a project, reading the loopback files to prove links, with proofs quick enough
 * that a refuted one doesn't hold a test for the production deadline. Its links settle sooner too:
 * the loopback plugin redials a server it just lost within a second.
 */
function startBridge(
  stateDir: string,
  port: number,
  project = "/loopback/project",
  documentReader: DocumentReader | null = figma.reader,
): PluginBridge {
  const bridge = new PluginBridge({
    linkCredentials: new LinkCredentialStore(stateDir),
    project,
    documentReader,
    proofTiming: { pollMs: 20, deadlineMs: 400 },
    linkSettleMs: 3_000,
  });
  bridge.start([port]);
  cleanups.push(() => bridge.stop());
  return bridge;
}

/**
 * Bind a call the way the tools do, short-waited: to a file key, a session (and maybe a file key),
 * or nothing. `whilePrompted` runs when the plugin prompts, so a test can click; `prompted` says
 * whether it did.
 */
async function target(
  bridge: PluginBridge,
  named: string | null | { session: string; fileKey?: string },
  whilePrompted?: () => unknown,
  waitMs = 5_000,
): Promise<{ target: CallTarget; prompted: boolean }> {
  let prompted = false;
  const { session = null, fileKey = null } =
    typeof named === "object" && named !== null ? named : { fileKey: named };
  const request: CallTargetRequest = {
    fileKey: fileKey === null ? null : figmaFileKey(fileKey),
    session: session === null ? null : parseSessionHandle(session),
  };
  const target = await bridge.targetCall(request, {
    reader: figma.reader,
    signal: new AbortController().signal,
    waitMs,
    pollMs: 20,
    onWaiting: () => {
      prompted = true;
      void whilePrompted?.();
      return async () => {};
    },
  });
  return { target, prompted };
}

const NO_TARGET: CallTargetRequest = { fileKey: null, session: null };

/** Run code on a bound call, in the session it named (null: a fresh one), metered offline. */
function run(
  bridge: PluginBridge,
  bound: CallTarget,
  code: string,
  session: SessionHandle | null = null,
): Promise<ExecutionOutcome> {
  if (bound.kind !== "targeted") throw new Error(`not targeted: ${JSON.stringify(bound)}`);
  const { writeMeter } = createTestWriteAccess();
  return executePluginCode(
    { bridge, writeMeter, readLocalImage: () => Promise.reject(new Error("no images")) },
    { ...bound, session },
    code,
  );
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

it("pairs by the code the panel shows, proves the file, waits for Allow, then settles a clean run uncharged and charges a late change", async () => {
  const runtime = startRuntime();
  const plugin = startPlugin(ports[0], { file: figma.file("FILEkeyA", "Checkout") });
  const link = await pairByPanel(runtime.bridge, plugin);
  expect(link.owner).toEqual({ figmaUserId: "loopback-user", name: "Loopback Human" });
  const execute = async (code: string) => {
    // This server has no token of its own: the call's reader proves the file. Nothing proved it
    // before, so the panel asks for the file's link, then for the pick.
    const bound = await runtime.bridge.targetCall(NO_TARGET, {
      reader: figma.reader,
      signal: new AbortController().signal,
      pollMs: 20,
      onWaiting: () => {
        plugin.pasteLink("https://www.figma.com/design/FILEkeyA/Checkout?node-id=0-1");
        void plugin.allow();
        return async () => {};
      },
    });
    if (bound.kind !== "targeted") throw new Error(JSON.stringify(bound));
    expect(bound.document).toEqual({ fileKey: "FILEkeyA", fileName: "Checkout" });
    return executePluginCode(runtime, { ...bound, session: null }, code);
  };

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
  // The grant lives in the plugin alone: the server wrote no approval state.
  expect((await readdir(dir)).filter((name) => /approv|grant|session/i.test(name))).toEqual([]);
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

it("servers in one project share one grant from one click; a server in another project is asked", async () => {
  ports.push(await reservePort(), await reservePort());
  const first = startBridge(dir, ports[0], "/work/app");
  const sibling = startBridge(dir, ports[1], "/work/app");
  const elsewhere = startBridge(dir, ports[2], "/work/other");
  const plugin = startPlugin(ports, { file: figma.file("FILEkeyA", "Checkout") });
  await pairByPanel(first, plugin);
  for (const bridge of [sibling, elsewhere]) await settlesTo(bridge, "linked");

  const granted = await target(first, "FILEkeyA", () => plugin.allow());
  expect(granted.prompted).toBe(true);
  expect(await run(first, granted.target, "return 'first';")).toMatchObject({ kind: "executed" });

  // The plugin offers the file it was just proven in to the other servers, which prove it too.
  await expect
    .poll(() => sibling.authenticatedLinks().map((link) => sibling.documentOf(link).kind))
    .toEqual(["proven"]);
  const shared = await target(sibling, null);
  expect(shared.prompted).toBe(false);
  expect(await run(sibling, shared.target, "return 'sibling';")).toMatchObject({
    kind: "executed",
    reply: { result: "sibling" },
  });

  const other = await target(elsewhere, null, undefined, 300);
  expect(other.prompted).toBe(true);
  expect(other.target).toMatchObject({ kind: "blocked", block: { kind: "grant-pending" } });
});

it("a call without a file runs in the one granted file, and asks once two granted files are open", async () => {
  const bridge = startBridge(dir, ports[0]);
  const storage = new Map<string, unknown>();
  const checkout = startPlugin(ports[0], { storage, file: figma.file("FILEkeyA", "Checkout") });
  await pairByPanel(bridge, checkout);
  const settings = startPlugin(ports[0], { storage, file: figma.file("FILEkeyB", "Settings") });
  await expect.poll(() => bridge.authenticatedLinks().length, { timeout: 5_000 }).toBe(2);

  // Named: only that file's panel is asked.
  const named = await target(bridge, "FILEkeyA", async () => {
    await expect.poll(() => checkout.isPrompting()).toBe(true);
    expect(settings.isPrompting()).toBe(false);
    await checkout.allow();
  });
  expect(named.target).toMatchObject({ kind: "targeted", document: { fileName: "Checkout" } });

  const unnamed = await target(bridge, null);
  expect(unnamed.prompted).toBe(false);
  expect(unnamed.target).toMatchObject({ kind: "targeted", document: { fileKey: "FILEkeyA" } });

  await target(bridge, "FILEkeyB", () => settings.allow());
  const ambiguous = await target(bridge, null, undefined, 300);
  expect(ambiguous.prompted).toBe(true);
  expect(ambiguous.target.kind).toBe("blocked");
});

it("a call naming a file no plugin is in is refused without asking any panel", async () => {
  const bridge = startBridge(dir, ports[0]);
  const plugin = startPlugin(ports[0], { file: figma.file("FILEkeyA", "Checkout") });
  await pairByPanel(bridge, plugin);
  figma.file("FILEkeyZ", "Closed file");

  const refused = await target(bridge, "FILEkeyZ");
  expect(refused).toEqual({
    target: { kind: "blocked", block: { kind: "document-not-open", fileKey: "FILEkeyZ" } },
    prompted: false,
  });
  expect(plugin.isPrompting()).toBe(false);
});

it("one file in two plugin instances is one document, and a revoke in either stops both", async () => {
  const bridge = startBridge(dir, ports[0]);
  const storage = new Map<string, unknown>();
  const file = figma.file("FILEkeyA", "Checkout");
  const one = startPlugin(ports[0], { storage, file });
  await pairByPanel(bridge, one);
  const two = startPlugin(ports[0], { storage, file });
  await expect.poll(() => bridge.authenticatedLinks().length, { timeout: 5_000 }).toBe(2);
  await target(bridge, "FILEkeyA", () => one.allow());

  const unnamed = await target(bridge, null);
  expect(unnamed.prompted).toBe(false);
  expect(unnamed.target.kind).toBe("targeted");

  one.revoke();
  const document = { fileKey: figmaFileKey("FILEkeyA"), fileName: "Checkout" };
  for (const link of bridge.authenticatedLinks())
    await expect
      .poll(() => run(bridge, { kind: "targeted", link, document }, "return 1;"), {
        timeout: 5_000,
      })
      .toEqual({ kind: "not-granted", reason: "no-grant" });
  expect(two.isPrompting()).toBe(false);
});

it("a granted file is recognized after the plugin restarts, and a duplicate of it asks for its own grant", async () => {
  const bridge = startBridge(dir, ports[0]);
  const storage = new Map<string, unknown>();
  const file = figma.file("FILEkeyA", "Checkout");
  const first = startPlugin(ports[0], { storage, file });
  await pairByPanel(bridge, first);
  await target(bridge, "FILEkeyA", () => first.allow());
  first.close();
  await expect.poll(() => bridge.authenticatedLinks().length).toBe(0);

  // Nothing tells the new plugin run which file it is in but the claim the proof left in the file.
  const reopened = startPlugin(ports[0], { storage, file });
  await settlesTo(bridge, "linked");
  const recognized = await target(bridge, null);
  expect(recognized.prompted).toBe(false);
  expect(recognized.target).toMatchObject({ kind: "targeted", document: { fileKey: "FILEkeyA" } });
  reopened.close();
  await expect.poll(() => bridge.authenticatedLinks().length).toBe(0);

  const duplicate = startPlugin(ports[0], { storage, file: figma.duplicate(file, "FILEkeyCopy") });
  await settlesTo(bridge, "linked");
  const own = await target(bridge, "FILEkeyCopy", () => duplicate.allow());
  expect(own.prompted).toBe(true);
  expect(own.target).toMatchObject({ kind: "targeted", document: { fileKey: "FILEkeyCopy" } });
});

it("a server with no reader of its own proves a reopened file's claim with the call's, and runs there without a prompt", async () => {
  const bridge = startBridge(dir, ports[0], undefined, null);
  const storage = new Map<string, unknown>();
  const file = figma.file("FILEkeyA", "Checkout");
  const first = startPlugin(ports[0], { storage, file });
  await pairByPanel(bridge, first);
  await target(bridge, "FILEkeyA", () => first.allow());
  first.close();
  await expect.poll(() => bridge.authenticatedLinks().length).toBe(0);

  startPlugin(ports[0], { storage, file });
  await settlesTo(bridge, "linked");
  const recognized = await target(bridge, null);
  expect(recognized.prompted).toBe(false);
  expect(recognized.target).toMatchObject({ kind: "targeted", document: { fileKey: "FILEkeyA" } });
});

it("a proof that never finishes reading the file keeps the file's claim", async () => {
  const file = figma.file("FILEkeyA", "Checkout");
  file.shared.set("framelink/fileKey", "FILEkeyA");
  const neverAnswers: DocumentReader = (_fileKey, signal) =>
    new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  const bridge = startBridge(dir, ports[0], undefined, neverAnswers);
  await pairByPanel(bridge, startPlugin(ports[0], { file }));

  await expect
    .poll(() => bridge.authenticatedLinks().map((link) => bridge.documentOf(link)))
    .toEqual([
      { kind: "claimed", fileKey: "FILEkeyA", problem: expect.stringContaining("timed out") },
    ]);
  expect(file.shared.get("framelink/fileKey")).toBe("FILEkeyA");
});

/** Run code where `named` binds it, and expect it to execute. */
async function runIn(
  bridge: PluginBridge,
  named: Parameters<typeof target>[1],
  code: string,
): Promise<Extract<ExecutionOutcome, { kind: "executed" }>> {
  const session =
    typeof named === "object" && named !== null ? parseSessionHandle(named.session) : null;
  const outcome = await run(bridge, (await target(bridge, named)).target, code, session);
  if (outcome.kind !== "executed") throw new Error(`not executed: ${JSON.stringify(outcome)}`);
  return outcome;
}

it("two agents on one file each see only their own session.last, through the handle each reply names", async () => {
  const bridge = startBridge(dir, ports[0]);
  const plugin = startPlugin(ports[0], { file: figma.file("FILEkeyA", "Checkout") });
  await pairByPanel(bridge, plugin);
  await target(bridge, "FILEkeyA", () => plugin.allow());

  const one = await runIn(bridge, null, `session.agent = "one"; return "one's result";`);
  const two = await runIn(bridge, null, `session.agent = "two"; return "two's result";`);
  expect(one.session).not.toBe(two.session);
  const read = "return [session.agent, session.last];";
  expect((await runIn(bridge, { session: one.session }, read)).reply.result).toEqual([
    "one",
    "one's result",
  ]);
  expect((await runIn(bridge, { session: two.session }, read)).reply.result).toEqual([
    "two",
    "two's result",
  ]);
  // No handle is a fresh session, never another agent's.
  expect((await runIn(bridge, null, read)).reply.result).toEqual([null, null]);
});

it("a handle from before the plugin restarted is refused without running, though the granted file is open", async () => {
  const bridge = startBridge(dir, ports[0]);
  const storage = new Map<string, unknown>();
  const file = figma.file("FILEkeyA", "Checkout");
  const first = startPlugin(ports[0], { storage, file });
  await pairByPanel(bridge, first);
  await target(bridge, "FILEkeyA", () => first.allow());
  const { session } = await runIn(bridge, null, "globalThis.runs = 1;");
  first.close();
  await expect.poll(() => bridge.authenticatedLinks().length).toBe(0);

  startPlugin(ports[0], { storage, file });
  await settlesTo(bridge, "linked");
  expect((await target(bridge, null)).target.kind).toBe("targeted");
  expect(await target(bridge, { session })).toEqual({
    target: { kind: "blocked", block: { kind: "session-not-found", session } },
    prompted: false,
  });
  expect(await target(bridge, { session, fileKey: "FILEkeyA" })).toMatchObject({
    target: { kind: "blocked", block: { kind: "session-not-found" } },
  });
});

it("after a server restart, a session's plugin that redials later than another plugin is still found", async () => {
  const storage = new Map<string, unknown>();
  const before = startBridge(dir, ports[0]);
  // Its handshake lags, so the restarted server hears from the other plugin first.
  const checkout = startPlugin(ports[0], {
    storage,
    file: figma.file("FILEkeyA", "Checkout"),
    holdHelloMs: 700,
  });
  await pairByPanel(before, checkout);
  startPlugin(ports[0], { storage, file: figma.file("FILEkeyB", "Settings") });
  await expect.poll(() => before.authenticatedLinks().length, { timeout: 5_000 }).toBe(2);
  await target(before, "FILEkeyA", () => checkout.allow());
  const { session } = await runIn(before, "FILEkeyA", "session.kept = true;");
  before.stop();

  const after = startBridge(dir, ports[0]);
  await expect.poll(() => after.authenticatedLinks().length, { timeout: 5_000 }).toBe(1);
  expect((await runIn(after, { session }, "return session.kept;")).reply.result).toBe(true);
});

it("a reconnect during a run leaves its outcome unknown, and never runs it a second time", async () => {
  const bridge = startBridge(dir, ports[0]);
  const plugin = startPlugin(ports[0], { file: figma.file("FILEkeyA", "Checkout") });
  await pairByPanel(bridge, plugin);
  await target(bridge, "FILEkeyA", () => plugin.allow());

  const interrupted = run(
    bridge,
    (await target(bridge, "FILEkeyA")).target,
    `globalThis.runs = (globalThis.runs ?? 0) + 1;
     figma.notify("run started");
     await new Promise((resolve) => setTimeout(resolve, 500));`,
  ).catch((error: unknown) => error);
  await expect.poll(() => plugin.toasts).toContain("run started");
  plugin.drop();
  expect(await interrupted).toMatchObject({ outcome: "unconfirmed", phase: "running" });

  await settlesTo(bridge, "linked");
  // Queued behind the interrupted run, so this reads its count once that one has finished.
  expect((await runIn(bridge, "FILEkeyA", "return globalThis.runs;")).reply.result).toBe(1);
});

it("a handle passed with another file's key refuses without running, and without asking either panel", async () => {
  const bridge = startBridge(dir, ports[0]);
  const storage = new Map<string, unknown>();
  const checkout = startPlugin(ports[0], { storage, file: figma.file("FILEkeyA", "Checkout") });
  await pairByPanel(bridge, checkout);
  const settings = startPlugin(ports[0], { storage, file: figma.file("FILEkeyB", "Settings") });
  await expect.poll(() => bridge.authenticatedLinks().length, { timeout: 5_000 }).toBe(2);
  await target(bridge, "FILEkeyA", () => checkout.allow());
  await target(bridge, "FILEkeyB", () => settings.allow());
  const { session } = await runIn(bridge, "FILEkeyA", "session.kept = true;");

  expect(await target(bridge, { session, fileKey: "FILEkeyB" })).toEqual({
    target: {
      kind: "blocked",
      block: {
        kind: "session-document-mismatch",
        session,
        sessionFileName: "Checkout",
        fileKey: "FILEkeyB",
      },
    },
    prompted: false,
  });
  // The handle alone binds to its own file, though two granted files are open.
  expect((await runIn(bridge, { session }, "return session.kept;")).reply.result).toBe(true);
});

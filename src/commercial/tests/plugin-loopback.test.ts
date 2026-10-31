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
  type PluginLink,
} from "~/commercial/plugin-bridge/bridge.js";
import {
  parseSessionHandle,
  type SessionHandle,
} from "~/commercial/plugin-bridge/session-handle.js";
import { parseDocumentId } from "~/commercial/plugin-bridge/document-id.js";
import type { CallIntent } from "~/commercial/plugin-bridge/call-intent.js";
import { LinkCredentialStore } from "~/commercial/plugin-bridge/link-credential.js";
import {
  executePluginCode,
  ExecutionReplyLostError,
  type ExecutionOutcome,
} from "~/commercial/plugin-bridge/execution.js";
import { mintExecutionId, type ExecutionId } from "~/commercial/execution-id.js";
import { targetForPluginCall } from "~/commercial/plugin-bridge/plugin-call-link.js";
import { runPair } from "~/commercial/commands/pair.js";
import { createCliCommandContext } from "~/commands/cli-context.js";
import { WriteAccessStore } from "~/commercial/entitlement/write-access-store.js";
import { writesUsedThisMonth } from "~/commercial/entitlement/write-ledger.js";
import {
  duplicateLoopbackFile,
  loopbackFile,
  startLoopbackPlugin,
  type LoopbackPlugin,
} from "./fixtures/loopback-plugin.js";
import { createTestWriteAccess } from "./fixtures/write-access.js";
import { createBridgeAnnotationSource } from "~/commercial/plugin-bridge/annotation-watch.js";
import { watchFigmaFeedback } from "~/services/watch-figma-feedback.js";
import { figmaFileKey } from "~/utils/figma-url.js";

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
  // Unroutable: write access works offline, from the free allowance. No Figma token anywhere.
  const runtime = startPluginBridge({ assetRoot: dir, framelinkApiUrl: "http://127.0.0.1:9" });
  cleanups.push(() => runtime.stop?.());
  return runtime;
}

function startPlugin(...args: Parameters<typeof startLoopbackPlugin>): LoopbackPlugin {
  const plugin = startLoopbackPlugin(...args);
  cleanups.push(() => plugin.close());
  return plugin;
}

/** A bare relay for a project. */
function startBridge(stateDir: string, port: number, project = "/loopback/project"): PluginBridge {
  const bridge = new PluginBridge({ linkCredentials: new LinkCredentialStore(stateDir), project });
  bridge.start([port]);
  cleanups.push(() => bridge.stop());
  return bridge;
}

/** The stamp a plugin wrote into its file. */
function documentOf(plugin: LoopbackPlugin): string {
  const id = plugin.documentId();
  if (id === null) throw new Error("the plugin hasn't stamped its file");
  return id;
}

/**
 * What a call names: a document id, a session (and maybe a document or file key), or nothing; and
 * the intent it states, which the panel shows.
 */
type Named =
  | string
  | null
  | { session?: string; document?: string; fileKey?: string; intent?: string };

interface Targeted {
  target: CallTarget;
  prompted: boolean;
  executionId: ExecutionId;
  intent: CallIntent;
}

/**
 * Bind a call the way the tools do, short-waited. `whilePrompted` runs when the call starts waiting
 * on a panel, so a test can click; `prompted` says whether it did.
 */
async function target(
  bridge: PluginBridge,
  named: Named,
  whilePrompted?: () => unknown,
  waitMs = 5_000,
): Promise<Targeted> {
  let prompted = false;
  const {
    session = null,
    document = null,
    fileKey = null,
    intent: stated = "Loopback call",
  } = typeof named === "object" && named !== null ? named : { document: named };
  const executionId = mintExecutionId();
  const intent = stated as CallIntent;
  const target = await bridge.targetCall(
    {
      executionId,
      intent,
      session: session === null ? null : parseSessionHandle(session),
      document: document === null ? null : parseDocumentId(document),
      fileKey: fileKey === null ? null : figmaFileKey(fileKey),
    },
    {
      signal: new AbortController().signal,
      deadline: Date.now() + waitMs,
      pollMs: 20,
      onWaiting: (wait) => {
        if ((wait.kind === "allow" || wait.kind === "pick") && !prompted) {
          prompted = true;
          void whilePrompted?.();
        }
        return async () => {};
      },
    },
  );
  return { target, prompted, executionId, intent };
}

/** Run code on a bound call, in the session it named (null: a fresh one), metered offline. */
function run(
  bridge: PluginBridge,
  { target: bound, executionId, intent }: Targeted,
  code: string,
  session: SessionHandle | null = null,
): Promise<ExecutionOutcome> {
  if (bound.kind !== "targeted") throw new Error(`not targeted: ${JSON.stringify(bound)}`);
  const { writeMeter } = createTestWriteAccess();
  return executePluginCode(
    { bridge, writeMeter, readLocalImage: () => Promise.reject(new Error("no images")) },
    { ...bound, executionId, intent, session },
    code,
  );
}

/** Wait until `bridge` resolves a link of `kind` — a plugin redials and sets up on its own clock. */
async function settlesTo(bridge: PluginBridge, kind: string) {
  await expect.poll(async () => (await bridge.resolveLink()).kind, { timeout: 5_000 }).toBe(kind);
}

/** Wait until `bridge` has `count` links, each with its file reported. */
async function linksReported(bridge: PluginBridge, count: number) {
  await expect
    .poll(
      () =>
        bridge.authenticatedLinks().filter((link) => bridge.documentOf(link).kind !== "unknown")
          .length,
      { timeout: 5_000 },
    )
    .toBe(count);
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

it("without a token: pairs, an unnamed call asks Allow in the one open file, then writes with no clicks", async () => {
  const runtime = startRuntime();
  const plugin = startPlugin(ports[0], { file: loopbackFile("Checkout") });
  const link = await pairByPanel(runtime.bridge, plugin);
  expect(link.owner).toEqual({ figmaUserId: "loopback-user", name: "Loopback Human" });
  await linksReported(runtime.bridge, 1);
  const checkout = documentOf(plugin);

  // The one open file: the call asks Allow there rather than being refused.
  const unnamed = await target(runtime.bridge, null, () => plugin.allow());
  expect(unnamed).toMatchObject({
    prompted: true,
    target: { kind: "targeted", document: { documentId: checkout, fileName: "Checkout" } },
  });

  const execute = async (code: string, click?: () => unknown) => {
    const bound = await target(runtime.bridge, checkout, click);
    if (bound.target.kind !== "targeted") throw new Error(JSON.stringify(bound.target));
    expect(bound.target.document).toEqual({
      documentId: checkout,
      fileName: "Checkout",
      fileKey: null,
    });
    return {
      prompted: bound.prompted,
      outcome: await executePluginCode(
        runtime,
        { ...bound.target, executionId: bound.executionId, intent: bound.intent, session: null },
        code,
      ),
    };
  };

  const read = await execute("return 1 + 1;");
  expect(read).toMatchObject({
    prompted: false,
    outcome: { kind: "executed", reply: { result: 2, console: [], errors: null } },
  });

  // A raw figma.* write is metered from the change Figma reports during the run.
  const write = await execute("figma.createRectangle(); return 'drawn';");
  expect(write).toMatchObject({
    prompted: false,
    outcome: { kind: "executed", reply: { result: "drawn" } },
  });
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
  const paired = runPair(
    { wait: 5 },
    createCliCommandContext({ signal: new AbortController().signal, credential: undefined }),
    { input },
  );
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

it("servers in one project share one grant from one click; a server in another project must name the file", async () => {
  ports.push(await reservePort(), await reservePort());
  const first = startBridge(dir, ports[0], "/work/app");
  const sibling = startBridge(dir, ports[1], "/work/app");
  const elsewhere = startBridge(dir, ports[2], "/work/other");
  const plugin = startPlugin(ports, { file: loopbackFile("Checkout") });
  await pairByPanel(first, plugin);
  for (const bridge of [sibling, elsewhere]) {
    await settlesTo(bridge, "linked");
    await linksReported(bridge, 1);
  }
  const checkout = documentOf(plugin);

  const granted = await target(first, checkout, () => plugin.allow());
  expect(granted.prompted).toBe(true);
  expect(await run(first, granted, "return 'first';")).toMatchObject({ kind: "executed" });

  const shared = await target(sibling, null);
  expect(shared.prompted).toBe(false);
  expect(await run(sibling, shared, "return 'sibling';")).toMatchObject({
    kind: "executed",
    reply: { result: "sibling" },
  });

  // The one open file: an unnamed call asks to Allow there, as a named one does.
  const unnamed = await target(elsewhere, null, undefined, 300);
  expect(unnamed).toMatchObject({ prompted: true, target: { block: { kind: "grant-pending" } } });
  const named = await target(elsewhere, checkout, undefined, 300);
  expect(named).toMatchObject({ prompted: true, target: { block: { kind: "grant-pending" } } });
});

it("several open files: an unnamed call is refused at once with each and its grant, and a named one asks only that file", async () => {
  const bridge = startBridge(dir, ports[0]);
  const storage = new Map<string, unknown>();
  const checkout = startPlugin(ports[0], { storage, file: loopbackFile("Checkout") });
  await pairByPanel(bridge, checkout);
  const settings = startPlugin(ports[0], { storage, file: loopbackFile("Settings") });
  await linksReported(bridge, 2);

  // Named: only that file's panel is asked.
  const named = await target(bridge, documentOf(checkout), async () => {
    await expect.poll(() => checkout.isPrompting()).toBe(true);
    expect(settings.isPrompting()).toBe(false);
    await checkout.allow();
  });
  expect(named.target).toMatchObject({ kind: "targeted", document: { fileName: "Checkout" } });

  const ambiguous = await target(bridge, null);
  expect(ambiguous.prompted).toBe(false);
  if (ambiguous.target.kind !== "blocked" || ambiguous.target.block.kind !== "document-unchosen")
    throw new Error(JSON.stringify(ambiguous.target));
  expect(
    ambiguous.target.block.open.documents.map(({ fileName, documentId, granted }) => ({
      fileName,
      documentId,
      granted,
    })),
  ).toEqual(
    expect.arrayContaining([
      { fileName: "Checkout", documentId: documentOf(checkout), granted: true },
      { fileName: "Settings", documentId: documentOf(settings), granted: false },
    ]),
  );

  await target(bridge, documentOf(settings), () => settings.allow());
  const retried = await target(bridge, documentOf(settings));
  expect(retried.prompted).toBe(false);
  expect(await run(bridge, retried, "return 'settings';")).toMatchObject({
    kind: "executed",
    reply: { result: "settings" },
  });
});

it("two agents write to two files in parallel", async () => {
  const bridge = startBridge(dir, ports[0]);
  const storage = new Map<string, unknown>();
  const checkout = startPlugin(ports[0], { storage, file: loopbackFile("Checkout") });
  await pairByPanel(bridge, checkout);
  const settings = startPlugin(ports[0], { storage, file: loopbackFile("Settings") });
  await linksReported(bridge, 2);
  await target(bridge, documentOf(checkout), () => checkout.allow());
  await target(bridge, documentOf(settings), () => settings.allow());

  const slow = `await new Promise((resolve) => setTimeout(resolve, 300)); return figma.root.name;`;
  const [one, two] = await Promise.all([
    target(bridge, documentOf(checkout)).then((bound) => run(bridge, bound, slow)),
    target(bridge, documentOf(settings)).then((bound) => run(bridge, bound, slow)),
  ]);
  expect([one, two]).toMatchObject([
    { kind: "executed", reply: { result: "Checkout" } },
    { kind: "executed", reply: { result: "Settings" } },
  ]);
});

it("a call that stops waiting leaves its Allow prompt in the panel, says approval is pending, and a later Allow lets the next call run with no prompt", async () => {
  const first = startBridge(dir, ports[0], "/work/app");
  const plugin = startPlugin(ports[0], { file: loopbackFile("Checkout") });
  await pairByPanel(first, plugin);
  await linksReported(first, 1);
  const checkout = documentOf(plugin);

  // Nobody clicks in time: the call answers as an MCP call checking in would.
  const unanswered = await targetForPluginCall(first, {
    intent: "Rebuild the pricing card" as CallIntent,
    document: parseDocumentId(checkout),
    fileKey: null,
    session: null,
    pairing: { kind: "refuse" },
    signal: new AbortController().signal,
    surface: "mcp",
    deadline: Date.now() + 300,
    pollMs: 20,
  });
  if (unanswered.kind !== "blocked") throw new Error(JSON.stringify(unanswered));
  expect(unanswered).toMatchObject({ block: "grant_pending", isError: false });
  expect(unanswered.text).toContain("approval hasn't been granted yet");
  expect(unanswered.text).toContain('This project ("/work/app") isn\'t allowed to edit "Checkout"');
  expect(unanswered.text).toContain(
    "The prompt stays in that panel after this call. Tell the user to click Allow there.",
  );
  expect(unanswered.text).not.toContain("NOT a failure");

  // The process exits, as a CLI run does: its socket closes, and the prompt stays, stopped waiting.
  first.stop();
  await expect
    .poll(() => plugin.prompts())
    .toEqual([expect.objectContaining({ kind: "allow", project: "/work/app", waitedOn: false })]);
  await plugin.allow("/work/app");

  const next = startBridge(dir, ports[0], "/work/app");
  await settlesTo(next, "linked");
  await linksReported(next, 1);
  const retried = await target(next, checkout);
  expect(retried.prompted).toBe(false);
  expect(await run(next, retried, "return 'card';")).toMatchObject({
    kind: "executed",
    reply: { result: "card" },
  });
  expect(plugin.prompts()).toEqual([]);
});

it("a second call from the same project waits on the prompt the first raised, and one Allow lets both run", async () => {
  const bridge = startBridge(dir, ports[0]);
  const plugin = startPlugin(ports[0], { file: loopbackFile("Checkout") });
  await pairByPanel(bridge, plugin);
  await linksReported(bridge, 1);
  const checkout = documentOf(plugin);

  const hero = target(bridge, { document: checkout, intent: "Delete the old hero" });
  await expect.poll(() => plugin.prompts().map((p) => p.intent)).toEqual(["Delete the old hero"]);
  const card = target(bridge, { document: checkout, intent: "Rebuild the pricing card" });
  // One prompt, now showing the newest call's intent.
  await expect
    .poll(() => plugin.prompts().map((p) => p.intent))
    .toEqual(["Rebuild the pricing card"]);
  await plugin.allow();
  const [heroCall, cardCall] = await Promise.all([hero, card]);
  for (const call of [heroCall, cardCall])
    expect(call).toMatchObject({ prompted: true, target: { kind: "targeted" } });
  expect(await run(bridge, cardCall, "return 'card';")).toMatchObject({ kind: "executed" });
});

it("a viewer's plugin that can't stamp its file is listed as unusable, and the granted file still defaults", async () => {
  const bridge = startBridge(dir, ports[0]);
  const storage = new Map<string, unknown>();
  const checkout = startPlugin(ports[0], { storage, file: loopbackFile("Checkout") });
  await pairByPanel(bridge, checkout);
  await linksReported(bridge, 1);
  await target(bridge, documentOf(checkout), () => checkout.allow());
  const viewer = startPlugin(ports[0], {
    storage,
    file: loopbackFile("Read only", { readOnly: true }),
  });
  await linksReported(bridge, 2);
  expect(viewer.documentId()).toBeNull();

  const unnamed = await target(bridge, null);
  expect(unnamed.target).toMatchObject({ kind: "targeted", document: { fileName: "Checkout" } });
  const snapshot = await bridge.openDocuments(new AbortController().signal);
  expect(snapshot.unidentified).toEqual([expect.stringContaining("refused to mark this file")]);
  expect(snapshot.documents.map((document) => document.fileName)).toEqual(["Checkout"]);
});

it("a call naming a document no plugin is in is refused with the open files, without asking any panel; a file key matches only plugins that report one", async () => {
  const bridge = startBridge(dir, ports[0]);
  const storage = new Map<string, unknown>();
  const keyed = startPlugin(ports[0], {
    storage,
    file: loopbackFile("Checkout", { key: "FILEkeyA" }),
  });
  await pairByPanel(bridge, keyed);
  startPlugin(ports[0], { storage, file: loopbackFile("Settings", { key: null }) });
  await linksReported(bridge, 2);

  const closed = await target(bridge, "zzzzzzzzzzzzzzzz");
  expect(closed).toMatchObject({
    prompted: false,
    target: {
      kind: "blocked",
      block: { kind: "document-not-open", document: "zzzzzzzzzzzzzzzz", open: { complete: true } },
    },
  });
  expect(keyed.isPrompting()).toBe(false);

  const byKey = await target(bridge, { fileKey: "FILEkeyA" }, () => keyed.allow());
  expect(byKey.target).toMatchObject({
    kind: "targeted",
    document: { documentId: documentOf(keyed), fileName: "Checkout", fileKey: "FILEkeyA" },
  });
  const unreported = await target(bridge, { fileKey: "FILEkeyB" });
  expect(unreported.target).toMatchObject({
    block: { kind: "document-not-open", fileKey: "FILEkeyB" },
  });
});

it("one file in two plugin instances is one document, and a revoke in either stops both", async () => {
  const bridge = startBridge(dir, ports[0]);
  const storage = new Map<string, unknown>();
  // Both report the same file key, so they are one file open twice, not a copy.
  const file = loopbackFile("Checkout", { key: "FILEkeyA" });
  const one = startPlugin(ports[0], { storage, file });
  await pairByPanel(bridge, one);
  const two = startPlugin(ports[0], { storage, file });
  await linksReported(bridge, 2);
  await target(bridge, documentOf(one), () => one.allow());

  const unnamed = await target(bridge, null);
  expect(unnamed.prompted).toBe(false);
  expect(unnamed.target.kind).toBe("targeted");

  one.revoke();
  const document = {
    documentId: parseDocumentId(documentOf(one))!,
    fileName: "Checkout",
    fileKey: figmaFileKey("FILEkeyA"),
  };
  for (const link of bridge.authenticatedLinks())
    await expect
      .poll(
        () =>
          run(
            bridge,
            {
              target: { kind: "targeted", link, document },
              prompted: false,
              executionId: mintExecutionId(),
              intent: "Run after the revoke" as CallIntent,
            },
            "return 1;",
          ),
        { timeout: 5_000 },
      )
      .toEqual({ kind: "not-granted", reason: "no-grant" });
  expect(two.isPrompting()).toBe(false);
});

it("a plugin restart keeps the stamp and the grant; a duplicate asks for a pick in both panels, and once given its own identity needs its own grant", async () => {
  const bridge = startBridge(dir, ports[0]);
  const storage = new Map<string, unknown>();
  const file = loopbackFile("Checkout");
  const first = startPlugin(ports[0], { storage, file });
  await pairByPanel(bridge, first);
  await linksReported(bridge, 1);
  const checkout = documentOf(first);
  await target(bridge, checkout, () => first.allow());
  first.close();
  await expect.poll(() => bridge.authenticatedLinks().length).toBe(0);

  const reopened = startPlugin(ports[0], { storage, file });
  await linksReported(bridge, 1);
  expect(documentOf(reopened)).toBe(checkout);
  const recognized = await target(bridge, null);
  expect(recognized.prompted).toBe(false);
  expect(recognized.target).toMatchObject({ kind: "targeted", document: { documentId: checkout } });

  // Figma's Duplicate copies the root, stamp and all: nothing tells the two files apart.
  const copy = startPlugin(ports[0], { storage, file: duplicateLoopbackFile(file) });
  await linksReported(bridge, 2);
  expect(documentOf(copy)).toBe(checkout);
  const picked = await target(bridge, checkout, async () => {
    await expect.poll(() => reopened.prompts().map((prompt) => prompt.kind)).toEqual(["pick"]);
    await expect.poll(() => copy.prompts().map((prompt) => prompt.kind)).toEqual(["pick"]);
    await reopened.pick();
  });
  expect(picked.prompted).toBe(true);
  expect(await run(bridge, picked, "return figma.root.name;")).toMatchObject({
    reply: { result: "Checkout" },
  });

  // A call waiting on the pick when the copy is given its own identity is refused with the new list.
  const waiting = await target(bridge, checkout, async () => {
    await expect.poll(() => copy.prompts().length).toBe(1);
    await copy.restamp();
  });
  if (waiting.target.kind !== "blocked" || waiting.target.block.kind !== "document-changed")
    throw new Error(JSON.stringify(waiting.target));
  const ownId = documentOf(copy);
  expect(ownId).not.toBe(checkout);
  await expect
    .poll(async () =>
      (await bridge.openDocuments(new AbortController().signal)).documents
        .map((document) => [document.documentId, document.granted])
        .sort(),
    )
    .toEqual(
      [
        [checkout, true],
        [ownId, false],
      ].sort(),
    );

  const own = await target(bridge, ownId, () => copy.allow());
  expect(own.prompted).toBe(true);
  expect(own.target).toMatchObject({ kind: "targeted", document: { documentId: ownId } });
});

/** Run code where `named` binds it, and expect it to execute. */
async function runIn(
  bridge: PluginBridge,
  named: Parameters<typeof target>[1],
  code: string,
): Promise<Extract<ExecutionOutcome, { kind: "executed" }>> {
  const session =
    typeof named === "object" && named !== null && named.session
      ? parseSessionHandle(named.session)
      : null;
  const outcome = await run(bridge, await target(bridge, named), code, session);
  if (outcome.kind !== "executed") throw new Error(`not executed: ${JSON.stringify(outcome)}`);
  return outcome;
}

it("two agents on one file each see only their own session.last, through the handle each reply names", async () => {
  const bridge = startBridge(dir, ports[0]);
  const plugin = startPlugin(ports[0], { file: loopbackFile("Checkout") });
  await pairByPanel(bridge, plugin);
  await linksReported(bridge, 1);
  await target(bridge, documentOf(plugin), () => plugin.allow());

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
  const file = loopbackFile("Checkout");
  const first = startPlugin(ports[0], { storage, file });
  await pairByPanel(bridge, first);
  await linksReported(bridge, 1);
  const checkout = documentOf(first);
  await target(bridge, checkout, () => first.allow());
  const { session } = await runIn(bridge, null, "globalThis.runs = 1;");
  first.close();
  await expect.poll(() => bridge.authenticatedLinks().length).toBe(0);

  startPlugin(ports[0], { storage, file });
  await linksReported(bridge, 1);
  expect((await target(bridge, null)).target.kind).toBe("targeted");
  expect(await target(bridge, { session })).toMatchObject({
    target: { kind: "blocked", block: { kind: "session-not-found", session } },
    prompted: false,
  });
  expect(await target(bridge, { session, document: checkout })).toMatchObject({
    target: { kind: "blocked", block: { kind: "session-not-found" } },
  });
});

it("after a server restart, a session's plugin that redials later than another plugin is still found", async () => {
  const storage = new Map<string, unknown>();
  const before = startBridge(dir, ports[0]);
  // Its handshake lags, so the restarted server hears from the other plugin first.
  const checkout = startPlugin(ports[0], {
    storage,
    file: loopbackFile("Checkout"),
    holdHelloMs: 700,
  });
  await pairByPanel(before, checkout);
  startPlugin(ports[0], { storage, file: loopbackFile("Settings") });
  await linksReported(before, 2);
  await target(before, documentOf(checkout), () => checkout.allow());
  const { session } = await runIn(before, documentOf(checkout), "session.kept = true;");
  before.stop();

  const after = startBridge(dir, ports[0]);
  await expect.poll(() => after.authenticatedLinks().length, { timeout: 5_000 }).toBe(1);
  expect((await runIn(after, { session }, "return session.kept;")).reply.result).toBe(true);
});

it("after a server restart, an unnamed call is refused at once with a file still redialing listed, and naming it waits for it", async () => {
  const storage = new Map<string, unknown>();
  const before = startBridge(dir, ports[0]);
  const checkout = startPlugin(ports[0], {
    storage,
    file: loopbackFile("Checkout"),
    holdHelloMs: 700,
  });
  await pairByPanel(before, checkout);
  startPlugin(ports[0], { storage, file: loopbackFile("Settings") });
  await linksReported(before, 2);
  await target(before, documentOf(checkout), () => checkout.allow());
  before.stop();

  const after = startBridge(dir, ports[0]);
  await linksReported(after, 1);
  const unnamed = await target(after, null);
  if (unnamed.target.kind !== "blocked" || unnamed.target.block.kind !== "document-unchosen")
    throw new Error(JSON.stringify(unnamed.target));
  expect(
    unnamed.target.block.open.documents.map(({ fileName, granted }) => ({ fileName, granted })),
  ).toEqual(
    expect.arrayContaining([
      { fileName: "Checkout", granted: true },
      { fileName: "Settings", granted: false },
    ]),
  );
  const named = await target(after, documentOf(checkout));
  expect(named.target).toMatchObject({
    kind: "targeted",
    document: { documentId: documentOf(checkout), fileName: "Checkout" },
  });
});

it("a reconnect during a run stops it, leaves its outcome unknown, names its session, and never runs it a second time", async () => {
  const bridge = startBridge(dir, ports[0]);
  const plugin = startPlugin(ports[0], { file: loopbackFile("Checkout") });
  await pairByPanel(bridge, plugin);
  await linksReported(bridge, 1);
  await target(bridge, documentOf(plugin), () => plugin.allow());

  const interrupted = run(
    bridge,
    await target(bridge, documentOf(plugin)),
    `globalThis.runs = (globalThis.runs ?? 0) + 1;
     figma.notify("run started");
     await new Promise((resolve) => setTimeout(resolve, 500));
     return "interrupted run's result";`,
  ).catch((error: unknown) => error);
  await expect.poll(() => plugin.toasts).toContain("run started");
  plugin.drop();
  const lost = await interrupted;
  if (!(lost instanceof ExecutionReplyLostError)) throw lost;
  expect(lost).toMatchObject({ outcome: "unconfirmed" });
  expect(lost.message).toContain(lost.session);

  await settlesTo(bridge, "linked");
  // Queued behind the interrupted run, so this reads what it did once it has ended. The dropped link
  // stopped it before it returned, so it ran once and recorded no last.
  const read = "return [globalThis.runs, session.last];";
  expect((await runIn(bridge, { session: lost.session }, read)).reply.result).toEqual([1, null]);
});

it("a handle passed with another document refuses without running, and without asking either panel", async () => {
  const bridge = startBridge(dir, ports[0]);
  const storage = new Map<string, unknown>();
  const checkout = startPlugin(ports[0], { storage, file: loopbackFile("Checkout") });
  await pairByPanel(bridge, checkout);
  const settings = startPlugin(ports[0], { storage, file: loopbackFile("Settings") });
  await linksReported(bridge, 2);
  await target(bridge, documentOf(checkout), () => checkout.allow());
  await target(bridge, documentOf(settings), () => settings.allow());
  const { session } = await runIn(bridge, documentOf(checkout), "session.kept = true;");

  expect(await target(bridge, { session, document: documentOf(settings) })).toMatchObject({
    target: {
      kind: "blocked",
      block: {
        kind: "session-document-mismatch",
        session,
        sessionFileName: "Checkout",
        document: documentOf(settings),
        fileKey: null,
      },
    },
    prompted: false,
  });
  // The handle alone binds to its own file, though two granted files are open.
  expect((await runIn(bridge, { session }, "return session.kept;")).reply.result).toBe(true);
});

it("a watch hears a person's note edit once the plugin says its log moved, and only once the project is allowed in the file", async () => {
  const bridge = startBridge(dir, ports[0]);
  const plugin = startPlugin(ports[0], { file: loopbackFile("Checkout", { key: "FILEkeyA" }) });
  await pairByPanel(bridge, plugin);
  await linksReported(bridge, 1);
  const watch = (timeoutMs: number) =>
    watchFigmaFeedback({ none: true, noCommentsNote: "No token" }, figmaFileKey("FILEkeyA"), {
      timeoutMs,
      annotations: createBridgeAnnotationSource(bridge),
      signal: new AbortController().signal,
    });

  const refused = await watch(50);
  expect(refused.notes).toContainEqual(expect.stringContaining(`isn't allowed in "Checkout"`));

  await target(bridge, documentOf(plugin), () => plugin.allow());
  setTimeout(() => plugin.annotate("5:1", "Use the brand blue"), 100);
  const heard = await watch(5_000);
  expect(heard).toMatchObject({
    status: "feedback",
    annotations: [
      {
        id: "5:1",
        name: "Node 5:1",
        path: "Page 1",
        annotations: [{ text: "Use the brand blue" }],
      },
    ],
  });
});

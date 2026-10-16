/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { createWarningRegistry } from "./preamble/warnings.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import vm from "node:vm";
import { createHmac } from "node:crypto";
import { DOCUMENT_ID_KEY, linkProofMessage } from "./protocol.js";
import type { ConnKey, HostInbound, HostOutbound, PanelControl, PanelRender } from "./panel.js";

const bundle = (entry: string) =>
  buildSync({ entryPoints: [new URL(entry, import.meta.url).pathname], bundle: true, write: false, format: "iife" })
    .outputFiles[0].text;
const code = bundle("./code.ts");
const uiScript = bundle("./ui.ts");
type Frame = Record<string, unknown>;
/** A frame the host addressed to a server, with the socket generation it named beside it (panel.ts). */
type Sent = { connKey: ConnKey; frame: Frame };
// Tests wait on what the plugin SAYS, never on elapsed time or a count of event-loop turns: the host's
// reply path crosses real timers (document-changes.ts settles one task), so "N turns later" is a race.
// The deadline only turns a missing frame into a readable failure instead of a hung run.
const FRAME_DEADLINE_MS = 5_000;
// The installation every test plugin is paired with, and the stamp of the file every test plugin is in.
const CREDENTIAL = { id: "credential-id-1", secret: "secret-0123456789abcdef" };
const DOCUMENT_ID = "0123456789abcdef";
const OTHER_DOCUMENT_ID = "fedcba9876543210";
const stampedFile = (): Map<string, string> => new Map([[DOCUMENT_ID_KEY, DOCUMENT_ID]]);
type Storage = Map<string, unknown>;
const pairedStorage = (): Storage => new Map([["code-mode:link-credential:" + CREDENTIAL.id, CREDENTIAL.secret]]);
const clientStorageOver = (storage: Storage) => ({
  getAsync: async (key: string) => storage.get(key),
  setAsync: async (key: string, value: unknown) => void storage.set(key, value),
  deleteAsync: async (key: string) => void storage.delete(key),
  keysAsync: async () => [...storage.keys()],
});
/**
 * The real host in a vm. `pluginData` is the file root's private plugin data, where the stamp lives:
 * share one Map between hosts to model the same file reopened, copy it to model a duplicate.
 */
function host(native: Record<string, unknown> = {}, storage: Storage = pairedStorage(), pluginData = stampedFile()) {
  // Kept as the host's two envelopes: server frames with their routing key, and panel renders.
  const sent: Sent[] = [];
  const renders: PanelRender[] = [];
  const waiters = new Set<() => boolean>();
  const record = (outbound: HostOutbound) => {
    if (outbound.to === "server") {
      const frame = outbound.frame as unknown as Frame;
      sent.push({ connKey: outbound.connKey, frame });
      // Reads ask the server for the file's comment pins; this file has none.
      if (frame.type === "CHANNEL_REQUEST" && frame.capability === "comments.pins")
        queueMicrotask(() =>
          figma.ui.onmessage({
            from: "server",
            connKey: outbound.connKey,
            frame: { type: "CHANNEL_RESPONSE", id: frame.id, ok: true, payload: { pins: [] } },
          }),
        );
    } else renders.push(outbound.render);
    for (const waiter of waiters) if (waiter()) waiters.delete(waiter);
  };
  const waitFor = <T>(find: () => T | undefined, what: string): Promise<T> => {
    const seen = find();
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`the plugin never sent ${what}`)), FRAME_DEADLINE_MS).unref();
      waiters.add(() => {
        const found = find();
        if (found === undefined) return false;
        clearTimeout(deadline);
        resolve(found);
        return true;
      });
    });
  };
  /** The first server frame, already sent or still to come, that matches. */
  const frame = (match: (f: Frame, connKey: ConnKey) => boolean, what = "an expected frame"): Promise<Frame> =>
    waitFor(() => sent.find((s) => match(s.frame, s.connKey))?.frame, what);
  /** The first panel render, already painted or still to come, that matches. */
  const render = (match: (r: PanelRender) => boolean, what: string): Promise<PanelRender> =>
    waitFor(() => renders.find(match), what);
  // One page and the change events the host meters by. Live Figma delivers a raw write's nodechange
  // "periodically", with no deadline; here it waits until the test delivers it (deliverChanges), so
  // "after the reply" is a fact the test arranges rather than a delay it hopes for.
  const nodeChangeListeners = new Set<(event: unknown) => void>();
  const undelivered: ("LOCAL" | "REMOTE")[] = [];
  const emitNodeChange = (origin: "LOCAL" | "REMOTE") => undelivered.push(origin);
  const deliverChanges = () => {
    for (const origin of undelivered.splice(0))
      for (const cb of [...nodeChangeListeners]) cb({ nodeChanges: [{ type: "CREATE", id: "9:9", origin }] });
  };
  const page = {
    id: "0:1",
    name: "test",
    on: (_type: string, cb: (event: unknown) => void) => nodeChangeListeners.add(cb),
    off: (_type: string, cb: (event: unknown) => void) => nodeChangeListeners.delete(cb),
  };
  const figma = {
    showUI() {},
    notify() {},
    currentPage: page,
    root: { name: "Test file", children: [page] },
    on() {},
    off() {},
    createRectangle() {
      emitNodeChange("LOCAL");
      return { id: "9:9", type: "RECTANGLE" };
    },
    // Someone else in the file: a change the run must not be charged for.
    simulateRemoteEdit() {
      emitNodeChange("REMOTE");
    },
    clientStorage: clientStorageOver(storage),
    currentUser: { id: "figma-user-7", name: "Ada" },
    ...native,
    ui: {
      postMessage: record,
      onmessage: (_inbound: HostInbound) => {},
      resize() {},
    },
  };
  // The file root's private plugin data, where the stamp lives — on any root a test swaps in, unless
  // that root brings its own.
  const root = figma.root as Record<string, unknown>;
  root.getPluginData ??= (key: string) => pluginData.get(key) ?? "";
  root.setPluginData ??= (key: string, value: string) => void pluginData.set(key, value);
  // A root of its own (the figma mock's) is stamped with this file's id too, so runs find it.
  const stamp = pluginData.get(DOCUMENT_ID_KEY);
  if (stamp && root.getPluginData !== undefined && !(root.getPluginData as (key: string) => string)(DOCUMENT_ID_KEY))
    try {
      (root.setPluginData as (key: string, value: string) => void)(DOCUMENT_ID_KEY, stamp);
    } catch {
      // A view-only root refuses; the test is about exactly that.
    }
  // Unref'd so a run's minute-long late-change watch can't hold the test process open after it ends.
  const hostSetTimeout = (callback: () => void, ms?: number) => setTimeout(callback, ms).unref();
  const context = vm.createContext({ createWarningRegistry, figma, __html__: "", console: { ...console }, setTimeout: hostSetTimeout, clearTimeout });
  vm.runInContext(code, context);
  // Stand in for the relay (ui.ts), in its two envelopes. A server frame is untrusted JSON the host
  // must admit, so it stays loosely typed; every EXECUTE_CODE carries the server's late-change window,
  // and every run names this file's document unless the test says otherwise. Unless a test names a session,
  // every run resumes its project's one shared session, which connect() opens — as an agent passing
  // its handle back would.
  const projectOf = new Map<ConnKey, string>();
  const sharedSessions = new Map<string, string>();
  const sharedSessionOf = (project: string) => {
    let handle = sharedSessions.get(project);
    if (!handle) {
      handle = `shared-session-project-${["one", "two", "three", "four"][sharedSessions.size]}`;
      sharedSessions.set(project, handle);
    }
    return handle;
  };
  const sendFrame = (connKey: ConnKey, frame: Frame) =>
    figma.ui.onmessage({
      from: "server",
      connKey,
      frame:
        frame.type === "EXECUTE_CODE"
          ? {
              lateChangeWindowMs: 60_000,
              documentId: DOCUMENT_ID,
              session: { handle: sharedSessionOf(projectOf.get(connKey) ?? "/proj"), create: false },
              ...frame,
            }
          : frame.type === "SCREENSHOT"
            ? { documentId: DOCUMENT_ID, ...frame }
            : frame,
    });
  const sendControl = (control: PanelControl) => figma.ui.onmessage({ from: "panel", control });
  /** A server request, answered: resolves with the reply frame. */
  let nextId = 0;
  const ask = (key: ConnKey, request: Frame): Promise<Frame> => {
    const id = `ask-${++nextId}`;
    sendFrame(key, { ...request, id });
    return frame((f, connKey) => f.id === id && connKey === key, `the reply to ${String(request.type)}`);
  };
  /** A socket that authenticated with the paired credential and introduced its project. */
  const introduce = async (key: ConnKey, project = "/proj", framelinkOrigin = "https://app.framelink.ai") => {
    projectOf.set(key, project);
    sendControl({ type: "WS_CONNECTED", connKey: key });
    assert.equal((await ask(key, { type: "AUTHENTICATE", credentialId: CREDENTIAL.id, nonce: `nonce-${key}-0000` })).type, "LINK_PROOF");
    return ask(key, { type: "INTRODUCE", project, framelinkOrigin });
  };
  /** A call's GRANT_STATUS poll, for `documentId` (this file's by default). */
  const grantStatus = async (key: ConnKey, executionId: string, prompt: string, documentId = DOCUMENT_ID) =>
    (await ask(key, { type: "GRANT_STATUS", executionId, documentId, prompt })).state;
  /**
   * A call asks for Allow and the human clicks it on that call's prompt; resolved once the grant is
   * saved and announced. A project already granted is asked nothing.
   */
  const allow = async (key: ConnKey, executionId = `allow-${key}-${++nextId}`, documentId = DOCUMENT_ID) => {
    if ((await grantStatus(key, executionId, "allow", documentId)) === "granted") return;
    const before = sent.length;
    sendControl({ type: "UI_DECISION", approve: true, connKey: key, executionId, documentId });
    await waitFor(
      () => sent.slice(before).find((s) => s.connKey === key && s.frame.type === "GRANT_CHANGED" && s.frame.granted === true),
      `the grant for ${key}`,
    );
  };
  /**
   * A granted server, with its project's shared session open. The opening run's preamble
   * never builds the session's store, so the first run that does gets the store its own preamble
   * makes.
   */
  const openedProjects = new Set<string>();
  const connect = async (key: ConnKey, project = "/proj") => {
    await introduce(key, project);
    await allow(key);
    if (openedProjects.has(project)) return;
    openedProjects.add(project);
    const id = `open-session-${++nextId}`;
    sendFrame(key, {
      type: "EXECUTE_CODE",
      id,
      preamble:
        "(host)=>({ flcm: {}, session: {}, warnings: createWarningRegistry(), mutationQueueIdle: async () => 0, committedVerbCount: () => 0, projectForEgress: (value) => value })",
      code: "",
      session: { handle: sharedSessionOf(project), create: true },
    });
    assert.equal((await frame((f) => f.id === id, "the shared session opening")).type, "EXECUTE_CODE_RESULT");
  };
  const result = (id: string, key?: ConnKey) =>
    frame(
      (f, connKey) => f.id === id && f.type === "EXECUTE_CODE_RESULT" && (key === undefined || connKey === key),
      `a result for ${id}`,
    ) as Promise<any>;
  const running = (id: string, key: ConnKey) =>
    frame((f, connKey) => f.type === "RUN_STATE" && f.executionId === id && connKey === key && f.phase === "running", `${id} running`);
  return { sent, renders, context, storage, pluginData, sendFrame, sendControl, ask, introduce, grantStatus, allow, connect, frame, render, result, running, deliverChanges };
}

test("queued cancellation never executes, old settlement cannot cancel or erase replacement run", async () => {
  const h = host();
  await h.connect(1);
  let release!: () => void;
  h.context.hold = new Promise<void>((r) => {
    release = r;
  });
  h.context.writes = [];
  const run = (key: number, id: string, body: string) =>
    h.sendFrame(key, { type: "EXECUTE_CODE", id, preamble: "(host)=>({ flcm: {}, session: host.getSession(() => ({})), warnings: createWarningRegistry(), mutationQueueIdle: async () => 0, committedVerbCount: () => 0, projectForEgress: (value) => value })", code: body });
  run(1, "same-id", "await hold; writes.push('old completed'); return 'old';");
  await h.running("same-id", 1);
  h.sendControl({ type: "WS_CLOSED", connKey: 1 });
  await h.connect(2);
  run(2, "same-id", "writes.push('new'); return 'new';");
  run(2, "queued", "writes.push('must never run');");
  h.sendFrame(2, { type: "CANCEL", executionId: "queued" });
  release();
  // Runs dequeue in order, so the cancelled one answering means everything before it has run.
  await h.result("same-id", 2);
  await h.result("queued", 2);
  assert.deepEqual(Array.from(h.context.writes), ["old completed", "new"]);
  assert(
    h.sent.some(
      ({ connKey, frame: f }) =>
        f.type === "RUN_STATE" &&
        f.executionId === "same-id" &&
        connKey === 2 &&
        f.phase === "running",
    ),
  );
  assert(
    h.sent.some(({ frame: f }) => f.id === "queued" && String(f.errors).includes("no code was executed")),
  );
});

test("a cancel is answered at once from the phase the run had reached", async () => {
  const h = host();
  await h.connect(1);
  let release!: () => void;
  h.context.hold = new Promise<void>((resolve) => { release = resolve; });
  const preamble = "(host)=>({ flcm: {}, session: host.getSession(() => ({})), warnings: createWarningRegistry(), mutationQueueIdle: async () => 0, committedVerbCount: () => 0, projectForEgress: (value) => value })";
  const run = (id: string, body: string) =>
    h.sendFrame(1, { type: "EXECUTE_CODE", id, preamble, code: body });
  run("executing", "await hold; return 1;");
  run("waiting", "return 2;");
  await h.running("executing", 1);
  // No flush between these and the assertion: the answer must come from state the plugin already
  // holds. The queued run's own refusal can only speak once "executing" finishes — far too late.
  h.sendFrame(1, { type: "CANCEL", executionId: "waiting" });
  h.sendFrame(1, { type: "CANCEL", executionId: "executing" });
  h.sendFrame(1, { type: "CANCEL", executionId: "never-heard-of" });
  assert.deepEqual(
    h.sent.filter(({ frame: f }) => f.type === "CANCEL_RESULT").map(({ connKey, frame: f }) => [f.executionId, f.disposition, connKey]),
    [
      ["waiting", "never-executed", 1],
      ["executing", "was-running", 1],
      ["never-heard-of", "unknown", 1],
    ],
  );
  release();
  await h.result("waiting");
});

const echoPreamble = "(host)=>({ flcm: {}, session: host.getSession(() => ({})), warnings: createWarningRegistry(), mutationQueueIdle: async () => 0, committedVerbCount: () => 0, projectForEgress: (value) => value })";

test("a run is refused before it executes without a grant, or for a document this file isn't stamped with", async () => {
  const h = host();
  await h.introduce(1);
  h.context.writes = [];
  // A fresh session, so the refusal is the grant's: no shared session was opened without one.
  const session = { handle: "fresh-store-never-granted", create: true };
  h.sendFrame(1, { type: "EXECUTE_CODE", id: "ungranted", preamble: echoPreamble, code: "writes.push('bad');", session });
  assert.equal((await h.frame((f) => f.id === "ungranted", "the refusal")).reason, "no-grant");
  await h.allow(1);
  h.sendFrame(1, { type: "EXECUTE_CODE", id: "elsewhere", documentId: OTHER_DOCUMENT_ID, preamble: echoPreamble, code: "writes.push('bad');" });
  assert.equal((await h.frame((f) => f.id === "elsewhere", "the refusal")).reason, "other-document");
  assert.equal(await h.grantStatus(1, "elsewhere-call", "allow", OTHER_DOCUMENT_ID), "other-document");
  assert.equal(h.context.writes.length, 0);
});

test("two calls waiting in one panel each keep their own prompt, click and outcome", async () => {
  const h = host();
  await h.introduce(1);
  assert.equal(await h.grantStatus(1, "call-one", "allow"), "pending");
  assert.equal(await h.grantStatus(1, "call-two", "allow"), "pending");
  const both = await h.render((r) => r.prompts.length === 2, "both calls' prompts");
  assert.deepEqual(JSON.parse(JSON.stringify(both.prompts.map((p) => p.executionId).sort())), ["call-one", "call-two"]);
  // Denying one call leaves the other waiting; its own Allow then grants.
  h.sendControl({ type: "UI_DECISION", approve: false, connKey: 1, executionId: "call-one", documentId: DOCUMENT_ID });
  assert.equal(await h.grantStatus(1, "call-one", "allow"), "denied");
  assert.equal(await h.grantStatus(1, "call-two", "allow"), "pending");
  // A pick is one call's too, and grants nothing.
  assert.equal(await h.grantStatus(1, "call-three", "pick"), "pending");
  h.sendControl({ type: "UI_PICK", connKey: 1, executionId: "call-three", documentId: DOCUMENT_ID });
  assert.equal(await h.grantStatus(1, "call-three", "pick"), "picked");
  assert.equal(await h.grantStatus(1, "call-two", "none"), "absent");
  await h.allow(1, "call-two");
  assert.equal(await h.grantStatus(1, "call-two", "allow"), "granted");
  // The denial was the first call's alone: the next call is asked afresh.
  assert.equal(await h.grantStatus(1, "call-one-retried", "none"), "granted");
});

test("a grant covers every server of its project on this file, and its revoke stops all of them", async () => {
  const h = host();
  await h.connect(1, "/proj");
  // A second server in the same project is granted with no click; one in another project is not.
  await h.introduce(2, "/proj");
  await h.introduce(3, "/other");
  assert.equal(await h.grantStatus(2, "sibling", "none"), "granted");
  assert.equal(await h.grantStatus(3, "elsewhere", "none"), "absent");
  h.sendFrame(2, { type: "EXECUTE_CODE", id: "shared", preamble: echoPreamble, code: "return 'ran';" });
  assert.equal((await h.result("shared", 2)).result, "ran");

  h.sendControl({ type: "UI_REVOKE", credentialId: CREDENTIAL.id, project: "/proj" });
  for (const key of [1, 2])
    await h.frame((f, connKey) => connKey === key && f.type === "GRANT_CHANGED" && f.granted === false, `the revoke for ${key}`);
  h.sendFrame(2, { type: "EXECUTE_CODE", id: "after", preamble: echoPreamble, code: "return 'ran';" });
  assert.equal((await h.frame((f) => f.id === "after", "the refusal")).type, "NOT_GRANTED");
  // The grant is one record per project and document, and the revoke removed it.
  assert(![...h.storage.keys()].some((key) => key.startsWith("code-mode:document-grant:")));
});

test("a granted server's write waits out another server's Allow being saved instead of re-prompting", async () => {
  let saving: Promise<void> = Promise.resolve();
  const storage = pairedStorage();
  const h = host({}, storage);
  await h.connect(1);
  await h.introduce(2, "/other");
  const setAsync = h.context.figma.clientStorage.setAsync;
  let landed!: () => void;
  saving = new Promise((resolve) => { landed = resolve; });
  h.context.figma.clientStorage.setAsync = async (key: string, value: unknown) => {
    await saving;
    return setAsync(key, value);
  };
  assert.equal(await h.grantStatus(2, "other-call", "allow"), "pending");
  h.sendControl({ type: "UI_DECISION", approve: true, connKey: 2, executionId: "other-call", documentId: DOCUMENT_ID });
  h.sendFrame(1, { type: "EXECUTE_CODE", id: "run", preamble: echoPreamble, code: "return 'ran';" });
  landed();
  assert.equal((await h.result("run", 1)).result, "ran");
  assert(!h.sent.some(({ frame: f, connKey }) => connKey === 1 && f.type === "NOT_GRANTED"));
});

test("a file is stamped once and keeps its stamp and grant across plugin runs; a copy shares both until given its own", async () => {
  const storage = pairedStorage();
  const pluginData = new Map<string, string>();
  const first = host({}, storage, pluginData);
  const introduced = (await first.introduce(1)).document as { kind: string; documentId: string; fileName: string };
  assert.equal(introduced.kind, "identified");
  assert.match(introduced.documentId, /^[0-9a-hjkmnp-tv-z]{16}$/);
  assert.equal(introduced.fileName, "Test file");
  const documentId = introduced.documentId;
  await first.allow(1, "first-allow", documentId);
  // The next plugin run in this file reads the same stamp, and the grant is still there.
  const next = host({}, storage, pluginData);
  assert.equal(((await next.introduce(1)).document as { documentId: string }).documentId, documentId);
  assert.equal(await next.grantStatus(1, "after-restart", "none", documentId), "granted");
  // A duplicate carries the stamp, so it shares the grant until the human gives it its own identity.
  const duplicate = host({}, storage, new Map(pluginData));
  await duplicate.introduce(1);
  assert.equal(await duplicate.grantStatus(1, "copy", "none", documentId), "granted");
  duplicate.sendControl({ type: "UI_RESTAMP" });
  const reported = await duplicate.frame((f) => f.type === "DOCUMENT_REPORTED", "the copy's new identity");
  const restamped = (reported.document as { documentId: string }).documentId;
  assert.notEqual(restamped, documentId);
  assert.equal(await duplicate.grantStatus(1, "copy-after", "none", restamped), "absent");
  duplicate.sendFrame(1, { type: "EXECUTE_CODE", id: "old-id", documentId, preamble: echoPreamble, code: "return 'ran';" });
  assert.equal((await duplicate.frame((f) => f.id === "old-id", "the refusal")).reason, "other-document");
  // The original keeps its own.
  assert.equal(pluginData.get(DOCUMENT_ID_KEY), documentId);
});

test("a file the plugin can't stamp is reported unidentified and runs nothing", async () => {
  const viewOnly = {
    name: "Shared with me",
    children: [],
    getPluginData: () => "",
    setPluginData: () => {
      throw new Error("Cannot write to a file you can only view");
    },
  };
  const h = host({ root: viewOnly }, pairedStorage(), new Map());
  const introduced = (await h.introduce(1)).document as { kind: string; problem: string };
  assert.equal(introduced.kind, "unidentified");
  assert.match(introduced.problem, /can only view/);
  assert.equal(await h.grantStatus(1, "call", "allow"), "other-document");
});

test("HELLO tells any peer the plugin's versions and nothing else, and a peer can't author the skew toast", async () => {
  const toasts: string[] = [];
  const h = host({ notify: (message: string) => toasts.push(message) });
  h.sendControl({ type: "WS_CONNECTED", connKey: 1 });
  h.sendFrame(1, { type: "HELLO", id: "hello", serverProtocol: 99, message: "Your file is corrupt — visit evil.example" });
  const hello = await h.frame((f) => f.id === "hello", "the HELLO reply");
  assert.deepEqual(Object.keys(hello).sort(), ["id", "pluginVersion", "protocolVersion", "type"]);
  assert.equal(toasts.length, 1);
  assert(!toasts[0].includes("evil.example"));
});

test("a confirmed pairing is stored only by the socket showing its code, and its proof names the plugin owner", async () => {
  const storage = new Map<string, unknown>();
  const h = host({
    currentUser: { id: "figma-user-7", name: "Ada" },
    clientStorage: {
      getAsync: async (key: string) => storage.get(key),
      setAsync: async (key: string, value: unknown) => void storage.set(key, value),
    },
  });
  const pairing = { code: "7QKM-X2D9", credentialId: "credential-id-1", secret: "secret-0123456789abcdef" };
  h.sendControl({ type: "WS_CONNECTED", connKey: 1 });
  h.sendControl({ type: "WS_CONNECTED", connKey: 2 });
  h.sendFrame(1, { type: "PAIRING_OFFER", id: "offer", code: pairing.code, expiresInMs: 60_000 });
  await h.frame((f) => f.id === "offer" && f.type === "PAIRING_OFFER_ACK", "the offer's ack");

  h.sendFrame(2, { type: "PAIR_CONFIRMED", id: "elsewhere", ...pairing });
  assert.equal((await h.frame((f) => f.id === "elsewhere", "the refusal")).type, "ERROR");
  const storesSecret = () => [...storage.values()].includes(pairing.secret);
  assert.equal(storesSecret(), false);
  h.sendFrame(1, { type: "PAIR_CONFIRMED", id: "stored", ...pairing });
  assert.equal((await h.frame((f) => f.id === "stored", "the store's ack")).type, "CREDENTIAL_STORED");
  assert.equal(storesSecret(), true);

  // Another socket of the same installation now proves it too: storage is read on every challenge.
  const nonce = "nonce-0123456789abcdef";
  h.sendFrame(2, { type: "AUTHENTICATE", id: "auth", credentialId: pairing.credentialId, nonce });
  const proof = await h.frame((f) => f.id === "auth", "the link proof");
  assert.equal(proof.type, "LINK_PROOF");
  const expected = createHmac("sha256", pairing.secret).update(linkProofMessage(pairing.credentialId, nonce)).digest("hex");
  assert.equal(proof.proof, expected);
  assert.deepEqual({ ...(proof.owner as object) }, { figmaUserId: "figma-user-7", name: "Ada" });
});

test("an unauthenticated socket learns nothing about the file and can't open a prompt", async () => {
  const h = host();
  h.sendControl({ type: "WS_CONNECTED", connKey: 9 });
  for (const request of [
    { type: "INTRODUCE", project: "/proj", framelinkOrigin: "https://app.framelink.ai" },
    { type: "GRANT_STATUS", executionId: "forged", documentId: DOCUMENT_ID, prompt: "allow" },
  ])
    assert.equal((await h.ask(9, request)).type, "ERROR");
  assert(!h.sent.some(({ connKey, frame: f }) => connKey === 9 && f.type === "DOCUMENT_REPORTED"));
  assert(!h.renders.some((r) => r.prompts.length > 0));
});

test("a grant revoked in another instance while no server was connected is read afresh when a server returns", async () => {
  const h = host();
  await h.connect(1);
  h.sendControl({ type: "WS_CLOSED", connKey: 1 });
  // Another instance of the plugin revoked it, and no connected server relayed the change.
  for (const key of [...h.storage.keys()]) if (key.startsWith("code-mode:document-grant:")) h.storage.delete(key);
  await h.introduce(2);
  assert.equal(await h.grantStatus(2, "stale-call", "none"), "absent");
  h.sendFrame(2, { type: "EXECUTE_CODE", id: "stale", preamble: echoPreamble, code: "return 'ran';" });
  assert.equal((await h.frame((f) => f.id === "stale", "the refusal")).type, "NOT_GRANTED");
});

/**
 * The real relay (ui.ts) in a vm, dialing fake sockets. `opened(port)` is the socket the relay last
 * dialed on that port; `reconnect` runs the relay's pending redials, which a real timer would.
 */
function relay(toHost: (inbound: unknown) => void) {
  class Socket {
    static OPEN = 1;
    readyState = 1;
    frames: string[] = [];
    port: number;
    onopen = () => {};
    onclose = () => {};
    onmessage = (_event: { data: string }) => {};
    constructor(url: string) {
      this.port = Number(url.split(":").at(-1));
      dialed.push(this);
    }
    send(raw: string) {
      this.frames.push(raw);
    }
  }
  const dialed: Socket[] = [];
  const redials: (() => void)[] = [];
  const element = () => ({ setAttribute() {}, appendChild() {}, style: {} });
  const context = vm.createContext({
    WebSocket: Socket,
    parent: { postMessage: (msg: { pluginMessage: unknown }) => toHost(msg.pluginMessage) },
    window: {},
    document: { getElementById: element, createElement: element },
    setTimeout: (callback: () => void) => redials.push(callback),
    requestAnimationFrame() {},
    console,
  });
  vm.runInContext(uiScript, context);
  return {
    opened: (port: number) => dialed.filter((socket) => socket.port === port).at(-1)!,
    reconnect: () => redials.splice(0).forEach((callback) => callback()),
    fromHost: (outbound: unknown) => context.window.onmessage({ data: { pluginMessage: outbound } }),
  };
}

test("the relay routes a frame only to the socket generation it belongs to", () => {
  const forwarded: Array<{ from: string; connKey?: number; control?: { connKey?: number }; frame?: { type?: string } }> = [];
  const ui = relay((inbound) => forwarded.push(inbound as (typeof forwarded)[number]));
  const old = ui.opened(9876);
  old.onopen();
  const oldKey = forwarded.at(-1)!.control!.connKey!;
  old.onclose();
  ui.reconnect();
  const next = ui.opened(9876);
  assert.notEqual(next, old);
  next.onopen();
  const newKey = forwarded.at(-1)!.control!.connKey!;
  assert.notEqual(oldKey, newKey);
  // A late reply for the closed generation is dropped, never sent on whatever replaced it.
  ui.fromHost({ to: "server", connKey: oldKey, frame: { type: "EXECUTE_CODE_RESULT", id: "same-id" } });
  old.onmessage({ data: JSON.stringify({ type: "CANCEL", executionId: "same-id" }) });
  assert.equal(next.frames.length, 0);
  assert(!forwarded.some((f) => f.frame?.type === "CANCEL"));
  ui.fromHost({ to: "server", connKey: newKey, frame: { type: "EXECUTE_CODE_RESULT", id: "same-id", result: "new" } });
  assert.deepEqual(JSON.parse(next.frames[0]), { type: "EXECUTE_CODE_RESULT", id: "same-id", result: "new" });
});

test("a server frame can never act as the human's panel input", async () => {
  const h = host({ openExternal: () => { throw new Error("a server opened the browser"); } });
  // The real relay, feeding the real host: whatever ui.ts posts is what code.ts dispatches on.
  const ui = relay((inbound) => h.context.figma.ui.onmessage(inbound));
  // The relay numbers socket generations in open order, from 1.
  const socket = ui.opened(9876);
  socket.onopen();
  const fromServer = (frame: Record<string, unknown>) => socket.onmessage({ data: JSON.stringify(frame) });
  fromServer({ type: "AUTHENTICATE", id: "auth", credentialId: CREDENTIAL.id, nonce: "nonce-rogue-000" });
  await h.frame((f) => f.id === "auth", "the link proof");
  fromServer({ type: "INTRODUCE", id: "intro", project: "/rogue", framelinkOrigin: "https://evil.example" });
  fromServer({ type: "GRANT_STATUS", id: "ask", executionId: "rogue-call", documentId: DOCUMENT_ID, prompt: "allow" });
  await h.frame((f) => f.id === "ask", "the rogue call's prompt");
  // Everything a panel click would say, spoken by the server instead — in every envelope spelling.
  const decision = { approve: true, connKey: 1, executionId: "rogue-call", documentId: DOCUMENT_ID };
  fromServer({ type: "UI_DECISION", ...decision });
  fromServer({ from: "panel", control: { type: "UI_DECISION", ...decision } });
  fromServer({ type: "UI_PICK", ...decision });
  fromServer({ type: "UI_RESTAMP" });
  fromServer({ type: "UI_SIGN_IN" });
  fromServer({ type: "UI_OPEN_SIGN_IN" });
  // A barrier: a genuine Allow on a second server. Grant changes land in order, so once its grant is
  // announced, any Allow a forged frame had started would have landed before it.
  const second = ui.opened(9877);
  second.onopen();
  await h.introduce(2, "/real");
  await h.allow(2);
  fromServer({ type: "GRANT_STATUS", id: "status", executionId: "rogue-call", documentId: DOCUMENT_ID, prompt: "none" });
  assert.equal((await h.frame((f) => f.id === "status", "the status")).state, "absent");
  assert(!h.sent.some(({ frame: f }) => f.type === "WRITE_ACCESS_SIGN_IN" || f.type === "DOCUMENT_REPORTED"));
  assert.equal(h.pluginData.get(DOCUMENT_ID_KEY), DOCUMENT_ID);
});

test("the browser opens a sign-in page only on the Framelink origin the server announced", async () => {
  const opened: string[] = [];
  const h = host({ openExternal: (url: string) => opened.push(url) });
  await h.connect(1);
  const signIn = (verificationUri: string) => {
    h.sendControl({ type: "UI_SIGN_IN", connKey: 1 });
    h.sendFrame(1, { type: "WRITE_ACCESS", id: `notice-${verificationUri}`, notice: { kind: "sign-in-pending", userCode: "ABCD", verificationUri } });
  };
  signIn("https://app.framelink.ai.evil.example/device");
  signIn("https://evil.example/?https://app.framelink.ai/");
  signIn("https://app.framelink.ai@evil.example/device");
  signIn("https://app.framelink.ai/device?user_code=ABCD");
  assert.deepEqual(opened, ["https://app.framelink.ai/device?user_code=ABCD"]);
});

test("the result and each console line leave the run through the preamble's egress, once each", async () => {
  const h = host();
  await h.connect(1);
  h.sendFrame(1, {
    type: "EXECUTE_CODE", id: "projection",
    preamble: `(host) => ({
      flcm: {}, session: host.getSession(() => ({})), warnings: createWarningRegistry(),
      mutationQueueIdle: async () => 0, committedVerbCount: () => 0,
      projectForEgress: (value, channel) => channel === "console" ? value.map((arg) => "egress:" + arg) : { egress: value },
    })`,
    code: `console.log("a", "b"); return "returned";`,
  });
  const reply = await h.result("projection");
  assert.equal(reply.errors, null);
  assert.deepEqual({ ...reply.result }, { egress: "returned" });
  assert.deepEqual([...reply.console], ["[log] egress:a egress:b"]);
});

const realPreamble = import("./preamble/index.mjs").then(m => m.buildSandboxPreamble());
async function execute(h: ReturnType<typeof host>, body: string, key = 1) {
  const id = `execute-${h.sent.length}`;
  h.sendFrame(key, { type: "EXECUTE_CODE", id, preamble: await realPreamble, code: body });
  return (await h.result(id)) as { id: string; result: any; errors: string | null; console: string[] };
}

test("session identity, snapshots and last survive fresh calls, reconnects and pages but not plugin runs", async () => {
  const h = host();
  await h.connect(1);
  let result = await execute(h, `
    const local = { children: [{ name: "snapshot" }] };
    session.screen = local;
    local.children[0].name = "outside";
    globalThis.observedSession = session;
    return { large: session.screen };
  `);
  assert.equal(result.errors, null);
  h.sendControl({ type: "WS_CLOSED", connKey: 1 });
  await h.connect(2);
  h.context.figma.currentPage = { name: "another page" };
  result = await execute(h, `
    return [session === observedSession, typeof local, session.screen.children[0].name, session.last.large.children[0].name];
  `, 2);
  assert.equal(result.errors, null);
  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), [true, "undefined", "snapshot", "snapshot"]);
  result = await execute(h, `session.saved = 7; throw new Error("failure");`, 2);
  assert.match(result.errors!, /failure/);
  result = await execute(h, `return [session.saved, session.last[0]];`, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), [7, true]);
  await execute(h, `session.saved = 8;`, 2);
  result = await execute(h, `return session.last === undefined;`, 2);
  assert.equal(result.result, true);
  const reopened = host();
  await reopened.connect(1);
  result = await execute(reopened, `return Object.keys(session);`);
  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), []);
});

test("each handle has its own session; a handle not held for this project, or minted twice, is refused unrun", async () => {
  const h = host();
  await h.connect(1);
  await h.connect(2, "/other-project");
  const preamble = await realPreamble;
  const run = (key: ConnKey, id: string, handle: string, create: boolean, body: string) => {
    h.sendFrame(key, { type: "EXECUTE_CODE", id, preamble, code: body, session: { handle, create } });
    return h.frame((f) => f.id === id, `the reply to ${id}`);
  };
  assert.equal((await run(1, "a1", "alpha-agent-one-store", true, `session.mine = "a"; return "from a";`)).errors, null);
  assert.equal((await run(1, "b1", "bravo-agent-two-store", true, `session.mine = "b"; return "from b";`)).errors, null);
  const resumed = await run(1, "a2", "alpha-agent-one-store", false, `return [session.mine, session.last];`);
  assert.deepEqual(JSON.parse(JSON.stringify(resumed.result)), ["a", "from a"]);

  h.context.ran = false;
  const refused = [
    await run(1, "unknown", "never-minted-this-handle", false, `globalThis.ran = true;`),
    await run(2, "elsewhere", "bravo-agent-two-store", false, `globalThis.ran = true;`),
    await run(2, "taken", "bravo-agent-two-store", true, `globalThis.ran = true;`),
  ];
  assert.deepEqual(refused.map((f) => f.type), ["SESSION_NOT_FOUND", "SESSION_NOT_FOUND", "SESSION_HANDLE_TAKEN"]);
  assert.equal(h.context.ran, false);
  assert.equal((await h.ask(1, { type: "SESSION_LOOKUP", handle: "bravo-agent-two-store" })).held, true);
  assert.equal((await h.ask(2, { type: "SESSION_LOOKUP", handle: "bravo-agent-two-store" })).held, false);
});

test("session rejects request plumbing and alias attacks at every write boundary", async () => {
  const h = host();
  await h.connect(1);
  const result = await execute(h, `
    session.tree = { children: [] };
    const rejects = [];
    const attempt = fn => { try { fn(); rejects.push(false); } catch (e) { rejects.push(e.message.includes("plain data")); } };
    attempt(() => session.bad = flcm);
    attempt(() => session.tree.children.push({ hidden: () => flcm.get("1:1") }));
    attempt(() => Object.defineProperty(session.tree, "bad", { get: () => flcm }));
    attempt(() => Object.setPrototypeOf(session.tree, { bad: flcm }));
    attempt(() => session.bad = new Map());
    attempt(() => session.bad = Promise.resolve(1));
    attempt(() => session.bad = { get hidden() { throw new Error("getter must not run"); } });
    attempt(() => session.bad = { [Symbol()]: flcm });
    attempt(() => session.bad = { id: "1:1", type: "FRAME", removed: false });
    attempt(() => session.tree.loop = session);
    attempt(() => Object.freeze(session));
    const alias = { nested: {} };
    session.safe = alias;
    alias.nested.bad = flcm;
    session.tree.children.push({ name: "a" }, { name: "b" });
    session.tree.children.unshift(session.tree.children.pop());
    return { rejects, safe: session.safe, order: session.tree.children.map(n => n.name) };
  `);
  assert.equal(result.errors, null);
  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), {
    rejects: Array(11).fill(true), safe: { nested: {} }, order: ["b", "a"],
  });
});

test("last retains the value the code returned, not its egress copy", async () => {
  const h = host();
  await h.connect(1);
  const preamble = `(host) => ({
    flcm: { read: { id: "v", type: "VECTOR", d: "M0 0 L1 1" } }, session: host.getSession(() => ({})),
    warnings: createWarningRegistry(), mutationQueueIdle: async () => 0, committedVerbCount: () => 0,
    projectForEgress: (value, channel) => channel === "console" ? value : { projected: true },
  })`;
  h.sendFrame(1, { type: "EXECUTE_CODE", id: "first", preamble, code: `return { nested: [flcm.read] };` });
  assert.deepEqual({ ...(await h.result("first")).result }, { projected: true });
  h.sendFrame(1, { type: "EXECUTE_CODE", id: "next", preamble, code: `console.log(session.last.nested[0].d);` });
  assert.equal((await h.result("next")).errors, null);
  assert.deepEqual([...h.sent.find(({ frame: f }) => f.id === "next")!.frame.console as string[]], ["[log] M0 0 L1 1"]);
});

test("two calls reorder and re-append a stored tree while preserving live ids", async () => {
  const { createFigmaMock } = await import("../harness/figma-mock.mjs");
  const figma = createFigmaMock();
  const h = host(figma);
  await h.connect(1);
  const first = await execute(h, `
    const root = await flcm.render({ type: "FRAME", width: 300, height: 300 });
    session.root = root.id;
    const screen = { type: "FRAME", width: 200, height: 200, children: [
      { type: "TEXT", text: "First" }, { type: "TEXT", text: "Second" }
    ] };
    session.screen = await flcm.append(root, screen);
    return session.screen;
  `);
  assert.equal(first.errors, null);
  const before = first.result;
  const second = await execute(h, `
    session.screen.children.unshift(session.screen.children.pop());
    session.screen = await flcm.append(session.root, session.screen);
    return session.screen;
  `);
  assert.equal(second.errors, null);
  assert.equal(second.result.id, before.id);
  const expected = [before.children[1].id, before.children[0].id];
  assert.deepEqual(Array.from(second.result.children, (n: any) => n.id), expected);
  const live = await figma.getNodeByIdAsync(before.id);
  assert.deepEqual(live.children.map((n: any) => n.id), expected);
  const promoted = await execute(h, `session.screen = await flcm.component(session.screen); return session.screen.id;`);
  assert.equal(promoted.errors, null);
  const read = await execute(h, `return (await flcm.get(session.screen)).node.id;`);
  assert.equal(read.errors, null);
  assert.equal(read.result, promoted.result);
});

test("a raw figma write counts even when its change event lands after the reply", async () => {
  const h = host();
  await h.connect(1);
  const changedLate = (id: string) => h.sent.some(({ frame: f }) => f.type === "RUN_CHANGED" && f.executionId === id);
  const read = await execute(h, `return 1;`) as any;
  assert.equal(read.documentChanged, false);
  // Someone else in the file edits while this run is being watched: not this run's Write.
  const remote = await execute(h, `figma.simulateRemoteEdit(); return 1;`) as any;
  h.deliverChanges();
  assert.equal(remote.documentChanged, false);
  assert.equal(changedLate(remote.id), false);
  // No flcm verb at all: the agent went straight to the Figma API, and Figma reports it only after
  // the reply went out. The listener posts RUN_CHANGED as the event is delivered.
  const raw = await execute(h, `figma.createRectangle(); return "done";`) as any;
  assert.equal(raw.errors, null);
  assert.equal(raw.documentChanged, false);
  h.deliverChanges();
  assert.equal(changedLate(raw.id), true);
  assert.equal(changedLate(read.id), false);
  // A watch that closed clean says so, ending the server's wait; the next run's start closes it.
  const settled = (id: string) => h.sent.some(({ frame: f }) => f.type === "RUN_SETTLED" && f.executionId === id);
  assert.equal(settled(read.id), true);
  assert.equal(settled(raw.id), false);
});

test("revoking a project's grant cancels its runs: a queued one never starts, a suspended server call is abandoned", async () => {
  const { createFigmaMock } = await import("../harness/figma-mock.mjs");
  const h = host(createFigmaMock());
  await h.connect(1);
  const running = execute(h, `await flcm.render({ type: "RECTANGLE", width: 10, height: 10, fill: flcm.image("asset.png") }); globalThis.resumed = true;`);
  await h.frame((f) => f.type === "CHANNEL_REQUEST", "a channel request");
  h.sendFrame(1, { type: "EXECUTE_CODE", id: "queued", preamble: await realPreamble, code: "globalThis.queuedRan = true;" });
  h.sendControl({ type: "UI_REVOKE", credentialId: CREDENTIAL.id, project: "/proj" });
  assert.match((await running).errors!, /revoked this project's grant/);
  assert.match((await h.result("queued")).errors, /revoked this project's grant .* no code was executed/);
  assert.equal(h.context.resumed, undefined);
  assert.equal(h.context.queuedRan, undefined);
});

test("a verb that lands after the code returns still changes the document", async () => {
  const { createFigmaMock } = await import("../harness/figma-mock.mjs");
  const h = host(createFigmaMock());
  await h.connect(1);
  // Never awaited: the render lands during the host's drain, after the agent's code returned.
  const written = await execute(h, `flcm.render({ type: "FRAME", width: 20, height: 20 }); return "done";`) as any;
  assert.equal(written.errors, null);
  assert.equal(written.documentChanged, true);
});

test("queued calls observe completed session writes and cancelled queued calls cannot change last", async () => {
  const h = host();
  await h.connect(1);
  let release!: () => void;
  h.context.hold = new Promise<void>(resolve => { release = resolve; });
  const preamble = await realPreamble;
  const send = (id: string, code: string) => h.sendFrame(1, { type: "EXECUTE_CODE", id, preamble, code });
  send("first", `session.count = 1; await hold; session.count++; return session.count;`);
  send("cancelled", `session.count = 100; return 100;`);
  h.sendFrame(1, { type: "CANCEL", executionId: "cancelled" });
  const next = execute(h, `return [session.count, session.last];`);
  release();
  const result = await next;
  assert.equal(result.errors, null);
  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), [2, 2]);
});

test("last snapshots session-owned returns and permits returning the session itself", async () => {
  const h = host();
  await h.connect(1);
  const first = await execute(h, `session.tree = { name: "before" }; return session.tree;`);
  assert.equal(first.errors, null);
  const second = await execute(h, `session.tree.name = "after"; return session;`);
  assert.equal(second.errors, null);
  assert.deepEqual(JSON.parse(JSON.stringify(second.result)), {
    tree: { name: "after" }, last: { name: "before" },
  });
  const third = await execute(h, `session.tree.name = "newer"; return session.last.tree.name;`);
  assert.equal(third.errors, null);
  assert.equal(third.result, "after");
});

test("a non-storable return succeeds and clears last", async () => {
  const h = host();
  await h.connect(1);
  await execute(h, `return { previous: true };`);
  const returned = await execute(h, `return { ok: 1, fn: () => 1 };`);
  assert.equal(returned.errors, null);
  assert.deepEqual(JSON.parse(JSON.stringify(returned.result)), { ok: 1, fn: "[Function fn]" });
  const next = await execute(h, `return session.last === undefined;`);
  assert.equal(next.errors, null);
  assert.equal(next.result, true);
});

test("a write queued behind a rejected batch lands before the reply, and the reply names it", async () => {
  const { createFigmaMock } = await import("../harness/figma-mock.mjs");
  const figma = createFigmaMock();
  const h = host(figma);
  await h.connect(1);
  // The only moment that matters: what the canvas held when the result went out. That reply is what
  // the agent screenshots and reasons against, so a write still in flight there is invisible damage.
  let survivorAtReply: boolean | undefined;
  const post = h.context.figma.ui.postMessage;
  h.context.figma.ui.postMessage = (msg: Record<string, unknown>) => {
    if ((msg.frame as Frame | undefined)?.type === "EXECUTE_CODE_RESULT" && survivorAtReply === undefined) {
      survivorAtReply = h.context.figma.currentPage.children.some(
        (n: { name: string }) => n.name === "QUEUED-SURVIVOR",
      );
    }
    return post(msg);
  };
  const reply = await execute(h, `
    let caught = null;
    try {
      await Promise.all([
        flcm.edit(flcm.id("0:0"), { name: "nope" }),
        flcm.render({ type: "FRAME", name: "QUEUED-SURVIVOR", width: 40, height: 40 }),
      ]);
    } catch (e) { caught = String(e.message || e); }
    return { caught };
  `);
  assert.equal(reply.errors, null);
  assert.notEqual(reply.result.caught, null);
  assert.equal(survivorAtReply, true);
  const warning = (reply as unknown as { console: string[] }).console.find(line =>
    line.includes("finished after your code returned"),
  );
  assert.match(warning ?? "", /1 write\(s\)/);
});

test("a runtime stored past its reply refuses to write or read", async () => {
  const { createFigmaMock } = await import("../harness/figma-mock.mjs");
  const figma = createFigmaMock();
  const h = host(figma);
  await h.connect(1);
  const first = await execute(h, `
    globalThis.staleFlcm = flcm;
    session.rootId = (await flcm.render({ type: "FRAME", width: 40, height: 40 })).id;
    return "stashed";
  `);
  assert.equal(first.errors, null);
  const second = await execute(h, `
    const refusals = {};
    try { await staleFlcm.render({ type: "FRAME", name: "STALE-WRITE", width: 10, height: 10 }); }
    catch (e) { refusals.write = String(e.message || e); }
    try { await staleFlcm.get(session.rootId); }
    catch (e) { refusals.read = String(e.message || e); }
    return refusals;
  `);
  assert.equal(second.errors, null);
  assert.match(second.result.write, /already finished and replied/);
  assert.match(second.result.read, /already finished and replied/);
  assert.equal(
    h.context.figma.currentPage.children.some((n: { name: string }) => n.name === "STALE-WRITE"),
    false,
  );
});

test("stored objects support ordinary Object methods without invoking inherited setters", async () => {
  const h = host();
  await h.connect(1);
  const result = await execute(h, `
    session.screen = { x: 1, nested: {} };
    session.screen.__proto__ = { injected: true };
    return [session.hasOwnProperty("screen"), session.screen.hasOwnProperty("x"),
      session.screen.nested.toString(), session.screen.injected === undefined,
      session.screen.hasOwnProperty("__proto__")];
  `);
  assert.equal(result.errors, null);
  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), [true, true, "[object Object]", true, true]);
});

test("node warnings follow extracted children, reads and measures; only unseen records reach the summary", async () => {
  const { createFigmaMock } = await import("../harness/figma-mock.mjs");
  const h = host(createFigmaMock());
  await h.connect(1);
  const reply = await execute(h, `
    const r = await flcm.render({ type: "FRAME", width: 100, height: 100, children: [
      { type: "VECTOR", d: "M15 18 L9 12 L15 6", width: 24, height: 24 },
      { type: "VECTOR", d: "M0 0 L8 0 L0 8 Z", width: 20 }
    ] });
    console.log(r.children[0]);
    console.warn("agent warning");
    return { own: { id: r.children[1].id }, first: await flcm.measure(r.children[0]) };
  `) as any;
  assert.equal(reply.errors, null);
  assert.deepEqual(Array.from(reply.result.first.warnings, (r: any) => [r.prop, r.authored, r.realized]), [["width", 24, 6], ["height", 24, 12]]);
  const logged = JSON.parse(reply.console.find((line: string) => line.startsWith("[log] ")).slice(6));
  assert.equal(logged.warnings.length, 2);
  const summaries = reply.console.filter((line: string) => line.startsWith("[warn]"));
  assert.equal(summaries.length, 2);
  assert.ok(summaries.includes("[warn] agent warning"));
  assert.ok(summaries.some((line: string) => line.includes(reply.result.own.id) && line.includes("authored 20")));
});

test("full get projections retain node warnings through SVG collapse", async () => {
  const { createFigmaMock } = await import("../harness/figma-mock.mjs");
  const h = host(createFigmaMock());
  await h.connect(1);
  const reply = await execute(h, `
    const r = await flcm.render({ type: "VECTOR", d: "M0 0 L8 0 L0 8 Z", width: 24 });
    return await flcm.get(r);
  `) as any;
  assert.equal(reply.errors, null);
  assert.equal(reply.result.node.type, "IMAGE-SVG");
  assert.equal(reply.result.node.warnings[0].realized, 8);
  assert.equal(reply.console.length, 0);
});

test("a warning after an earlier echo is still reported, and diagnostics do not persist into the next run", async () => {
  const { createFigmaMock } = await import("../harness/figma-mock.mjs");
  const h = host(createFigmaMock());
  await h.connect(1);
  const reply = await execute(h, `
    const r = await flcm.render({ type: "FRAME", width: 100, height: 100, layout: { mode: "row" } });
    console.log(r);
    await flcm.edit(r, { width: 50, minWidth: 80 });
  `) as any;
  assert.equal(reply.errors, null);
  assert.ok(reply.console.some((line: string) => line.includes("authored 50, realized 80")));
  const next = await execute(h, "return await flcm.get(figma.currentPage.children[0].id);") as any;
  assert.equal(next.errors, null);
  assert.equal(next.result.node.warnings, undefined);
  assert.equal(next.console.length, 0);
});

test("failed serialization does not suppress warnings", async () => {
  const { createFigmaMock } = await import("../harness/figma-mock.mjs");
  const h = host(createFigmaMock());
  await h.connect(1);
  const reply = await execute(h, `
    const r = await flcm.render({ type: "VECTOR", d: "M0 0 L8 0 L0 8 Z", width: 24 });
    const cyclic = { r }; cyclic.self = cyclic;
    return cyclic;
  `) as any;
  assert.match(reply.errors, /cyclic/);
  assert.equal(reply.console.filter((line: string) => line.startsWith("[warn]")).length, 1);
});

test("echoing an overflowing parent keeps the pair warning in the summary", async () => {
  const { createFigmaMock } = await import("../harness/figma-mock.mjs");
  const h = host(createFigmaMock());
  await h.connect(1);
  const reply = await execute(h, `return await flcm.render({ type: "FRAME", name: "Header", width: 100, height: 100,
    children: [{ type: "RECTANGLE", name: "Scrim", width: 200, height: 100 }] });`) as any;
  assert.equal(reply.errors, null);
  assert.equal(reply.result.warnings, undefined);
  assert.equal(reply.result.children[0].warnings, undefined);
  assert.match(reply.console[0], /"Scrim" overflows .*"Header" by 100px on x; the parent does not clip/);
});

test("a rolled-back vector creation publishes no provisional divergences", async () => {
  const { createFigmaMock } = await import("../harness/figma-mock.mjs");
  const h = host(createFigmaMock());
  h.context.figma.createRectangle = () => { throw new Error("creation failed"); };
  await h.connect(1);
  const reply = await execute(h, `return await flcm.render({ type: "FRAME", children: [
    { type: "VECTOR", d: "M0 0 L8 0 L0 8 Z", width: 24 }, { type: "RECTANGLE" }
  ] });`) as any;
  assert.match(reply.errors, /creation failed/);
  assert.equal(reply.console.length, 0);
});

test("agent scope cannot name the host or raw server channel", async () => {
  const h = host();
  await h.connect(1);
  const reply = await execute(h, `return {
    factoryHost: typeof __flcmHost,
    localHost: typeof host,
    transport: typeof callServer,
    publicTransport: typeof flcm.callServer,
    sessionTransport: typeof session.callServer,
    globalHost: typeof globalThis.__flcmHost,
    hostFunction: typeof executeCode,
  };`);
  assert.equal(reply.errors, null);
  assert.deepEqual(JSON.parse(JSON.stringify(reply.result)), {
    factoryHost: "undefined", localHost: "undefined", transport: "undefined",
    publicTransport: "undefined", sessionTransport: "undefined", globalHost: "undefined",
    hostFunction: "undefined",
  });
});

test("image adapter round-trips over the opaque channel and refuses wrong-connection replies", async () => {
  const { createFigmaMock } = await import("../harness/figma-mock.mjs");
  const h = host(createFigmaMock());
  await h.connect(1);
  const result = execute(h, `return await flcm.render({ type: "RECTANGLE", width: 10, height: 10, fill: flcm.image("asset.png") });`);
  const request = await h.frame((f) => f.type === "CHANNEL_REQUEST", "a channel request");
  assert.equal(request.capability, "images.fetch");
  assert.equal(JSON.stringify(request.payload), '["asset.png"]');
  // Had the wrong connection's failure been taken, the run would reject with it; that the right
  // connection's answer still completes it cleanly is the proof it was refused.
  h.sendFrame(2, { type: "CHANNEL_RESPONSE", id: request.id, ok: false, error: "wrong connection" });
  h.sendFrame(1, { type: "CHANNEL_RESPONSE", id: request.id, ok: true, payload: { "asset.png": "Ynl0ZXM=" } });
  assert.equal((await result).errors, null);
});

test("server refusals reject the suspended image await", async () => {
  const { createFigmaMock } = await import("../harness/figma-mock.mjs");
  const h = host(createFigmaMock());
  await h.connect(1);
  const result = execute(h, `await flcm.render({ type: "RECTANGLE", width: 10, height: 10, fill: flcm.image("asset.png") }); globalThis.resumed = true;`);
  const request = await h.frame((f) => f.type === "CHANNEL_REQUEST", "a channel request");
  h.sendFrame(1, { type: "CHANNEL_RESPONSE", id: request.id, ok: false, error: "run no longer active" });
  assert.match((await result).errors!, /run no longer active/);
  assert.equal(h.context.resumed, undefined);
});

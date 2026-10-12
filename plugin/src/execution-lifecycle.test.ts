/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { createWarningRegistry } from "./preamble/warnings.js";
import { TOKEN_ENTRY_MARK } from "./preamble/token-mark.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const code = buildSync({
  entryPoints: [new URL("./code.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "iife",
}).outputFiles[0].text;
type Frame = Record<string, unknown>;
// Tests wait on what the plugin SAYS, never on elapsed time or a count of event-loop turns: the host's
// reply path crosses real timers (document-changes.ts settles one task), so "N turns later" is a race.
// The deadline only turns a missing frame into a readable failure instead of a hung run.
const FRAME_DEADLINE_MS = 5_000;
function host(native: Record<string, unknown> = {}) {
  const frames: Frame[] = [];
  const waiters = new Set<{ match: (f: Frame) => boolean; resolve: (f: Frame) => void }>();
  const record = (msg: Frame) => {
    frames.push(msg);
    for (const waiter of waiters) {
      if (!waiter.match(msg)) continue;
      waiters.delete(waiter);
      waiter.resolve(msg);
    }
  };
  /** The first frame, already sent or still to come, that matches. */
  const frame = (match: (f: Frame) => boolean, what = "an expected frame"): Promise<Frame> => {
    const seen = frames.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`the plugin never sent ${what}`)), FRAME_DEADLINE_MS).unref();
      waiters.add({ match, resolve: (f) => { clearTimeout(deadline); resolve(f); } });
    });
  };
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
    root: { children: [page] },
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
    clientStorage: { getAsync: async () => [], setAsync: async () => {} },
    ...native,
    ui: {
      postMessage: record,
      onmessage: (_inbound: Record<string, unknown>) => {},
      resize() {},
    },
  };
  // Unref'd so a run's minute-long late-change watch can't hold the test process open after it ends.
  const hostSetTimeout = (callback: () => void, ms?: number) => setTimeout(callback, ms).unref();
  const context = vm.createContext({ createWarningRegistry, figma, __html__: "", console: { ...console }, setTimeout: hostSetTimeout, clearTimeout });
  vm.runInContext(code, context);
  // Stands in for ui.html, which posts the panel's input and server frames in separate envelopes.
  const send = ({ __connKey, ...msg }: Record<string, unknown>) =>
    /^(UI|WS)_/.test(String(msg.type))
      ? figma.ui.onmessage({ from: "panel", control: { ...msg, connKey: __connKey } })
      : figma.ui.onmessage({ from: "server", connKey: __connKey, frame: msg });
  const approved = (key: number) =>
    frame((f) => f.type === "SESSION_TOKEN" && f.__connKey === key, `the Allow handover for ${key}`);
  const connect = async (key: number) => {
    send({ type: "WS_CONNECTED", __connKey: key });
    send({ type: "SESSION_INFO", id: `session-${key}`, __connKey: key, identity: "test" });
    send({ type: "UI_DECISION", approve: true, __connKey: key });
    await approved(key);
  };
  const result = (id: string, key?: number) =>
    frame(
      (f) => f.id === id && f.type === "EXECUTE_CODE_RESULT" && (key === undefined || f.__connKey === key),
      `a result for ${id}`,
    ) as Promise<any>;
  const running = (id: string, key: number) =>
    frame((f) => f.type === "RUN_STATE" && f.runId === id && f.__connKey === key && f.phase === "running", `${id} running`);
  return { frames, context, send, connect, approved, frame, result, running, deliverChanges };
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
    h.send({ type: "EXECUTE_CODE", id, __connKey: key, preamble: "(host)=>({ flcm: {}, session: host.getSession(() => ({})), warnings: createWarningRegistry(), mutationQueueIdle: async () => 0, committedVerbCount: () => 0 })", code: body });
  run(1, "same-id", "await hold; writes.push('old completed'); return 'old';");
  await h.running("same-id", 1);
  h.send({ type: "WS_CLOSED", __connKey: 1 });
  await h.connect(2);
  run(2, "same-id", "writes.push('new'); return 'new';");
  run(2, "queued", "writes.push('must never run');");
  h.send({ type: "CANCEL", runId: "queued", __connKey: 2 });
  release();
  // Runs dequeue in order, so the cancelled one answering means everything before it has run.
  await h.result("same-id", 2);
  await h.result("queued", 2);
  assert.deepEqual(Array.from(h.context.writes), ["old completed", "new"]);
  assert(
    h.frames.some(
      (f) =>
        f.type === "RUN_STATE" &&
        f.runId === "same-id" &&
        f.__connKey === 2 &&
        f.phase === "running",
    ),
  );
  assert(
    h.frames.some((f) => f.id === "queued" && String(f.errors).includes("no code was executed")),
  );
});

test("a cancel is answered at once from the phase the run had reached", async () => {
  const h = host();
  await h.connect(1);
  let release!: () => void;
  h.context.hold = new Promise<void>((resolve) => { release = resolve; });
  const preamble = "(host)=>({ flcm: {}, session: host.getSession(() => ({})), warnings: createWarningRegistry(), mutationQueueIdle: async () => 0, committedVerbCount: () => 0 })";
  const run = (id: string, body: string) =>
    h.send({ type: "EXECUTE_CODE", id, __connKey: 1, preamble, code: body });
  run("executing", "await hold; return 1;");
  run("waiting", "return 2;");
  await h.running("executing", 1);
  // No flush between these and the assertion: the answer must come from state the plugin already
  // holds. The queued run's own refusal can only speak once "executing" finishes — far too late.
  h.send({ type: "CANCEL", runId: "waiting", __connKey: 1 });
  h.send({ type: "CANCEL", runId: "executing", __connKey: 1 });
  h.send({ type: "CANCEL", runId: "never-heard-of", __connKey: 1 });
  assert.deepEqual(
    h.frames.filter((f) => f.type === "CANCEL_RESULT").map((f) => [f.runId, f.disposition, f.__connKey]),
    [
      ["waiting", "never-executed", 1],
      ["executing", "was-running", 1],
      ["never-heard-of", "unknown", 1],
    ],
  );
  release();
  await h.result("waiting");
});

test("Reject is explicit and unknown tokens cannot bypass approval status or execution", async () => {
  const h = host();
  // The first paint follows the stored approvals loading; only then is "unknown" known to be unknown.
  await h.frame((f) => f.type === "RENDER", "the first paint");
  h.send({ type: "WS_CONNECTED", __connKey: 1 });
  h.send({ type: "SESSION_INFO", id: "session", __connKey: 1, sessionToken: "unknown" });
  h.send({ type: "UI_DECISION", approve: false, __connKey: 1 });
  h.send({ type: "APPROVAL_STATUS", id: "status", __connKey: 1 });
  assert(h.frames.some((f) => f.id === "status" && f.type === "APPROVAL_REJECTED"));
  h.context.writes = [];
  h.send({
    type: "EXECUTE_CODE",
    id: "run",
    __connKey: 1,
    preamble: "(host)=>({ flcm: {}, session: host.getSession(() => ({})), warnings: createWarningRegistry(), mutationQueueIdle: async () => 0, committedVerbCount: () => 0 })",
    code: "writes.push('bad');",
  });
  // Refused at the gate, synchronously, with the one reply the request is owed.
  assert.equal(h.frames.find((f) => f.id === "run")?.type, "PENDING_APPROVAL");
  assert.equal(h.context.writes.length, 0);
});

test("an Allow given while a session is away reaches only the connection presenting its claim, and runs nothing", async () => {
  const h = host();
  await h.frame((f) => f.type === "RENDER", "the first paint");
  const tokenFor = (key: number) => h.frames.some((f) => f.type === "SESSION_TOKEN" && f.__connKey === key);
  const statusFor = (key: number, id: string) => {
    h.send({ type: "APPROVAL_STATUS", id, __connKey: key });
    return h.frames.find((f) => f.id === id)?.type;
  };
  h.send({ type: "WS_CONNECTED", __connKey: 1 });
  h.send({ type: "SESSION_INFO", id: "session-1", __connKey: 1, identity: "/proj", pairingCode: "1111" });
  assert.equal(statusFor(1, "ask"), "PENDING_APPROVAL");
  const claim = (await h.frame((f) => f.type === "SESSION_CLAIM" && f.__connKey === 1, "a session claim")).sessionClaim;
  // The waiting call gives up and its session disconnects; the human allows the request afterwards.
  h.send({ type: "WS_CLOSED", __connKey: 1 });
  h.send({ type: "UI_DECISION", approve: true, __connKey: 1 });
  assert(!h.frames.some((f) => f.type === "SESSION_TOKEN"));

  // Same project path, but not the session that asked: one presents another claim, one presents
  // none, one presents the claim under another project.
  h.send({ type: "WS_CONNECTED", __connKey: 2 });
  h.send({ type: "SESSION_INFO", id: "session-2", __connKey: 2, identity: "/proj", sessionClaim: "someoneelse0000000000" });
  h.send({ type: "WS_CONNECTED", __connKey: 3 });
  h.send({ type: "SESSION_INFO", id: "session-3", __connKey: 3, identity: "/proj" });
  h.send({ type: "WS_CONNECTED", __connKey: 4 });
  h.send({ type: "SESSION_INFO", id: "session-4", __connKey: 4, identity: "/other", sessionClaim: claim });
  // The session that asked comes back with its claim and collects the Allow.
  h.send({ type: "WS_CONNECTED", __connKey: 5 });
  h.send({ type: "SESSION_INFO", id: "session-5", __connKey: 5, identity: "/proj", sessionClaim: claim });
  // Its first poll lands before the handover settles, and must not be told to wait for a second Allow.
  h.send({ type: "APPROVAL_STATUS", id: "next", __connKey: 5 });
  assert.equal((await h.frame((f) => f.id === "next", "the first poll's answer")).type, "APPROVAL_GRANTED");
  assert(tokenFor(5));
  assert(!h.frames.some((f) => f.type === "SESSION_CLAIM" && f.__connKey === 5));
  for (const key of [2, 3, 4]) {
    assert(!tokenFor(key), `connection ${key} must not be approved`);
    assert.equal(statusFor(key, `other-${key}`), "PENDING_APPROVAL");
  }
  // The claim is spent: presenting it again approves nothing.
  h.send({ type: "WS_CONNECTED", __connKey: 6 });
  h.send({ type: "SESSION_INFO", id: "session-6", __connKey: 6, identity: "/proj", sessionClaim: claim });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert(!tokenFor(6));
  // Nothing ran on the Allow: the only code any session sent was never sent.
  assert(!h.frames.some((f) => f.type === "EXECUTE_CODE_RESULT"));
});

test("an approved session's write waits out another session's pending Allow instead of re-prompting", async () => {
  let saving: Promise<void> = Promise.resolve();
  const h = host({ clientStorage: { getAsync: async () => [], setAsync: () => saving } });
  await h.connect(1);
  // Session 2 asks, and the human's Allow for it is still being written when session 1 writes.
  h.send({ type: "WS_CONNECTED", __connKey: 2 });
  h.send({ type: "SESSION_INFO", id: "session-2", __connKey: 2, identity: "other" });
  let landed!: () => void;
  saving = new Promise((resolve) => { landed = resolve; });
  h.send({ type: "UI_DECISION", approve: true, __connKey: 2 });
  const preamble = "(host)=>({ flcm: {}, session: host.getSession(() => ({})), warnings: createWarningRegistry(), mutationQueueIdle: async () => 0, committedVerbCount: () => 0 })";
  h.send({ type: "EXECUTE_CODE", id: "run", __connKey: 1, preamble, code: "return 'ran';" });
  h.send({ type: "APPROVAL_STATUS", id: "status", __connKey: 1 });
  assert(!h.frames.some((f) => f.__connKey === 1 && (f.type === "PENDING_APPROVAL" || f.type === "SESSION_CLAIM")));
  landed();
  assert.equal((await h.result("run", 1)).result, "ran");
  assert.equal((await h.frame((f) => f.id === "status", "the status answer")).type, "APPROVAL_GRANTED");
  assert(!h.frames.some((f) => f.__connKey === 1 && (f.type === "PENDING_APPROVAL" || f.type === "SESSION_CLAIM")));
});

test("SESSION_INFO keeps what the connection already holds: its claim and an Allow in flight", async () => {
  let saving: Promise<void> = Promise.resolve();
  const h = host({ clientStorage: { getAsync: async () => [], setAsync: () => saving } });
  await h.frame((f) => f.type === "RENDER", "the first paint");
  h.send({ type: "WS_CONNECTED", __connKey: 1 });
  // A write that beats the handshake is refused and gives this socket a claim.
  h.send({ type: "SCREENSHOT", id: "early", __connKey: 1 });
  const claim = (await h.frame((f) => f.type === "SESSION_CLAIM", "a session claim")).sessionClaim;
  h.send({ type: "SESSION_INFO", id: "session-1", __connKey: 1, identity: "/proj" });
  // Its next ask goes on under the claim it already holds; a second would orphan the first.
  h.send({ type: "APPROVAL_STATUS", id: "ask", __connKey: 1 });
  assert.deepEqual(h.frames.filter((f) => f.type === "SESSION_CLAIM").map((f) => f.sessionClaim), [claim]);
  let landed!: () => void;
  saving = new Promise((resolve) => { landed = resolve; });
  h.send({ type: "UI_DECISION", approve: true, __connKey: 1 });
  // The server introduces itself again while the Allow is being written.
  h.send({ type: "SESSION_INFO", id: "session-1b", __connKey: 1, identity: "/proj" });
  landed();
  await h.approved(1);
});

test("a peer that has not been approved learns nothing from PING and can't author a toast", async () => {
  const toasts: string[] = [];
  const h = host({ notify: (message: string) => toasts.push(message) });
  h.send({ type: "WS_CONNECTED", __connKey: 1 });
  h.send({ type: "PING", id: "ping", __connKey: 1, payload: "x" });
  h.send({ type: "NOTIFY", id: "notify", __connKey: 1, message: "Your file is corrupt — visit evil.example" });
  assert.deepEqual({ ...h.frames.find((f) => f.id === "ping") }, { type: "PONG", echo: "x", id: "ping", __connKey: 1 });
  assert.equal(toasts.length, 1);
  assert(!toasts[0].includes("evil.example"));
});

test("the panel tells a waiting request from an expired one, connected or away", async () => {
  const h = host();
  await h.frame((f) => f.type === "RENDER", "the first paint");
  type Row = { key: number; request: string | null; connected: boolean; allowedWhileAway: boolean };
  const row = (match: (r: Row) => boolean, what: string) =>
    h.frame((f) => f.type === "RENDER" && (f.sessions as Row[]).some((r) => r.key === 1 && match(r)), what);
  h.send({ type: "WS_CONNECTED", __connKey: 1 });
  h.send({ type: "SESSION_INFO", id: "session-1", __connKey: 1, identity: "/proj", pairingCode: "1111" });
  h.send({ type: "APPROVAL_STATUS", id: "ask", __connKey: 1 });
  await row((r) => r.request === "waiting", "a waiting row");
  // The polls stop: the request expires on its own, with nothing waiting to run.
  await row((r) => r.request === "expired" && r.connected, "an expired, connected row");
  h.send({ type: "WS_CLOSED", __connKey: 1 });
  await row((r) => r.request === "expired" && !r.connected && !r.allowedWhileAway, "an away row");
  h.send({ type: "UI_DECISION", approve: true, __connKey: 1 });
  await row((r) => r.allowedWhileAway, "an away row allowed");
});

test("actual UI routes old results and image requests only to their original connection", () => {
  const forwarded: Array<{ pluginMessage: Record<string, unknown> }> = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    frames: string[] = [];
    onopen = () => {};
    onclose = () => {};
    onmessage = (_event: { data: string }) => {};
    send(raw: string) {
      this.frames.push(raw);
    }
  }
  const script = readFileSync(new URL("../ui.html", import.meta.url), "utf8")
    .split("<script>")[1]
    .split("</script>")[0];
  const context = vm.createContext({
    WebSocket: Socket,
    parent: {
      postMessage: (msg: { pluginMessage: Record<string, unknown> }) => forwarded.push(msg),
    },
    window: {},
    document: { getElementById: () => ({}) },
    setTimeout() {},
    requestAnimationFrame() {},
    console,
  });
  vm.runInContext(script, context);
  const old: Socket = context.sockets[9876];
  old.onopen();
  const oldKey = (forwarded.at(-1)!.pluginMessage.control as { connKey: number }).connKey;
  context.connect(9876);
  const next: Socket = context.sockets[9876];
  next.onopen();
  const newKey = (forwarded.at(-1)!.pluginMessage.control as { connKey: number }).connKey;
  assert.notEqual(oldKey, newKey);
  for (const type of ["EXECUTE_CODE_RESULT", "CHANNEL_REQUEST", "SESSION_TOKEN", "REVOKE_SESSION"]) {
    context.window.onmessage({ data: { pluginMessage: { type, __connKey: oldKey } } });
  }
  old.onmessage({ data: JSON.stringify({ type: "CANCEL", runId: "same-id" }) });
  old.onclose();
  assert.equal(next.frames.length, 0);
  assert.equal(context.sockets[9876], next);
  context.window.onmessage({
    data: { pluginMessage: { type: "EXECUTE_CODE_RESULT", __connKey: newKey, result: "new" } },
  });
  assert.equal(JSON.parse(next.frames[0]).result, "new");
  assert(!forwarded.some((f) => (f.pluginMessage.frame as { type?: string } | undefined)?.type === "CANCEL"));
});

test("a server frame can never act as the human's panel input", async () => {
  const h = host({ openExternal: () => { throw new Error("a server opened the browser"); } });
  class Socket {
    static OPEN = 1;
    readyState = 1;
    onopen = () => {};
    onmessage = (_event: { data: string }) => {};
    onclose = () => {};
    send() {}
  }
  const script = readFileSync(new URL("../ui.html", import.meta.url), "utf8")
    .split("<script>")[1]
    .split("</script>")[0];
  const ui = vm.createContext({
    WebSocket: Socket,
    // The real relay, feeding the real host: whatever ui.html posts is what code.ts dispatches on.
    parent: { postMessage: (msg: { pluginMessage: unknown }) => h.context.figma.ui.onmessage(msg.pluginMessage) },
    window: {},
    document: { getElementById: () => ({}) },
    setTimeout() {},
    requestAnimationFrame() {},
    console,
  });
  vm.runInContext(script, ui);
  // ui.html numbers socket generations in dial order, from 1: 9876 is 1, 9877 is 2.
  const socket: Socket = ui.sockets[9876];
  socket.onopen();
  const fromServer = (frame: Record<string, unknown>) => socket.onmessage({ data: JSON.stringify(frame) });
  fromServer({ type: "SESSION_INFO", id: "session", identity: "rogue", framelinkOrigin: "https://evil.example" });
  // Everything a panel click would say, spoken by the server instead — in both envelope spellings.
  fromServer({ type: "UI_DECISION", approve: true });
  fromServer({ type: "UI_DECISION", approve: true, connKey: 1, __connKey: 1 });
  fromServer({ from: "panel", control: { type: "UI_DECISION", approve: true, connKey: 1 } });
  fromServer({ type: "UI_SIGN_IN" });
  fromServer({ type: "UI_OPEN_SIGN_IN" });
  // A barrier: a genuine Allow on a second session. Approval changes land in order, so once its
  // handover is out, any Allow a forged frame had started would have landed before it.
  const second: Socket = ui.sockets[9877];
  second.onopen();
  second.onmessage({ data: JSON.stringify({ type: "SESSION_INFO", id: "second", identity: "real" }) });
  ui.decide(true, 2);
  await h.approved(2);
  fromServer({ type: "APPROVAL_STATUS", id: "status" });
  assert.equal(h.frames.find((f) => f.id === "status")?.type, "PENDING_APPROVAL");
  assert.equal(
    h.frames.some((f) => (f.type === "SESSION_TOKEN" && f.__connKey === 1) || f.type === "WRITE_ACCESS_SIGN_IN"),
    false,
  );
});

test("the browser opens a sign-in page only on the Framelink origin the server announced", async () => {
  const opened: string[] = [];
  const h = host({ openExternal: (url: string) => opened.push(url) });
  h.send({ type: "WS_CONNECTED", __connKey: 1 });
  h.send({ type: "SESSION_INFO", id: "session", __connKey: 1, identity: "test", framelinkOrigin: "https://app.framelink.ai" });
  h.send({ type: "UI_DECISION", approve: true, __connKey: 1 });
  await h.approved(1);
  const signIn = (verificationUri: string) => {
    h.send({ type: "UI_SIGN_IN", __connKey: 1 });
    h.send({ type: "WRITE_ACCESS", id: `notice-${verificationUri}`, __connKey: 1, notice: { kind: "sign-in-pending", userCode: "ABCD", verificationUri } });
  };
  signIn("https://app.framelink.ai.evil.example/device");
  signIn("https://evil.example/?https://app.framelink.ai/");
  signIn("https://app.framelink.ai@evil.example/device");
  signIn("https://app.framelink.ai/device?user_code=ABCD");
  assert.deepEqual(opened, ["https://app.framelink.ai/device?user_code=ABCD"]);
});

test("execute projects registered reads in nested results and console lines exactly once", async () => {
  const h = host();
  await h.connect(1);
  h.send({
    type: "EXECUTE_CODE", id: "projection", __connKey: 1,
    preamble: `(host) => {
      const read = { id: "v", type: "VECTOR", d: "M0 0 L1 1" };
      host.registerRead(read, () => ({ id: "v", type: "IMAGE-SVG", elided: { d: 10 } }));
      return { flcm: { read }, session: host.getSession(() => ({})), warnings: createWarningRegistry(), mutationQueueIdle: async () => 0, committedVerbCount: () => 0 };
    }`,
    code: `console.log({ nested: [flcm.read] }); return { nested: [flcm.read], computed: { id: "v", type: "VECTOR", d: "mine" } };`,
  });
  const reply = await h.result("projection");
  assert.equal(reply.errors, null);
  assert.equal(reply.result.nested[0].type, "IMAGE-SVG");
  assert.equal(JSON.stringify(reply.result.nested[0].elided), '{"d":10}');
  assert.equal(reply.result.computed.d, "mine");
  assert.equal(reply.console[0].includes('"type":"IMAGE-SVG"'), true);
  assert.equal(reply.console[0].includes('"d":"M0'), false);
});

test("a marked designTokens entry keeps its mark in the result but not in a console line", async () => {
  const h = host();
  await h.connect(1);
  h.send({
    type: "EXECUTE_CODE", id: "token-mark", __connKey: 1,
    preamble: `(host) => {
      const entry = { reference: { variable: "color/bg" }, type: "COLOR" };
      host.registerRead(entry, () => entry, (out) => ({ ...out, ${JSON.stringify(TOKEN_ENTRY_MARK)}: "variable" }));
      return { flcm: { entry }, session: host.getSession(() => ({})), warnings: createWarningRegistry(), mutationQueueIdle: async () => 0, committedVerbCount: () => 0 };
    }`,
    code: `console.log(flcm.entry); return flcm.entry;`,
  });
  const reply = await h.result("token-mark");
  assert.equal(reply.result[TOKEN_ENTRY_MARK], "variable");
  assert.equal(reply.console[0], '[log] {"reference":{"variable":"color/bg"},"type":"COLOR"}');
});

const realPreamble = import("./preamble/index.mjs").then(m => m.buildSandboxPreamble());
async function execute(h: ReturnType<typeof host>, body: string, key = 1) {
  const id = `execute-${h.frames.length}`;
  h.send({ type: "EXECUTE_CODE", id, __connKey: key, preamble: await realPreamble, code: body });
  return (await h.result(id)) as { id: string; result: any; errors: string | null };
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
  h.send({ type: "WS_CLOSED", __connKey: 1 });
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

test("last retains full read data before wire projection", async () => {
  const h = host();
  await h.connect(1);
  const preamble = await realPreamble;
  h.send({
    type: "EXECUTE_CODE", id: "full-read", __connKey: 1,
    preamble: `(host) => {
      const bindings = (${preamble}\n)(host);
      const read = { id: "v", type: "VECTOR", d: "M0 0 L1 1" };
      host.registerRead(read, () => ({ id: "v", type: "IMAGE-SVG", elided: { d: 10 } }));
      return { ...bindings, flcm: { read } };
    }`,
    code: `return { nested: [flcm.read] };`,
  });
  const first = await h.result("full-read");
  assert.equal(first.errors, null);
  assert.equal(first.result.nested[0].type, "IMAGE-SVG");
  const next = await execute(h, `return session.last.nested[0].d;`);
  assert.equal(next.errors, null);
  assert.equal(next.result, "M0 0 L1 1");
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

test("a raw figma write counts even when its change event lands after the reply, and Allow names the Authorizing User", async () => {
  const h = host({ currentUser: { id: "figma-user-7", name: "Ada" } });
  await h.connect(1);
  const handover = h.frames.find(f => f.type === "SESSION_TOKEN") as any;
  assert.deepEqual(JSON.parse(JSON.stringify(handover.authorizingUser)), { figmaUserId: "figma-user-7", name: "Ada" });
  const changedLate = (id: string) => h.frames.some(f => f.type === "RUN_CHANGED" && f.runId === id);
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
  const send = (id: string, code: string) => h.send({ type: "EXECUTE_CODE", id, __connKey: 1, preamble, code });
  send("first", `session.count = 1; await hold; session.count++; return session.count;`);
  send("cancelled", `session.count = 100; return 100;`);
  h.send({ type: "CANCEL", runId: "cancelled", __connKey: 1 });
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
    if (msg.type === "EXECUTE_CODE_RESULT" && survivorAtReply === undefined) {
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
  h.send({ type: "CHANNEL_RESPONSE", id: request.id, ok: false, error: "wrong connection", __connKey: 2 });
  h.send({ type: "CHANNEL_RESPONSE", id: request.id, ok: true, payload: { "asset.png": "Ynl0ZXM=" }, __connKey: 1 });
  assert.equal((await result).errors, null);
});

test("server refusals reject the suspended image await", async () => {
  const { createFigmaMock } = await import("../harness/figma-mock.mjs");
  const h = host(createFigmaMock());
  await h.connect(1);
  const result = execute(h, `await flcm.render({ type: "RECTANGLE", width: 10, height: 10, fill: flcm.image("asset.png") }); globalThis.resumed = true;`);
  const request = await h.frame((f) => f.type === "CHANNEL_REQUEST", "a channel request");
  h.send({ type: "CHANNEL_RESPONSE", id: request.id, ok: false, error: "run no longer active", __connKey: 1 });
  assert.match((await result).errors!, /run no longer active/);
  assert.equal(h.context.resumed, undefined);
});

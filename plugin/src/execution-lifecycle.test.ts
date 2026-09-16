import { createWarningRegistry } from "./preamble/warnings.js";
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
const flush = async () => {
  for (let n = 0; n < 30; n++) await Promise.resolve();
};
function host(native: Record<string, unknown> = {}) {
  const frames: Record<string, unknown>[] = [];
  const figma = {
    showUI() {},
    notify() {},
    currentPage: { name: "test" },
    ...native,
    clientStorage: { getAsync: async () => [], setAsync: async () => {} },
    ui: {
      postMessage: (msg: Record<string, unknown>) => frames.push(msg),
      onmessage: (_msg: Record<string, unknown>) => {},
      resize() {},
    },
  };
  const context = vm.createContext({ createWarningRegistry, figma, __html__: "", console: { ...console }, setTimeout });
  vm.runInContext(code, context);
  const send = (msg: Record<string, unknown>) => figma.ui.onmessage(msg);
  const connect = async (key: number) => {
    send({ type: "WS_CONNECTED", __connKey: key });
    send({ type: "SESSION_INFO", id: `session-${key}`, __connKey: key, identity: "test" });
    send({ type: "UI_DECISION", approve: true, __connKey: key });
    await flush();
  };
  return { frames, context, send, connect };
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
    h.send({ type: "EXECUTE_CODE", id, __connKey: key, preamble: "(host)=>({ flcm: {}, session: host.getSession(() => ({})), warnings: createWarningRegistry(), mutationQueueIdle: async () => 0 })", code: body });
  run(1, "same-id", "await hold; writes.push('old completed'); return 'old';");
  await flush();
  h.send({ type: "WS_CLOSED", __connKey: 1 });
  await h.connect(2);
  run(2, "same-id", "writes.push('new'); return 'new';");
  run(2, "queued", "writes.push('must never run');");
  h.send({ type: "CANCEL", runId: "queued", __connKey: 2 });
  release();
  await flush();
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
  const preamble = "(host)=>({ flcm: {}, session: host.getSession(() => ({})), warnings: createWarningRegistry(), mutationQueueIdle: async () => 0 })";
  const run = (id: string, body: string) =>
    h.send({ type: "EXECUTE_CODE", id, __connKey: 1, preamble, code: body });
  run("executing", "await hold; return 1;");
  run("waiting", "return 2;");
  await flush();
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
  await flush();
});

test("Reject is explicit and unknown tokens cannot bypass approval status or execution", async () => {
  const h = host();
  await flush();
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
    preamble: "(host)=>({ flcm: {}, session: host.getSession(() => ({})), warnings: createWarningRegistry(), mutationQueueIdle: async () => 0 })",
    code: "writes.push('bad');",
  });
  await flush();
  assert.equal(h.context.writes.length, 0);
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
  const oldKey = forwarded.at(-1)!.pluginMessage.__connKey;
  context.connect(9876);
  const next: Socket = context.sockets[9876];
  next.onopen();
  const newKey = forwarded.at(-1)!.pluginMessage.__connKey;
  assert.notEqual(oldKey, newKey);
  for (const type of ["EXECUTE_CODE_RESULT", "IMAGES_REQUEST", "SESSION_TOKEN", "REVOKE_SESSION"]) {
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
  assert(!forwarded.some((f) => f.pluginMessage.type === "CANCEL"));
});

test("execute projects registered reads in nested results and console lines exactly once", async () => {
  const h = host();
  await h.connect(1);
  h.send({
    type: "EXECUTE_CODE", id: "projection", __connKey: 1,
    preamble: `(host) => {
      const read = { id: "v", type: "VECTOR", d: "M0 0 L1 1" };
      host.registerRead(read, () => ({ id: "v", type: "IMAGE-SVG", elided: { d: 10 } }));
      return { flcm: { read }, session: host.getSession(() => ({})), warnings: createWarningRegistry(), mutationQueueIdle: async () => 0 };
    }`,
    code: `console.log({ nested: [flcm.read] }); return { nested: [flcm.read], computed: { id: "v", type: "VECTOR", d: "mine" } };`,
  });
  await flush();
  const reply = h.frames.find(frame => frame.id === "projection" && frame.type === "EXECUTE_CODE_RESULT") as any;
  assert.equal(reply.errors, null);
  assert.equal(reply.result.nested[0].type, "IMAGE-SVG");
  assert.equal(JSON.stringify(reply.result.nested[0].elided), '{"d":10}');
  assert.equal(reply.result.computed.d, "mine");
  assert.equal(reply.console[0].includes('"type":"IMAGE-SVG"'), true);
  assert.equal(reply.console[0].includes('"d":"M0'), false);
});

const realPreamble = import("./preamble/index.mjs").then(m => m.buildSandboxPreamble());
async function execute(h: ReturnType<typeof host>, body: string, key = 1) {
  const id = `execute-${h.frames.length}`;
  h.send({ type: "EXECUTE_CODE", id, __connKey: key, preamble: await realPreamble, code: body });
  for (let n = 0; n < 100; n++) {
    const reply = h.frames.find(f => f.id === id && f.type === "EXECUTE_CODE_RESULT");
    if (reply) return reply as { result: any; errors: string | null };
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error("execution did not settle");
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
  await flush();
  const first = h.frames.find(f => f.id === "full-read" && f.type === "EXECUTE_CODE_RESULT") as any;
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

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
function host() {
  const frames: Record<string, unknown>[] = [];
  const figma = {
    showUI() {},
    notify() {},
    currentPage: { name: "test" },
    clientStorage: { getAsync: async () => [], setAsync: async () => {} },
    ui: {
      postMessage: (msg: Record<string, unknown>) => frames.push(msg),
      onmessage: (_msg: Record<string, unknown>) => {},
      resize() {},
    },
  };
  const context = vm.createContext({ figma, __html__: "", console: { ...console }, setTimeout });
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
    h.send({ type: "EXECUTE_CODE", id, __connKey: key, preamble: "(host)=>({})", code: body });
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
    preamble: "(host)=>({})",
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

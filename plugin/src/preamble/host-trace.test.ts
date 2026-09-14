import { test } from "node:test";
import assert from "node:assert/strict";
import { awaitNative, type FlcmHost } from "./host.js";

const globals = globalThis as typeof globalThis & { __flcmHost?: FlcmHost };
test("pending native await reports its start and preserves its eventual outcome", async () => {
  const events: string[] = [];
  globals.__flcmHost = {
    requestImages: async () => ({}), isRunCancelled: () => false,
    traceNative: (stage, operation) => events.push(`${stage}:${operation}`),
  };
  try {
    let resolve!: (value: number) => void;
    const pending = awaitNative("page-switch", () => new Promise<number>(r => { resolve = r; }));
    assert.deepEqual(events, ["native-start:page-switch"]);
    resolve(42);
    assert.equal(await pending, 42);
    assert.deepEqual(events, ["native-start:page-switch", "native-end:page-switch"]);
    const failure = new Error("native rejection");
    await assert.rejects(awaitNative("font-load", async () => { throw failure; }), e => e === failure);
    assert.equal(events.at(-1), "native-error:font-load");
  } finally { delete globals.__flcmHost; }
});

test("old hosts and failing diagnostics preserve native results", async () => {
  globals.__flcmHost = { requestImages: async () => ({}), isRunCancelled: () => false };
  try {
    assert.equal(await awaitNative("page-switch", async () => 7), 7);
    globals.__flcmHost.traceNative = () => { throw new Error("report failed"); };
    assert.equal(await awaitNative("page-switch", async () => 9), 9);
  } finally { delete globals.__flcmHost; }
});

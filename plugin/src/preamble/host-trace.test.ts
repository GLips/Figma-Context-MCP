/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { awaitNative, type FlcmHost } from "./host.js";

const globals = globalThis as typeof globalThis & { __flcmHost?: FlcmHost };
test("pending native await reports its start and preserves its eventual outcome", async () => {
  const events: string[] = [];
  globals.__flcmHost = {
    callServer: async () => ({}), runCancellation: () => null, isRunFinished: () => false, whenCancelled: () => new Promise(() => {}),
    trace: (stage, operation) => events.push(`${stage}:${operation}`),
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
  globals.__flcmHost = { callServer: async () => ({}), runCancellation: () => null, isRunFinished: () => false, whenCancelled: () => new Promise(() => {}) };
  try {
    assert.equal(await awaitNative("page-switch", async () => 7), 7);
    globals.__flcmHost.trace = () => { throw new Error("report failed"); };
    assert.equal(await awaitNative("page-switch", async () => 9), 9);
  } finally { delete globals.__flcmHost; }
});

test("a Figma call that never returns is abandoned when the run is cancelled, naming the call", async () => {
  let cancel!: (cause: "server") => void;
  globals.__flcmHost = {
    callServer: async () => ({}), runCancellation: () => null, isRunFinished: () => false,
    whenCancelled: () => new Promise(r => { cancel = r; }),
  } as unknown as FlcmHost;
  try {
    const stuck = awaitNative("font-load", () => new Promise<never>(() => {}));
    cancel("server");
    await assert.rejects(stuck, /figma\.loadFontAsync still hadn't returned .* cancelled by the server .* bring the file to the front/s);
  } finally { delete globals.__flcmHost; }
});

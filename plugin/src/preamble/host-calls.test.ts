/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { awaitNative, type FlcmHost, type RunCancelCause } from "./host.js";
import { agentFigma } from "./agent-figma.js";

const globals = globalThis as typeof globalThis & { __flcmHost?: FlcmHost; figma?: unknown };

/** A host whose cancel listeners can be counted and fired. */
function cancellableHost(events: string[] = []) {
  const listeners = new Set<(cause: RunCancelCause) => void>();
  let next = 0;
  const host: FlcmHost = {
    getSession: (initialize) => initialize(),
    callServer: async () => ({}),
    runCancellation: () => null,
    isRunFinished: () => false,
    callStarted: (operation) => (events.push(`start:${operation}`), ++next),
    callSettled: (token) => void events.push(`settled:${token}`),
    onCancelled: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { host, listeners, cancel: (cause: RunCancelCause) => { for (const listener of [...listeners]) listener(cause); } };
}

test("a native await is pending from its start until Figma settles it, and keeps its outcome", async () => {
  const events: string[] = [];
  globals.__flcmHost = cancellableHost(events).host;
  try {
    let resolve!: (value: number) => void;
    const pending = awaitNative("figma.setCurrentPageAsync", () => new Promise<number>(r => { resolve = r; }));
    assert.deepEqual(events, ["start:figma.setCurrentPageAsync"]);
    resolve(42);
    assert.equal(await pending, 42);
    assert.deepEqual(events, ["start:figma.setCurrentPageAsync", "settled:1"]);
    const failure = new Error("native rejection");
    await assert.rejects(awaitNative("figma.loadFontAsync", async () => { throw failure; }), e => e === failure);
    assert.equal(events.at(-1), "settled:2");
  } finally { delete globals.__flcmHost; }
});

test("a Figma call that never returns is abandoned when the run is cancelled, naming the call", async () => {
  const { host, cancel } = cancellableHost();
  globals.__flcmHost = host;
  try {
    const stuck = awaitNative("figma.loadFontAsync", () => new Promise<never>(() => {}));
    cancel("server");
    await assert.rejects(stuck, /^FlcmError: figma\.loadFontAsync was still pending when the server cancelled this run, so the run stops here\.$/);
  } finally { delete globals.__flcmHost; }
});

test("settled Figma calls leave no cancel listener behind", async () => {
  const { host, listeners } = cancellableHost();
  globals.__flcmHost = host;
  globals.figma = { loadFontAsync: async () => {} };
  try {
    const agent = agentFigma();
    for (let call = 0; call < 1_000; call++) {
      await agent.loadFontAsync({ family: "Inter", style: "Regular" });
      await awaitNative("figma.listAvailableFontsAsync", async () => []);
    }
    assert.equal(listeners.size, 0);
  } finally { delete globals.__flcmHost; delete globals.figma; }
});

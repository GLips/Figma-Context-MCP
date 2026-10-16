/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import type { FlcmHost } from "../src/preamble/host.js";

/**
 * Run `body` as its own flcm run, the way a later agent call would. Tests import the preamble
 * modules once and share them, but a run's state (its loaded fonts, its font listing) is the run's
 * own; a fresh host is what tells the preamble a new run began.
 */
export async function inNextRun<T>(body: () => Promise<T>, host: Partial<FlcmHost> = {}): Promise<T> {
  const g = globalThis as { __flcmHost?: FlcmHost };
  const outer = g.__flcmHost;
  g.__flcmHost = {
    callServer: async () => ({}), runCancellation: () => null, isRunFinished: () => false,
    whenCancelled: () => new Promise(() => {}),
    ...host,
  } as FlcmHost;
  try {
    return await body();
  } finally {
    if (outer) g.__flcmHost = outer;
    else delete g.__flcmHost;
  }
}

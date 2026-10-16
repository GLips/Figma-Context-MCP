/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The `--wait` every plugin command shares: how long a one-shot relay waits for the plugin to dial in.
import { UsageError } from "~/config.js";
import type { PluginBridge } from "~/commercial/plugin-bridge/bridge.js";
import { pluginDisconnectedAction } from "~/commercial/plugin-bridge/blocked-call-guidance.js";

export const DEFAULT_PLUGIN_WAIT_SECONDS = 600;

/** `--wait` in milliseconds, defaulted and checked against what a timer can hold. */
export function pluginWaitMs(waitSeconds: number | undefined): number {
  const waitMs = (waitSeconds ?? DEFAULT_PLUGIN_WAIT_SECONDS) * 1000;
  if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 2_147_483_647)
    throw new UsageError(
      "--wait must be a finite, nonnegative number of seconds within the timer range.",
    );
  return waitMs;
}

/**
 * Resolve once a plugin is on the wire, or fail naming what didn't happen (`notDone`, e.g. "the
 * script was not submitted") once `waitMs` passes. An abort of `signal` rejects with its reason.
 */
export async function waitForPluginConnection(
  bridge: PluginBridge,
  waitMs: number,
  signal: AbortSignal,
  notDone: string,
): Promise<void> {
  const expired = new AbortController();
  const timer = setTimeout(() => expired.abort(), waitMs);
  try {
    await bridge.whenPluginConnected(AbortSignal.any([signal, expired.signal]));
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(
      `Blocked: no Figma plugin connected before --wait expired, so ${notDone}. ${pluginDisconnectedAction()}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

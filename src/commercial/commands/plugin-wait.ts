/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The `--wait` every plugin command shares: one deadline, set when the command starts, for everything
// it waits on before its run (the plugin dialing in, then the file and Allow). The run itself is
// waited on with no limit.
import { UsageError } from "~/config.js";
import type { PluginBridge } from "~/commercial/plugin-bridge/bridge.js";
import { pluginDisconnectedAction } from "~/commercial/plugin-bridge/blocked-call-guidance.js";
import { callWaitLine } from "~/commercial/plugin-bridge/call-wait.js";

export const DEFAULT_PLUGIN_WAIT_SECONDS = 60;

/** The deadline `--wait` sets from now, defaulted and checked against what a timer can hold. */
export function pluginWaitDeadline(waitSeconds: number | undefined): number {
  const waitMs = (waitSeconds ?? DEFAULT_PLUGIN_WAIT_SECONDS) * 1000;
  if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 2_147_483_647)
    throw new UsageError(
      "--wait must be a finite, nonnegative number of seconds within the timer range.",
    );
  return Date.now() + waitMs;
}

/**
 * Wait for a plugin on the wire, saying so on stderr: null once one is, or the text naming what
 * didn't happen (`notDone`, e.g. "the script was not submitted") once `deadline` passes. An abort of
 * `signal` rejects with its reason.
 */
export async function waitForPluginConnection(
  bridge: PluginBridge,
  deadline: number,
  signal: AbortSignal,
  notDone: string,
): Promise<string | null> {
  if (bridge.isPluginConnected()) return null;
  console.error(callWaitLine({ kind: "connecting", deadline }, Date.now()));
  const expired = AbortSignal.timeout(Math.max(deadline - Date.now(), 0));
  try {
    await bridge.whenPluginConnected(AbortSignal.any([signal, expired]));
    return null;
  } catch (error) {
    if (signal.aborted) throw error;
    return `Blocked: no Figma plugin connected before --wait expired, so ${notDone}. ${pluginDisconnectedAction()}`;
  }
}

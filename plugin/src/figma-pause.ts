/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Has Figma paused this plugin? Figma can stop firing a plugin's timers and resolving its native
// promises (loadFontAsync, setTimeout) while still delivering its messages — seen while the file's
// window or tab is in the background. A run is then stuck at its next await with no error, and every
// run behind it waits. Messages still arrive, so a timer that should have fired long ago is what
// lets the plugin answer "paused" instead of queueing a run that can't finish.
//
// A one-shot setTimeout(0), armed as messages arrive, rather than a heartbeat: a background window
// throttles a CHAINED timer to about one tick a minute while one-shot timers and native calls still
// run promptly, so a heartbeat reads a throttled-but-working plugin as paused.

// Past the longest a synchronous verb holds the thread: a timer that waited behind one isn't paused.
const PAUSED_AFTER_MS = 10_000;

export interface FigmaPauseWatch {
  /** Arm a probe timer, unless one is still waiting to fire. Call as each message arrives. */
  arm(now?: number): void;
  /** How long a probe has waited to fire, when that long means Figma has paused us; else null. */
  pausedForMs(now?: number): number | null;
}

export function watchForFigmaPause(): FigmaPauseWatch {
  let probe: { armedAt: number; fired: boolean } | null = null;
  return {
    arm(now = Date.now()) {
      if (probe && !probe.fired) return;
      const armed = { armedAt: now, fired: false };
      probe = armed;
      setTimeout(() => {
        armed.fired = true;
      }, 0);
    },
    pausedForMs(now = Date.now()) {
      if (!probe || probe.fired) return null;
      const waited = now - probe.armedAt;
      return waited > PAUSED_AFTER_MS ? waited : null;
    },
  };
}

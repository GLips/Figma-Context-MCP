/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Has Figma paused this plugin? Figma can stop firing a plugin's timers and resolving its native
// promises (loadFontAsync, setTimeout) while still delivering its messages — seen while the file's
// window or tab is in the background. A run is then stuck at its next await with no error, and every
// run behind it waits. Messages still arrive, so a heartbeat timer that has gone quiet is what lets
// the plugin answer "paused" instead of queueing a run that can't finish.

const HEARTBEAT_MS = 1_000;
// Figma clamps a background plugin's timers to about a second; well past that, they have stopped.
const PAUSED_AFTER_MS = 5_000;

export interface FigmaPauseWatch {
  /** How long the heartbeat has been silent, when that long means Figma has paused us; else null. */
  pausedForMs(now?: number): number | null;
}

export function watchForFigmaPause(): FigmaPauseWatch {
  let lastBeat = Date.now();
  setInterval(() => {
    lastBeat = Date.now();
  }, HEARTBEAT_MS);
  return {
    pausedForMs(now = Date.now()) {
      const silent = now - lastBeat;
      return silent > PAUSED_AFTER_MS ? silent : null;
    },
  };
}

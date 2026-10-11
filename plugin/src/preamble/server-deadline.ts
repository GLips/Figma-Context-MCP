/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The run's view of the server's inactivity deadline — the backstop for a CANCEL the plugin thread
// has not dispatched yet.
//
// CANCEL is a UI→main message, so it can only be handled once the run yields to the macrotask
// queue. A run that holds the thread past the deadline (a busy loop, a huge synchronous render) and
// then calls a verb would reach the lock's cancellation check with the CANCEL still queued, and
// mutate after the caller was told the run was abandoned. Yielding a macrotask per verb would let
// the CANCEL dispatch first, but Figma clamps a chained setTimeout(0) to ~1s (measured live,
// 2026-10-05), so a batch of verbs would pay a second each. A clock costs nothing per verb.
//
// The server's rule (bridge.ts armInactivityDeadline): the deadline runs from the run's RUN_STATE
// "running", is suspended while a server call is in flight, and re-arms when the last one settles.
// This module mirrors exactly that. Both sides count from the host's stamp on that RUN_STATE, not
// from when it arrives or when this preamble evaluates: the frame leaves only once the plugin thread
// goes idle, so a run that opens with seconds of synchronous work would otherwise have the two
// clocks seconds apart, the plugin refusing writes the server would still accept. Negative space:
// the absolute run ceiling counts from submission, which the run can't see. It is not mirrored here,
// so a run blocked past only the ceiling is still refused only once its CANCEL dispatches.

/** The server's inactivity deadline. bridge.ts imports it, so the two sides read the same number. */
export const RUN_INACTIVITY_DEADLINE_MS = 15_000;

// Module state is per run: the preamble is eval'd fresh for each one. Null until the first server
// call settles; before that the clock runs from the host's runStartedAt.
let lastServerContactAt: number | null = null;
let serverCallsInFlight = 0;

/** Bracket one server call: the server's clock is suspended while it works. */
export async function withServerCall<T>(call: () => Promise<T>): Promise<T> {
  serverCallsInFlight++;
  try {
    return await call();
  } finally {
    serverCallsInFlight--;
    lastServerContactAt = Date.now();
  }
}

/** Whether the server's inactivity deadline has passed by this run's own clock. */
export function serverDeadlinePassed(runStartedAt: number): boolean {
  return serverCallsInFlight === 0 && Date.now() - (lastServerContactAt ?? runStartedAt) >= RUN_INACTIVITY_DEADLINE_MS;
}

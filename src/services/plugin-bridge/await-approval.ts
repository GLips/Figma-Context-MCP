// Hold a gated tool call open across the human's Allow, instead of bouncing the agent back for a retry.
//
// The relay knows the instant approval lands; the agent doesn't, and can only learn by calling again.
// So a "not approved yet" reply used to cost a full round-trip: surface the pairing code, wait for the
// human, re-issue the identical call. Waiting HERE collapses that to one call — the poll that sees the
// approval executes the code and returns the real result.
//
// Re-sending is safe because a gated request never ran: the plugin's gateWrite (plugin/src/code.ts)
// refuses BEFORE dispatching to the sandbox, so PENDING_APPROVAL carries no side effect to double. It
// also emits no toast — it only calls setExpanded(true) on an already-expanded strip — so polling can't
// spam the human.
//
// WHY BOUNDED, AND WHY NOT PROGRESS NOTIFICATIONS (both verified against @modelcontextprotocol/sdk@1.29.0):
// the client's DEFAULT_REQUEST_TIMEOUT_MSEC is 60_000, and the obvious way to outlive it —
// notifications/progress — does NOT work here. `resetTimeoutOnProgress` is a CLIENT-side request option
// defaulting to FALSE (shared/protocol.js: `options?.resetTimeoutOnProgress ?? false`), and the spec says
// implementations "MAY choose to reset the timeout clock", not SHOULD. A server cannot turn it on. So the
// wait must simply FIT INSIDE the client's timeout rather than try to extend it, and correctness here
// rests on the ceiling below — not on any client honoring a heartbeat.

/** The plugin's refusal for a session the human hasn't approved (plugin/src/code.ts gateWrite). */
export function isPendingApproval(reply: unknown): boolean {
  return (
    typeof reply === "object" &&
    reply !== null &&
    "type" in reply &&
    reply.type === "PENDING_APPROVAL"
  );
}

// The ceiling on how long one gated call waits for the human. The wait and the execution that follows it
// share ONE tool call's budget against the MCP client's 60s default. Since protocol 2, execution is not
// a flat 15s worst case: the inactivity deadline re-arms on run traffic, and the true cap is the bridge's
// 45s run ceiling (bridge.ts DEFAULT_RUN_CEILING_MS — keep the two in sync) — so this wait plus a
// worst-case run cannot BOTH fit inside 60s, and that is accepted deliberately: a long wait means the
// human just clicked Allow on a fresh session, and the first run after Allow is interactive and short; a
// run that needs its full ceiling happens on an already-approved session where the wait is zero. Past
// the ceiling the caller falls back to the retryable "not approved yet" text, which is still the right
// answer for a human who stepped away.
//
// A second case exceeds the arithmetic and is likewise accepted rather than designed around: a poll that
// lands on a plugin which has just reconnected holds on the bridge's compatibility gate (bridge.ts), and
// that hold ends only when the new connection's GET_VERSION answers or times out — so a plugin that
// connects and then goes silent can add a full inactivity timeout. It needs a mid-wait reconnect to a
// plugin that speaks WS but never answers the handshake; the common reconnect answers in a round-trip
// and costs nothing. Widening the ceiling's guarantee to cover it would mean bounding the hold against
// the remaining budget, which is not worth the machinery for this shape.
export const APPROVAL_WAIT_MS = 40_000;

// How often to re-offer the request while waiting. Fast enough that clicking Allow feels immediate,
// slow enough that the wait is ~50 cheap loopback round-trips rather than a spin.
const APPROVAL_POLL_MS = 750;

interface ApprovalWaitDeps {
  waitMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Send a request, and keep re-sending while the plugin reports the session unapproved, until it is
 * approved or `waitMs` elapses. Returns the last reply either way — an approved run's real result, or
 * the final PENDING_APPROVAL for the caller to shape into its retryable message.
 *
 * The deadline is WALL-CLOCK, not an attempt count: each send costs real time too, and the whole point
 * of the bound is fitting inside the client's request timeout.
 *
 * RIDES THROUGH A MID-WAIT RECONNECT, and that is load-bearing rather than defensive. The plugin's
 * socket drops routinely (a Figma reload, a server restart, a laptop blip) and ui.html redials on a ~1s
 * cadence; PluginBridge answers a drop by rejecting every in-flight request (failPending) and rejects
 * fresh ones with "No Figma plugin connected" until the socket is back. Holding for the whole window
 * instead of issuing one quick request widens that window enormously, so propagating the first transport
 * error would die on exactly the blip this exists to outlast.
 *
 * The FIRST send is deliberately NOT shielded: when no plugin is connected at all, that must fail fast
 * with the bridge's own message instead of hanging the agent for the full window. Only after one
 * PENDING_APPROVAL — which proves a plugin was there and the session merely lacks consent — do errors
 * become rideable. If the wait then ends still broken, the transport error is rethrown rather than
 * swallowed into a consent message: "not approved yet" would be a lie about a plugin that went away.
 *
 * This deliberately does NOT wait for a plugin to (re)connect. A restart leaves a window where the
 * relay is up and the plugin has not yet redialed, and an earlier cut of this file parked here for it;
 * that was the wrong layer. Consent is a human-scale wait, transport is a machine-scale one, and the
 * disconnect is answered where the caller can say something true about it instead — see
 * code-mode-tools.ts's pluginUnavailableReply.
 */
export async function requestUntilApproved(
  send: () => Promise<unknown>,
  {
    waitMs = APPROVAL_WAIT_MS,
    pollMs = APPROVAL_POLL_MS,
    now = Date.now,
    sleep = sleepMs,
  }: ApprovalWaitDeps = {},
): Promise<unknown> {
  const deadline = now() + waitMs;
  let reply = await send();
  if (!isPendingApproval(reply)) return reply;

  let transportError: unknown = null;
  while (now() < deadline) {
    await sleep(pollMs);
    try {
      reply = await send();
      transportError = null;
      if (!isPendingApproval(reply)) return reply;
    } catch (err) {
      transportError = err; // the socket is down mid-wait; ui.html redials, so keep waiting
    }
  }
  if (transportError !== null) throw transportError;
  return reply;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

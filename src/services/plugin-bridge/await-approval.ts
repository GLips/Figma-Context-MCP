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
    (reply as { type: unknown }).type === "PENDING_APPROVAL"
  );
}

// The ceiling on how long one gated call waits for the human. Sits well under the MCP client's 60s
// default request timeout, leaving headroom for the code to actually RUN after approval lands — the
// wait and the execution share one tool call's budget. Past this the caller falls back to the retryable
// "not approved yet" text, which is still the right answer for a human who stepped away.
export const APPROVAL_WAIT_MS = 45_000;

// How often to re-offer the request while waiting. Fast enough that clicking Allow feels immediate,
// slow enough that a 45s wait is ~60 cheap loopback round-trips rather than a spin.
const APPROVAL_POLL_MS = 750;

export interface ApprovalWaitDeps {
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
  while (isPendingApproval(reply) && now() < deadline) {
    await sleep(pollMs);
    reply = await send();
  }
  return reply;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

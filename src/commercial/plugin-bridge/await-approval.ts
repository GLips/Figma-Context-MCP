/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { APPROVAL_POLL_MS, type PendingApprovalReply } from "@framelink/plugin/protocol";
import type { ApprovedSession } from "./approval-session.js";
import type { ApprovalStatus } from "./bridge.js";
import { approvalGuidance } from "./blocked-call-guidance.js";

/** Only status requests repeat. Code remains local until approval and is submitted once. */
export function isPendingApproval(reply: object): reply is PendingApprovalReply {
  return "type" in reply && reply.type === "PENDING_APPROVAL";
}

/**
 * The approval wait ended without a grant: the plugin couldn't be asked, the human rejected the
 * session, or nothing answered in time. Nothing was submitted, whichever it was.
 */
export class ApprovalWaitError extends Error {
  constructor(
    message: string,
    readonly reason: "unavailable" | "rejected" | "unresponsive",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ApprovalWaitError";
  }
}

// Human-scale wait. SDK 1.29 only resets idle timeouts if the CLIENT opts into
// resetTimeoutOnProgress. Caller abort wins. A private client deadline that sends
// neither cancellation nor disconnect is not observable by this server. SDK 1.29
// has such a path when progress exceeds maxTotalTimeout (shared/protocol.js _onprogress).
export const APPROVAL_WAIT_MS = 120_000;

interface ApprovalWaitDeps {
  waitMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  onWaiting?: () => () => Promise<void>;
}

/** What a granted wait submitted, under the session the granting poll admitted. */
export interface ApprovedSubmission<R> {
  session: ApprovedSession | null;
  result: R;
}

/**
 * Poll the plugin's decision until it grants, then submit exactly once. `submit` receives the session
 * the granting poll admitted, and the same session comes back beside its result, so the run is
 * attributed to the Allow that let it in.
 */
export async function requestUntilApproved<R>(
  status: (signal: AbortSignal) => Promise<ApprovalStatus>,
  submit: (signal: AbortSignal, session: ApprovedSession | null) => Promise<R>,
  {
    waitMs = APPROVAL_WAIT_MS,
    pollMs = APPROVAL_POLL_MS,
    now = Date.now,
    sleep,
    signal,
    onWaiting,
  }: ApprovalWaitDeps = {},
): Promise<ApprovedSubmission<R> | PendingApprovalReply> {
  const deadline = now() + waitMs;
  const local = new AbortController();
  const abort = () => local.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const expired = new ApprovalWaitError(
    approvalGuidance({ kind: "unresponsive" }, "mcp"),
    "unresponsive",
  );
  const timeout = setTimeout(() => local.abort(expired), waitMs);
  let stop: (() => Promise<void>) | undefined;
  // The timer can win the race against the deadline checks below (or cut a hung poll). Once a poll
  // has said PENDING, that expiry is still "approval pending" and must reach the caller as such.
  let lastPending: PendingApprovalReply | undefined;
  try {
    for (;;) {
      local.signal.throwIfAborted();
      let reply: ApprovalStatus;
      try {
        reply = await status(local.signal);
      } catch (error) {
        local.signal.throwIfAborted();
        throw new ApprovalWaitError(
          `Approval status unavailable; no code was submitted. ${error instanceof Error ? error.message : String(error)}`,
          "unavailable",
          { cause: error },
        );
      }
      local.signal.throwIfAborted();
      if (reply.type === "APPROVAL_REJECTED")
        throw new ApprovalWaitError(approvalGuidance({ kind: "rejected" }, "mcp"), "rejected");
      if (reply.type === "APPROVAL_GRANTED") {
        // Stop approval feedback before execution; never catch/retry a submitted run.
        clearTimeout(timeout);
        await stop?.();
        stop = undefined;
        local.signal.throwIfAborted();
        return { session: reply.session, result: await submit(local.signal, reply.session) };
      }
      lastPending = reply;
      if (now() >= deadline) return reply;
      stop ??= onWaiting?.();
      const delay = Math.min(pollMs, deadline - now());
      if (sleep) await sleep(delay);
      else await pause(delay, local.signal);
      if (now() >= deadline) return reply;
    }
  } catch (error) {
    if (local.signal.reason === expired && lastPending !== undefined) return lastPending;
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    await stop?.();
  }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

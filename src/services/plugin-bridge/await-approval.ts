/** Only status requests repeat. Code remains local until approval and is submitted once. */
export function isPendingApproval(reply: unknown): boolean {
  return (
    typeof reply === "object" &&
    reply !== null &&
    "type" in reply &&
    reply.type === "PENDING_APPROVAL"
  );
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

export async function requestUntilApproved(
  status: (signal: AbortSignal) => Promise<unknown>,
  submit: (signal: AbortSignal) => Promise<unknown>,
  {
    waitMs = APPROVAL_WAIT_MS,
    pollMs = 750,
    now = Date.now,
    sleep,
    signal,
    onWaiting,
  }: ApprovalWaitDeps = {},
): Promise<unknown> {
  const deadline = now() + waitMs;
  const local = new AbortController();
  const abort = () => local.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timeout = setTimeout(
    () => local.abort(new Error("Approval wait expired; no code was submitted.")),
    waitMs,
  );
  let stop: (() => Promise<void>) | undefined;
  try {
    for (;;) {
      local.signal.throwIfAborted();
      let reply: unknown;
      try {
        reply = await status(local.signal);
      } catch (error) {
        local.signal.throwIfAborted();
        throw new Error(
          `Approval status unavailable; no code was submitted. ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      local.signal.throwIfAborted();
      if (typeof reply !== "object" || reply === null || !("type" in reply)) {
        throw new Error("Invalid approval status; no code was submitted.");
      }
      if (reply.type === "APPROVAL_REJECTED")
        throw new Error("Approval rejected; no code was submitted.");
      if (reply.type === "APPROVAL_GRANTED") {
        // Stop approval feedback before execution; never catch/retry a submitted run.
        clearTimeout(timeout);
        await stop?.();
        stop = undefined;
        local.signal.throwIfAborted();
        return await submit(local.signal);
      }
      if (!isPendingApproval(reply))
        throw new Error("Unexpected approval status; no code was submitted.");
      if (now() >= deadline) return reply;
      stop ??= onWaiting?.();
      const delay = Math.min(pollMs, deadline - now());
      if (sleep) await sleep(delay);
      else await pause(delay, local.signal);
      if (now() >= deadline) return reply;
    }
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

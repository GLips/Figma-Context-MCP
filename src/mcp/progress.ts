import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** No-ops silently when the client didn't ask for progress (no progressToken). */
export async function sendProgress(
  extra: ToolExtra,
  progress: number,
  total?: number,
  message?: string,
): Promise<void> {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return;

  await extra.sendNotification({
    method: "notifications/progress",
    params: { progressToken, progress, total, message },
  });
}

/**
 * Send periodic progress notifications during a long-running operation.
 * Keeps clients with resetTimeoutOnProgress alive during slow I/O like
 * Figma API calls that can take up to ~55 seconds. Returns an async stop
 * function that must be awaited when the operation completes or errors —
 * it both clears the interval and waits for the most recent in-flight
 * send so a tick that fired microseconds before stop cannot land on the
 * wire after the tool's response (which would orphan its progressToken
 * and crash strict clients — see issue #362).
 */
export function startProgressHeartbeat(
  extra: ToolExtra,
  message: string | (() => string),
  intervalMs = 3_000,
): () => Promise<void> {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return async () => {};

  let tick = 0;
  let lastSend: Promise<void> | undefined;
  const interval = setInterval(() => {
    tick++;
    const msg = typeof message === "function" ? message() : message;
    lastSend = extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress: tick, message: msg },
      })
      .catch(() => clearInterval(interval));
  }, intervalMs);

  return async () => {
    clearInterval(interval);
    await lastSend;
  };
}

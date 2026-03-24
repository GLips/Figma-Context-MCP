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
 * Figma API calls that can take up to ~55 seconds. Returns a stop function
 * that must be called when the operation completes or errors.
 */
export function startProgressHeartbeat(
  extra: ToolExtra,
  message: string,
  intervalMs = 5_000,
): () => void {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return () => {};

  let tick = 0;
  const interval = setInterval(() => {
    tick++;
    extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress: tick, message },
      })
      .catch(() => clearInterval(interval));
  }, intervalMs);

  return () => clearInterval(interval);
}

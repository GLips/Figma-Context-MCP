/** JSON failure envelope. Codes are open-ended; capability-owned JSON fields pass through. */
export interface ChannelFailure {
  code: string;
  message: string;
  details?: unknown;
  [field: string]: unknown;
}

/** Preserve JSON object failures and custom Error fields; supply defaults for ordinary throws. */
export function channelFailure(error: unknown): ChannelFailure {
  if (error !== null && typeof error === "object") {
    return {
      ...error,
      code: "code" in error && typeof error.code === "string" ? error.code : "COMPUTATION_FAILED",
      message:
        "message" in error && typeof error.message === "string"
          ? error.message
          : "The server capability failed.",
    };
  }
  return { code: "COMPUTATION_FAILED", message: String(error) };
}

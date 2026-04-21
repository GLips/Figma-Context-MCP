/**
 * Structured metadata attached to thrown errors so telemetry can categorize
 * failures without parsing error messages. Producers tag errors via `tagError`;
 * consumers read merged meta from the error chain via `getErrorMeta`.
 *
 * Why a Symbol key: it never collides with caller-defined error fields and
 * doesn't show up in `Object.keys` or `JSON.stringify`, so attaching meta is
 * invisible to downstream code that doesn't know about it.
 *
 * Why mutate instead of wrapping: re-throwing the original error preserves
 * the stack trace and instance identity. A subclass tree would drown the
 * useful debugging info in synthetic frames. Wrapping is reserved for the
 * cases where we want to add context to the message itself (e.g. figma.ts
 * annotates the endpoint), and those wrappers chain via `cause` so the
 * original meta is still discoverable.
 */

export type ErrorPhase =
  | "validate"
  | "fetch"
  | "simplify"
  | "serialize"
  | "download"
  | "format_response";

export type ErrorCategory =
  | "rate_limit"
  | "auth"
  | "not_found"
  | "invalid_input"
  | "network"
  | "figma_api"
  | "image_download"
  | "internal";

export type ErrorMeta = {
  phase?: ErrorPhase;
  category?: ErrorCategory;
  http_status?: number;
  network_code?: string;
  fs_code?: string;
  is_retryable?: boolean;
  /**
   * Identifier-free message template used by telemetry in place of
   * `error.message`. Producers that know their error string can contain Figma
   * file keys or node IDs attach a safe template here at throw time, so
   * telemetry never has to guess at redaction by parsing the final message.
   * The regex pass in `telemetry/client.ts` remains as a belt-and-braces
   * fallback for untagged errors.
   */
  safe_message?: string;
};

const META = Symbol.for("framelink.errorMeta");

type WithMeta = { [META]?: ErrorMeta };

/**
 * Attach metadata to an error and re-throw it. Existing meta on the same
 * error is preserved; new fields override matching keys.
 */
export function tagError(error: unknown, meta: ErrorMeta): never {
  if (error && typeof error === "object") {
    const existing = (error as WithMeta)[META] ?? {};
    (error as WithMeta)[META] = { ...existing, ...meta };
  }
  throw error;
}

/**
 * Walk the error → cause chain and merge any attached meta. Outer errors win
 * for overlapping keys — a `phase` tagged at the pipeline level should not be
 * overridden by an inner wrapper that doesn't know which phase it's running in.
 */
export function getErrorMeta(error: unknown): ErrorMeta {
  const merged: ErrorMeta = {};
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const meta = (current as WithMeta)[META];
    if (meta) {
      for (const [key, value] of Object.entries(meta) as Array<[keyof ErrorMeta, unknown]>) {
        if (merged[key] === undefined && value !== undefined) {
          (merged as Record<string, unknown>)[key] = value;
        }
      }
    }
    current = (current as { cause?: unknown }).cause;
  }
  return merged;
}

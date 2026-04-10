import { tagError, type ErrorCategory } from "~/utils/error-meta.js";

type RequestOptions = RequestInit & {
  /**
   * Force format of headers to be a record of strings, e.g. { "Authorization": "Bearer 123" }
   *
   * Avoids complexity of needing to deal with `instanceof Headers`, which is not supported in some environments.
   */
  headers?: Record<string, string>;
};

/**
 * Error thrown on HTTP failures. Carries response headers so callers (e.g.
 * figma.ts) can read rate-limit metadata without needing access to the
 * original Response object.
 */
export type HttpError = Error & { responseHeaders?: Record<string, string> };

const CONNECTION_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
]);

// HTTP statuses where retrying might succeed: rate limits and transient
// server-side failures. 4xx other than 429 are caller errors and not retryable.
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function fetchJSON<T extends { status?: number }>(
  url: string,
  options: RequestOptions = {},
): Promise<{ data: T; rawSize: number }> {
  try {
    const response = await fetch(url, options);

    if (!response.ok) {
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      const httpError: HttpError = Object.assign(
        new Error(`Fetch failed with status ${response.status}: ${response.statusText}`),
        { responseHeaders },
      );
      tagError(httpError, {
        http_status: response.status,
        category: httpStatusCategory(response.status),
        is_retryable: RETRYABLE_STATUSES.has(response.status),
      });
    }
    // Read as text first so we can measure the raw body size for telemetry,
    // then parse. This is the same work response.json() does internally, just
    // split so we can observe the byte count before parsing.
    const text = await response.text();
    const rawSize = Buffer.byteLength(text, "utf8");
    const data = JSON.parse(text) as T;
    return { data, rawSize };
  } catch (error: unknown) {
    const networkCode = getConnectionErrorCode(error);
    if (networkCode) {
      const message = error instanceof Error ? error.message : String(error);
      const wrapped = new Error(
        `${message}\n\nCould not connect to the Figma API. If your network requires a proxy, ` +
          `set the --proxy flag in your MCP server config or the FIGMA_PROXY environment variable ` +
          `to your proxy URL (e.g. http://proxy:8080).`,
        { cause: error },
      );
      tagError(wrapped, { network_code: networkCode, category: "network", is_retryable: true });
    }
    throw error;
  }
}

function getConnectionErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const cause = (error as { cause?: { code?: string } }).cause;
  if (cause?.code && CONNECTION_ERROR_CODES.has(cause.code)) return cause.code;
  return undefined;
}

function httpStatusCategory(status: number): ErrorCategory {
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "auth";
  return "figma_api";
}

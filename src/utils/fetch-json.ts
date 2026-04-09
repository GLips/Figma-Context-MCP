type RequestOptions = RequestInit & {
  /**
   * Force format of headers to be a record of strings, e.g. { "Authorization": "Bearer 123" }
   *
   * Avoids complexity of needing to deal with `instanceof Headers`, which is not supported in some environments.
   */
  headers?: Record<string, string>;
};

const CONNECTION_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export async function fetchJSON<T extends { status?: number }>(
  url: string,
  options: RequestOptions = {},
): Promise<{ data: T; rawSize: number }> {
  try {
    const response = await fetch(url, options);

    if (!response.ok) {
      throw new Error(`Fetch failed with status ${response.status}: ${response.statusText}`);
    }
    // Read as text first so we can measure the raw body size for telemetry,
    // then parse. This is the same work response.json() does internally, just
    // split so we can observe the byte count before parsing.
    const text = await response.text();
    const rawSize = Buffer.byteLength(text, "utf8");
    const data = JSON.parse(text) as T;
    return { data, rawSize };
  } catch (error: unknown) {
    if (isConnectionError(error)) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message}\n\nCould not connect to the Figma API. If your network requires a proxy, ` +
          `set the --proxy flag in your MCP server config or the FIGMA_PROXY environment variable ` +
          `to your proxy URL (e.g. http://proxy:8080).`,
      );
    }
    throw error;
  }
}

function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const cause = (error as { cause?: { code?: string } }).cause;
  return cause?.code !== undefined && CONNECTION_ERROR_CODES.has(cause.code);
}

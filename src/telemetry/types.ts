import type { ParamRejection } from "~/mcp/validation-capture.js";

export type Transport = "stdio" | "http" | "cli";
export type AuthMode = "oauth" | "api_key" | "none";
export type ClientInfo = { name?: string; version?: string };

export interface InitTelemetryOptions {
  /** The resolved opt-in, from `resolveTelemetryEnabled` in config.ts. */
  enabled: boolean;
  /**
   * Flush events immediately instead of batching. For short-lived processes
   * (e.g. the `fetch` CLI command) that would otherwise exit before the
   * default flush interval fires and drop the event.
   */
  immediateFlush?: boolean;
  /**
   * Strings to scrub from every string-valued event property, and from
   * reported errors, before sending to PostHog. The shell passes whatever it
   * considers sensitive (API keys, OAuth tokens, etc). Empty strings are
   * filtered automatically so callers don't have to.
   */
  redactFromTelemetry?: string[];
}

/** Who is calling, the same for every call one MCP server answers. */
export type ToolCallContext = {
  transport: Transport;
  authMode: AuthMode;
  /** Known once the client has initialized, hence read per event. */
  readonly clientInfo?: ClientInfo;
};

/**
 * Tool-specific event properties, snake_case. Codes, counts and flags only — never authored code,
 * returned content or a message that quotes either. Strings are still scrubbed at the boundary.
 */
export type ToolEventProperties = Readonly<
  Record<string, string | number | boolean | null | undefined>
>;

/** One finished tool call, as a tool's composition reports it. */
export type ToolCallEvent = {
  tool: string;
  durationMs: number;
  isError: boolean;
  /** The failure behind `isError`, when there is one: reported as codes, and to error tracking if unexpected. */
  error?: unknown;
  /** The arguments failed validation, so the tool's work never ran. */
  rejection?: ParamRejection;
  properties?: ToolEventProperties;
};

export type ErrorCallProps = {
  error_type: string;
  error_phase?: string;
  error_category?: string;
  http_status?: number;
  network_code?: string;
  fs_code?: string;
  is_retryable?: boolean;
  /** Who answered a failed HTTP request (Figma, which proxy vendor), from response-body-fingerprint.ts. */
  response_fingerprint?: string;
};

export type Transport = "stdio" | "http" | "cli";
export type AuthMode = "oauth" | "api_key";
export type ClientInfo = { name?: string; version?: string };

export interface InitTelemetryOptions {
  optOut?: boolean;
  /**
   * Flush events immediately instead of batching. For short-lived processes
   * (e.g. the `fetch` CLI command) that would otherwise exit before the
   * default flush interval fires and drop the event.
   */
  immediateFlush?: boolean;
  /**
   * Strings to scrub from `error_message` before sending events to PostHog.
   * The shell passes whatever it considers sensitive (API keys, OAuth tokens,
   * etc). Empty strings are filtered automatically so callers don't have to.
   */
  redactFromErrors?: string[];
}

export type ToolCallContext = {
  transport: Transport;
  authMode: AuthMode;
  clientInfo?: ClientInfo;
};

export type ValidationRejectInput = {
  tool: "get_figma_data" | "download_figma_images";
  durationMs?: number;
  field: string;
  rule: string;
  message: string;
  outputFormat?: "yaml" | "json";
};

// Event schemas — used by capture.ts for shaping PostHog events.

export type CommonCallProps = {
  duration_ms: number;
  transport: Transport;
  auth_mode: AuthMode;
  client_name?: string;
  client_version?: string;
  is_error: boolean;
  error_type?: string;
  error_message?: string;
  error_phase?: string;
  http_status?: number;
  network_code?: string;
  fs_code?: string;
  is_retryable?: boolean;
  validation_field?: string;
  validation_rule?: string;
};

export type GetFigmaDataCall = CommonCallProps & {
  tool: "get_figma_data";
  output_format: "yaml" | "json";
  raw_size_kb?: number;
  simplified_size_kb?: number;
  raw_node_count?: number;
  simplified_node_count?: number;
  max_depth?: number;
  named_style_count?: number;
  component_count?: number;
  instance_count?: number;
  text_node_count?: number;
  image_node_count?: number;
  component_property_count?: number;
  has_variables?: boolean;
  fetch_ms?: number;
  simplify_ms?: number;
  serialize_ms?: number;
  depth: number | null;
  has_node_id: boolean;
};

export type DownloadFigmaImagesCall = CommonCallProps & {
  tool: "download_figma_images";
  image_count: number;
  success_count?: number;
};

export type ToolCallProperties = GetFigmaDataCall | DownloadFigmaImagesCall;

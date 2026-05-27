import type { FigmaAuthOptions } from "~/services/figma.js";
import type { AuthMode } from "./types.js";

export { initTelemetry, shutdown, resolveTelemetryEnabled, withRequestSecrets } from "./client.js";
export {
  captureGetFigmaDataCall,
  captureDownloadImagesCall,
  captureValidationReject,
} from "./capture.js";
export type {
  Transport,
  AuthMode,
  InitTelemetryOptions,
  ClientInfo,
  ToolCallContext,
  ValidationRejectInput,
} from "./types.js";

/**
 * Single source of truth for converting auth options into a telemetry
 * `AuthMode`. `none` represents an HTTP server with no global credentials and
 * no `X-Figma-Token` on the request — the call will fail in `getAuthHeaders`,
 * and reporting it as `api_key` would skew multi-tenant deployment metrics.
 */
export function authMode(auth: FigmaAuthOptions): AuthMode {
  if (auth.useOAuth) return "oauth";
  if (auth.figmaApiKey) return "api_key";
  return "none";
}

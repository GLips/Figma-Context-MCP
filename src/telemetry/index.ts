import type { FigmaCredential } from "~/services/figma.js";
import type { AuthMode } from "./types.js";

export { initTelemetry, shutdown } from "./client.js";
export {
  captureToolCall,
  captureGetFigmaDataCall,
  getFigmaDataCallEvent,
  downloadImagesCallEvent,
} from "./capture.js";
export type {
  Transport,
  AuthMode,
  InitTelemetryOptions,
  ClientInfo,
  ToolCallContext,
  ToolCallEvent,
  ToolEventProperties,
} from "./types.js";

/**
 * Single source of truth for converting auth options into a telemetry
 * `AuthMode`. `none` represents an HTTP server with no global credentials and
 * no `X-Figma-Token` on the request — the call will fail in `getAuthHeaders`,
 * and reporting it as `api_key` would skew multi-tenant deployment metrics.
 */
export function authMode(credential: FigmaCredential | undefined): AuthMode {
  if (!credential) return "none";
  return credential.kind === "oauth" ? "oauth" : "api_key";
}

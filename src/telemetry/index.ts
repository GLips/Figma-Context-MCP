export { initTelemetry, shutdown, resolveTelemetryEnabled } from "./client.js";
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

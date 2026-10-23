// The feedback watch. Registered by the local server only, never the embeddable read entry
// (read-tools.ts): it holds a call open for up to 40s and polls the comments endpoint while it does,
// which a host serving many callers shouldn't take on by default.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FigmaService } from "~/services/figma.js";
import type { AnnotationChangeSource } from "~/services/watch-figma-feedback.js";
import {
  registerFramelinkTool,
  type FramelinkToolCall,
  type ObserveToolCall,
} from "./framelink-tool.js";
import type { ToolExtra } from "./progress.js";
import {
  watchFigmaFeedbackTool,
  type WatchFigmaFeedbackOutcome,
  type WatchFigmaFeedbackParams,
} from "./tools/index.js";

export function registerFeedbackWatchTool(
  server: McpServer,
  figmaService: FigmaService,
  annotations: AnnotationChangeSource | null,
  observe: ObserveToolCall<"watch_figma_feedback", WatchFigmaFeedbackOutcome>,
): void {
  registerFramelinkTool(
    server,
    {
      name: watchFigmaFeedbackTool.name,
      title: "Watch Figma Feedback",
      description: watchFigmaFeedbackTool.description,
      inputSchema: watchFigmaFeedbackTool.parameters,
      unknownParams: "fail-loud",
      agentIntent: "user-goal",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: (
        params: WatchFigmaFeedbackParams,
        call: FramelinkToolCall<WatchFigmaFeedbackOutcome>,
        extra: ToolExtra,
      ) =>
        watchFigmaFeedbackTool.handler(params, figmaService.withSignal(extra.signal), {
          annotations,
          extra,
          onComplete: call.record,
        }),
    },
    observe,
  );
}

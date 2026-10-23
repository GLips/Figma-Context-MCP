// The REST comment writes. Registered by the local server only, never the embeddable read entry
// (read-tools.ts): that entry promises its hosts a surface that changes nothing in Figma.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FigmaService } from "~/services/figma.js";
import {
  registerFramelinkTool,
  type FramelinkToolCall,
  type ObserveToolCall,
} from "./framelink-tool.js";
import type { ToolExtra } from "./progress.js";
import {
  replyToFigmaCommentTool,
  type ReplyToFigmaCommentOutcome,
  type ReplyToFigmaCommentParams,
} from "./tools/index.js";

export function registerCommentWriteTools(
  server: McpServer,
  figmaService: FigmaService,
  observe: ObserveToolCall<"reply_to_figma_comment", ReplyToFigmaCommentOutcome>,
): void {
  registerFramelinkTool(
    server,
    {
      name: replyToFigmaCommentTool.name,
      title: "Reply to Figma Comment",
      description: replyToFigmaCommentTool.description,
      inputSchema: replyToFigmaCommentTool.parameters,
      unknownParams: "fail-loud",
      agentIntent: "user-goal",
      // Adds a reply; never edits or deletes one. Posting twice posts twice.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      handler: (
        params: ReplyToFigmaCommentParams,
        call: FramelinkToolCall<ReplyToFigmaCommentOutcome>,
        extra: ToolExtra,
      ) =>
        replyToFigmaCommentTool.handler(params, figmaService.withSignal(extra.signal), {
          onComplete: call.record,
        }),
    },
    observe,
  );
}

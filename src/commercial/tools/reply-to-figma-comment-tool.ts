/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { z } from "zod";
import type { ServerExtension } from "~/mcp/index.js";
import { registerFramelinkTool, type FramelinkToolCall } from "~/mcp/framelink-tool.js";
import type { ToolExtra } from "~/mcp/progress.js";
import type { FigmaService } from "~/services/figma.js";
import {
  replyToFigmaComment,
  type ReplyToFigmaCommentOptions,
} from "~/commercial/reply-to-figma-comment.js";
import {
  FIGMA_FILE_KEY_FORMAT_MESSAGE,
  FIGMA_FILE_KEY_PATTERN,
  figmaFileKey,
  type FigmaFileKey,
} from "~/utils/figma-url.js";
import { Logger } from "~/utils/logger.js";

const parameters = {
  fileKey: z
    .string()
    .regex(FIGMA_FILE_KEY_PATTERN, FIGMA_FILE_KEY_FORMAT_MESSAGE)
    .describe("The Figma file key, from a URL like figma.com/(file|design)/<fileKey>/..."),
  commentId: z
    .string()
    .regex(/^\d+$/, "A Figma comment id is digits only, e.g. 1957645446")
    .describe(
      "The newest comment in the thread you've read — the root or a reply — from get_figma_comments with include: full. If someone commented after it, nothing is posted and you get their comments.",
    ),
  message: z
    .string()
    .trim()
    .min(1)
    .describe("The reply, plain text. It is posted with an [AGENT] prefix."),
  handled: z
    .boolean()
    .describe(
      "true when this reply settles the thread, so it drops out of unresolved reads until someone replies again. false when it asks a question or leaves work open.",
    ),
};

const parametersSchema = z.object(parameters);
export type ReplyToFigmaCommentParams = z.input<typeof parametersSchema>;

/** What a reply call reports: a code, never the message or the thread. */
type ReplyToFigmaCommentFacts = { outcome: "posted" | "stale" | "mark_failed" | "failed" };

/** Validates raw params, from the MCP tool or the `reply` CLI command, into the service's arguments. */
export function parseReplyToFigmaCommentParams(params: ReplyToFigmaCommentParams): {
  fileKey: FigmaFileKey;
  options: ReplyToFigmaCommentOptions;
} {
  const { fileKey, ...options } = parametersSchema.parse(params);
  return { fileKey: figmaFileKey(fileKey), options };
}

async function handleReplyToFigmaComment(
  params: ReplyToFigmaCommentParams,
  figmaService: FigmaService,
  call: FramelinkToolCall<ReplyToFigmaCommentFacts>,
) {
  try {
    const { fileKey, options } = parseReplyToFigmaCommentParams(params);
    const result = await replyToFigmaComment(figmaService, fileKey, options);
    if (result.kind === "stale") {
      call.record({ outcome: "stale" });
      const { unseen, newestCommentId } = result;
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Not posted: ${unseen.length} newer comment(s) in this thread since ${options.commentId}. Read them, rework the reply if they change it, then call again with commentId ${newestCommentId}.\n${JSON.stringify(result)}`,
          },
        ],
      };
    }
    call.record({ outcome: result.handledMarkError ? "mark_failed" : "posted" });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  } catch (error) {
    call.record({ outcome: "failed" });
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    Logger.error(`Error replying to comment ${params.commentId} in ${params.fileKey}:`, message);
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Error replying to comment: ${message}` }],
    };
  }
}

const REPLY_TO_FIGMA_COMMENT_DESCRIPTION =
  "Answer a Figma comment thread in place, where its author will see it, instead of only in chat. Posts under the user's own Figma account with an [AGENT] prefix, so collaborators can tell it apart. `handled: true` also leaves a ✅ on the thread, which get_figma_comments' unresolved reads skip until a person replies after it. Needs a token with the File comments: Write scope.";

/**
 * Comment replies as an extension of the read server: commercial code, but not a metered Write — a
 * reply doesn't change the design document (LICENSING.md). Spends the caller's own Figma credential.
 */
export function commentReplyExtension(): ServerExtension {
  return {
    register(server, { figmaService, observe }) {
      registerFramelinkTool(
        server,
        {
          name: "reply_to_figma_comment",
          title: "Reply to Figma Comment",
          description: REPLY_TO_FIGMA_COMMENT_DESCRIPTION,
          inputSchema: parameters,
          unknownParams: "fail-loud",
          agentIntent: "user-goal",
          // Adds a reply and sets a reaction; never edits or deletes a comment. Posting twice posts twice.
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
          },
          handler: (
            params: ReplyToFigmaCommentParams,
            call: FramelinkToolCall<ReplyToFigmaCommentFacts>,
            extra: ToolExtra,
          ) => handleReplyToFigmaComment(params, figmaService.withSignal(extra.signal), call),
        },
        observe,
      );
    },
  };
}

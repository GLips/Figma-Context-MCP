import { z } from "zod";
import type { FigmaService } from "~/services/figma.js";
import {
  replyToFigmaComment,
  type ReplyToFigmaCommentOptions,
} from "~/services/reply-to-figma-comment.js";
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

export type ReplyToFigmaCommentOutcome = { durationMs: number; error?: unknown };

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
  { onComplete }: { onComplete: (outcome: ReplyToFigmaCommentOutcome) => void },
) {
  const startedAt = Date.now();
  try {
    const { fileKey, options } = parseReplyToFigmaCommentParams(params);
    const result = await replyToFigmaComment(figmaService, fileKey, options);
    onComplete({ durationMs: Date.now() - startedAt });
    if (result.kind === "stale") {
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
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  } catch (error) {
    onComplete({ durationMs: Date.now() - startedAt, error });
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    Logger.error(`Error replying to comment ${params.commentId} in ${params.fileKey}:`, message);
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Error replying to comment: ${message}` }],
    };
  }
}

export const replyToFigmaCommentTool = {
  name: "reply_to_figma_comment",
  description:
    "Answer a Figma comment thread in place, where its author will see it, instead of only in chat. Posts under the user's own Figma account with an [AGENT] prefix, so collaborators can tell it apart. `handled: true` also leaves a ✅ on the thread, which get_figma_comments' unresolved reads skip until a person replies after it. Needs a token with the File comments: Write scope.",
  parameters,
  handler: handleReplyToFigmaComment,
} as const;

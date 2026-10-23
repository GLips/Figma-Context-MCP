/**
 * The reply tool's work: post an agent's answer into a comment thread and set the thread's handled
 * mark to match.
 *
 * One comments read first, so the agent may name any comment in the thread (Figma only accepts a
 * root) and so the handled reaction is only added or removed when it needs to be. Worst case: one
 * Tier-2 read plus two writes. Once the reply is posted the call succeeds, even if the mark fails.
 */
import type { FigmaService } from "./figma.js";
import {
  AGENT_COMMENT_PREFIX,
  AGENT_HANDLED_REACTION,
  hasHandledReaction,
  isAgentComment,
  readCommentReply,
  type CommentReply,
} from "./figma-comments.js";
import type { FigmaFileKey } from "~/utils/figma-url.js";

export interface ReplyToFigmaCommentOptions {
  /** Any comment in the thread: its root or one of its replies. */
  commentId: string;
  message: string;
  /** The thread's state after this reply: done, or still waiting on someone. */
  handled: boolean;
}

export interface ReplyToFigmaCommentResult {
  /** The thread's root comment id. */
  threadId: string;
  /** The reply as posted, marker included — the same shape `get_figma_comments` reads back. */
  reply: CommentReply;
  /** The thread's handled state as Figma now has it. */
  handled: boolean;
  /** Why the handled mark couldn't be set. The reply itself was posted. */
  handledMarkError?: string;
}

export async function replyToFigmaComment(
  figma: FigmaService,
  fileKey: FigmaFileKey,
  { commentId, message, handled }: ReplyToFigmaCommentOptions,
): Promise<ReplyToFigmaCommentResult> {
  const { comments } = await figma.getComments(fileKey);
  const named = comments.find((comment) => comment.id === commentId);
  if (!named)
    throw new Error(
      `No comment ${commentId} in this file. Comment ids come from get_figma_comments with include: "full".`,
    );
  const root = named.parent_id ? comments.find((comment) => comment.id === named.parent_id) : named;
  if (!root) throw new Error(`Comment ${commentId}'s thread was deleted.`);

  const marked = isAgentComment(message) ? message : `${AGENT_COMMENT_PREFIX} ${message}`;
  const posted = await figma.postCommentReply(fileKey, root.id, marked);

  const result = { threadId: root.id, reply: readCommentReply(posted), handled };
  // The poster is the token's user, so its id is whose reaction counts as the agent's.
  const reacted = hasHandledReaction(root, posted.user.id);
  try {
    if (handled && !reacted)
      await figma.addCommentReaction(fileKey, root.id, AGENT_HANDLED_REACTION);
    // An earlier pass's mark would otherwise hide a thread this reply leaves open.
    if (!handled && reacted)
      await figma.removeCommentReaction(fileKey, root.id, AGENT_HANDLED_REACTION);
  } catch (error) {
    // The reply is already posted. Failing the call here would read as "nothing happened", and the
    // agent's retry would post the reply twice.
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ...result,
      handled: reacted,
      handledMarkError: `The reply was posted, but setting the handled mark failed; don't post it again. ${reason}`,
    };
  }
  return result;
}

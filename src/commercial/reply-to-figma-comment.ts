/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
/**
 * The reply tool's work: post an agent's answer into a comment thread and set the thread's handled
 * mark to match.
 *
 * One comments read first: it finds the thread's root (Figma only accepts a reply to one), refuses a
 * reply written before someone's newer comment, and decides whether the handled reaction needs adding
 * or removing. Worst case: one Tier-2 read plus two writes.
 *
 * Nothing makes this atomic. A person who comments between that read and the post isn't caught, and a
 * handled reply then hides their comment. A second read would only shrink that window, not close it.
 */
import type { Comment } from "@figma/rest-api-spec";
import type { FigmaService } from "~/services/figma.js";
import {
  AGENT_COMMENT_PREFIX,
  AGENT_HANDLED_REACTION,
  commentOrder,
  hasHandledReaction,
  isAgentComment,
  readCommentReply,
  type CommentReply,
} from "~/services/figma-comments.js";
import { getErrorMeta } from "~/utils/error-meta.js";
import type { FigmaFileKey } from "~/utils/figma-url.js";

export interface ReplyToFigmaCommentOptions {
  /** The newest comment in the thread the agent has read: its root or one of its replies. */
  commentId: string;
  message: string;
  /** Whether this reply settles the thread or leaves it waiting on someone. */
  handled: boolean;
}

export type ReplyToFigmaCommentResult =
  | {
      kind: "posted";
      /** The thread's root comment id. */
      threadId: string;
      /** The reply as posted, marker included — the same shape `get_figma_comments` reads back. */
      reply: CommentReply;
      /**
       * The handled mark was set as asked, or already was when the call began. Not a fresh read:
       * absent when setting it failed, and then `handledMarkError` says so.
       */
      handled?: boolean;
      handledMarkError?: string;
    }
  | {
      /** Nothing was posted: people commented after the comment the agent named. */
      kind: "stale";
      threadId: string;
      unseen: CommentReply[];
      /** What to pass as `commentId` once the agent has taken `unseen` into account. */
      newestCommentId: string;
    };

// Statuses Figma answers before it writes anything. Any other failure — a timeout, a dropped
// connection, a 5xx, a proxy's 502 — may come after the reply was saved.
const POST_REFUSED_STATUSES = new Set([400, 401, 403, 404, 429]);

const CHECK_THREAD_HINT =
  'Check the thread with get_figma_comments (include: "full", status: "all", no since) before posting again.';

// `handled` there is the thread's effective state: a person's later reply reopens a thread even with
// the ✅ still on it.
const CHECK_HANDLED_HINT =
  'get_figma_comments (include: "full", status: "all", no since) shows whether the thread now reads as handled.';

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

  const seen = readCommentReply(named);
  const unseen = comments
    .filter((comment) => comment.id === root.id || comment.parent_id === root.id)
    .map(readCommentReply)
    .filter((comment) => !isAgentComment(comment.message) && commentOrder(comment, seen) > 0)
    .sort(commentOrder);
  if (unseen.length)
    return {
      kind: "stale",
      threadId: root.id,
      unseen,
      newestCommentId: unseen[unseen.length - 1].id,
    };

  const marked = isAgentComment(message) ? message : `${AGENT_COMMENT_PREFIX} ${message}`;
  let posted: Comment;
  try {
    posted = await figma.postCommentReply(fileKey, root.id, marked);
  } catch (error) {
    const status = getErrorMeta(error).http_status;
    if (status !== undefined && POST_REFUSED_STATUSES.has(status)) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`The reply may have been posted anyway. ${CHECK_THREAD_HINT}\n${reason}`, {
      cause: error,
    });
  }

  const result = { kind: "posted" as const, threadId: root.id, reply: readCommentReply(posted) };
  // The poster is the token's user, so its id is whose reaction counts as the agent's.
  const reacted = hasHandledReaction(root, posted.user.id);
  try {
    if (handled && !reacted)
      await figma.addCommentReaction(fileKey, root.id, AGENT_HANDLED_REACTION);
    // An earlier pass's mark would otherwise hide a thread this reply leaves open.
    if (!handled && reacted)
      await figma.removeCommentReaction(fileKey, root.id, AGENT_HANDLED_REACTION);
  } catch (error) {
    // The reply is already posted. Failing the call would read as "nothing happened", and the agent's
    // retry would post it twice. The mark may have landed anyway, so no `handled` is claimed.
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ...result,
      handledMarkError: `The reply was posted; don't post it again. Setting the handled mark failed, and the ✅ may or may not be on the thread. ${CHECK_HANDLED_HINT} ${reason}`,
    };
  }
  return { ...result, handled };
}

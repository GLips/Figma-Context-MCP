/**
 * Figma's flat comment list → threads, and the pin each thread carries.
 *
 * Shared by the REST comments tool and the plugin's comment counts (through the server channel), so the
 * two read Figma's `client_meta` the same way. Pure: no fetching, no geometry.
 */
import type { Comment } from "@figma/rest-api-spec";

/**
 * Opens every comment an agent posts through Framelink. Agent writes go out under the user's own
 * token, so they carry the user's name: without this marker a later read takes the agent's reply for
 * new feedback and the agent answers itself.
 */
export const AGENT_COMMENT_PREFIX = "[AGENT]";

/**
 * The reaction an agent leaves on a thread's root once it has dealt with it. Figma's API can't
 * resolve a thread, so this is how a read tells handled threads from open ones. Figma reads it back
 * as this same shortcode.
 */
export const AGENT_HANDLED_REACTION = ":white_check_mark:";

// Figma returns the marker verbatim, `as_md` or not (checked live), so a prefix match is enough.
export function isAgentComment(message: string): boolean {
  return message.startsWith(AGENT_COMMENT_PREFIX);
}

export interface CommentPoint {
  x: number;
  y: number;
}

/**
 * Where Figma put a thread's pin. `nodeId` is the top-level frame or the PAGE under the pin — the wire
 * shape is identical for both, so telling them apart takes the document. A pin with no `nodeId` is a
 * legacy bare canvas point: it names no page, and nothing here guesses one.
 */
export type CommentPin =
  | { nodeId: string; offset: CommentPoint }
  | { nodeId?: undefined; point: CommentPoint };

export interface CommentAuthor {
  id: string;
  handle: string;
}

export interface CommentReply {
  id: string;
  author: CommentAuthor;
  createdAt: string;
  message: string;
}

export interface CommentThread extends CommentReply {
  resolvedAt: string | null;
  /**
   * An agent answered last and marked the thread done: the newest comment is an agent's, and its
   * poster left the handled reaction on the root. A human reply after it reopens the thread.
   */
  handled: boolean;
  /** Null only for a root Figma sent without `client_meta` — unlocated, like a bare canvas point. */
  pin: CommentPin | null;
  replies: CommentReply[];
}

/**
 * Join replies under their roots (newest root first, replies oldest first). A reply whose root isn't in
 * the list is dropped: Figma only returns replies alongside their thread, so an orphan means the root
 * was deleted.
 */
export function readCommentThreads(comments: readonly Comment[]): CommentThread[] {
  const threads = new Map<string, { thread: CommentThread; root: Comment }>();
  for (const comment of comments) {
    if (comment.parent_id) continue;
    threads.set(comment.id, {
      root: comment,
      thread: {
        ...readCommentReply(comment),
        resolvedAt: comment.resolved_at ?? null,
        handled: false,
        pin: readCommentPin(comment.client_meta),
        replies: [],
      },
    });
  }
  for (const comment of comments) {
    if (comment.parent_id)
      threads.get(comment.parent_id)?.thread.replies.push(readCommentReply(comment));
  }
  const byTime = (a: { createdAt: string }, b: { createdAt: string }) =>
    a.createdAt.localeCompare(b.createdAt);
  for (const { thread, root } of threads.values()) {
    thread.replies.sort(byTime);
    const newest = thread.replies.at(-1) ?? thread;
    thread.handled = isAgentComment(newest.message) && hasHandledReaction(root, newest.author.id);
  }
  return [...threads.values()].map(({ thread }) => thread).sort((a, b) => byTime(b, a));
}

/** Whether `userId` left the handled reaction on this comment. */
export function hasHandledReaction(comment: Comment, userId: string): boolean {
  return comment.reactions.some(
    (reaction) => reaction.emoji === AGENT_HANDLED_REACTION && reaction.user.id === userId,
  );
}

export function readCommentReply(comment: Comment): CommentReply {
  return {
    id: comment.id,
    author: { id: comment.user.id, handle: comment.user.handle },
    createdAt: comment.created_at,
    message: comment.message,
  };
}

// The typings say client_meta is never null; replies prove otherwise. A region pin's x/y (or
// node_offset) is its pin corner, which is where the commenter clicked.
function readCommentPin(meta: Comment["client_meta"] | null): CommentPin | null {
  if (!meta) return null;
  if ("node_id" in meta) return { nodeId: meta.node_id, offset: meta.node_offset };
  return { point: { x: meta.x, y: meta.y } };
}

/**
 * When people commented in the thread, root first — what `since` looks at. An agent's own replies are
 * left out, so an agent polling with `since` isn't handed back the thread it just answered.
 */
export function commentTimes(thread: CommentThread): string[] {
  return [thread, ...thread.replies]
    .filter((comment) => !isAgentComment(comment.message))
    .map((comment) => comment.createdAt);
}

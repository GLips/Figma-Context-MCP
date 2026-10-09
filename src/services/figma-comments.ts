/**
 * Figma's flat comment list → threads, and the pin each thread carries.
 *
 * Shared by the REST comments tool and the plugin's comment counts (through the server channel), so the
 * two read Figma's `client_meta` the same way. Pure: no fetching, no geometry.
 */
import type { Comment } from "@figma/rest-api-spec";

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
  const threads = new Map<string, CommentThread>();
  for (const comment of comments) {
    if (comment.parent_id) continue;
    threads.set(comment.id, {
      ...readCommentReply(comment),
      resolvedAt: comment.resolved_at ?? null,
      pin: readCommentPin(comment.client_meta),
      replies: [],
    });
  }
  for (const comment of comments) {
    if (comment.parent_id) threads.get(comment.parent_id)?.replies.push(readCommentReply(comment));
  }
  const byTime = (a: { createdAt: string }, b: { createdAt: string }) =>
    a.createdAt.localeCompare(b.createdAt);
  const ordered = [...threads.values()].sort((a, b) => byTime(b, a));
  for (const thread of ordered) thread.replies.sort(byTime);
  return ordered;
}

function readCommentReply(comment: Comment): CommentReply {
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

/** Every comment in the thread, root first — what `since` and the watermark look at. */
export function commentTimes(thread: CommentThread): string[] {
  return [thread.createdAt, ...thread.replies.map((reply) => reply.createdAt)];
}

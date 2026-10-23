/**
 * One bounded watch for new feedback on a Figma file: comment threads people added or replied to,
 * and nodes whose annotations changed. It returns as soon as either source has something, or empty
 * at the timeout, always with a cursor; an agent that wants to keep listening calls again with it.
 *
 * Bounded because a tool call can't outlive the client's budget (~60s), so "listen" is a long-poll
 * the agent loops on, as Agentation's watch tool is. Nothing is lost between calls: each source's part
 * of the cursor only moves past what was returned, so a source cut short when the other found
 * something is read again from where it was.
 *
 * Comments come over REST, polled (one Tier-2 call per poll; the anchor geometry only when a thread
 * is new). Annotations have no REST surface; they come from the Framelink plugin, through a source
 * the composition supplies, or not at all.
 */
import { setTimeout as delay } from "node:timers/promises";
import type { FigmaService } from "./figma.js";
import {
  commentsWatermark,
  getFigmaComments,
  type LocatedCommentThread,
} from "./get-figma-comments.js";
import type { FigmaFileKey } from "~/utils/figma-url.js";

/** The longest one watch waits, kept under the ~60s a client gives a tool call. */
export const WATCH_TIMEOUT_MAX_SECONDS = 40;

/** How often comments are re-read during a watch. Figma rate-limits the comments endpoint (Tier 2). */
export const COMMENT_POLL_MS = 15_000;

/** The longest one annotation ask is held; the plugin's own cap (ANNOTATION_HOLD_MAX_MS) matches it. */
export const ANNOTATION_HOLD_MS = 10_000;

/** Where a watcher has read up to in one plugin run's annotation log. */
export interface AnnotationWatchCursor {
  epoch: string;
  seq: number;
}

/** One annotation, in flcm's read vocabulary. */
export interface WatchedAnnotation {
  text?: string;
  category?: string;
  properties?: string[];
}

/** A node whose annotations changed, with what they say now. `annotations: []`: all were removed. */
export type AnnotationNodeChange =
  | { id: string; name: string; type: string; path: string; annotations: WatchedAnnotation[] }
  | { id: string; removed: true };

export type AnnotationPoll =
  | {
      kind: "watched";
      cursor: AnnotationWatchCursor;
      changes: AnnotationNodeChange[];
      restarted: boolean;
      overflowed: boolean;
    }
  /** Annotations can't be watched on this file right now; `note` says why and what fixes it. */
  | { kind: "unwatched"; note: string };

/**
 * Changes to annotations in the file `fileKey` after `after` (null: none, only the cursor now), held
 * up to `holdMs` waiting for one.
 */
export interface AnnotationChangeSource {
  poll(
    fileKey: FigmaFileKey,
    after: AnnotationWatchCursor | null,
    holdMs: number,
    signal: AbortSignal,
  ): Promise<AnnotationPoll>;
}

export interface WatchFigmaFeedbackResult {
  /** `feedback`: something new below. `quiet`: the watch timed out with nothing new. */
  status: "feedback" | "quiet";
  comments?: LocatedCommentThread[];
  annotations?: AnnotationNodeChange[];
  /** Pass back as `cursor` to keep watching from here. */
  cursor: string;
  notes?: string[];
}

/** A `cursor` this server didn't mint for this file. The agent's to fix, so it's answered, not thrown. */
export class FeedbackCursorError extends Error {}

/**
 * `comments`: the watermark already seen, or null when the file had no comments; absent until the
 * first read. `annotations`: absent until the plugin was first asked.
 */
interface FeedbackCursor {
  comments?: string | null;
  annotations?: AnnotationWatchCursor;
}

const NO_PLUGIN_SOURCE_NOTE =
  "Annotations aren't watched by this server: only comments are. Annotations reach the local Framelink server through its Figma plugin.";

export async function watchFigmaFeedback(
  figma: FigmaService,
  fileKey: FigmaFileKey,
  {
    cursor,
    timeoutMs,
    annotations,
    signal,
    commentPollMs = COMMENT_POLL_MS,
  }: {
    cursor?: string;
    timeoutMs: number;
    annotations: AnnotationChangeSource | null;
    signal: AbortSignal;
    commentPollMs?: number;
  },
): Promise<WatchFigmaFeedbackResult> {
  const state = decodeFeedbackCursor(cursor, fileKey);
  const deadline = Date.now() + timeoutMs;
  const found: Pick<WatchFigmaFeedbackResult, "comments" | "annotations"> = {};
  const notes: string[] = [];
  // Aborted when either source finds something (the other stops where it is), or by the caller.
  const stop = new AbortController();
  const abandon = () => stop.abort(signal.reason);
  signal.addEventListener("abort", abandon, { once: true });
  const scoped = figma.withSignal(stop.signal);

  async function watchComments(): Promise<boolean> {
    for (;;) {
      if (state.comments === undefined) {
        // The first read only marks what already exists: a watch reports what's new from here on.
        state.comments = commentsWatermark((await scoped.getComments(fileKey)).comments) ?? null;
      } else {
        // `since` is inclusive (the newest thread repeats); one millisecond past the watermark makes
        // it exclusive, which Figma's millisecond timestamps make exact.
        const since =
          state.comments === null
            ? undefined
            : new Date(Date.parse(state.comments) + 1).toISOString();
        const result = await getFigmaComments(scoped, fileKey, {
          include: "full",
          status: "all",
          since,
        });
        state.comments = result.watermark ?? state.comments;
        if (result.total) {
          found.comments = result.threads;
          return true;
        }
      }
      const wait = Math.min(commentPollMs, deadline - Date.now());
      if (wait <= 0) return false;
      await delay(wait, undefined, { signal: stop.signal });
    }
  }

  async function watchAnnotations(): Promise<boolean> {
    if (!annotations) {
      notes.push(NO_PLUGIN_SOURCE_NOTE);
      return false;
    }
    for (;;) {
      const after = state.annotations ?? null;
      const hold = after === null ? 0 : Math.min(ANNOTATION_HOLD_MS, deadline - Date.now());
      if (after !== null && hold <= 0) return false;
      const poll = await annotations.poll(fileKey, after, hold, stop.signal);
      if (poll.kind === "unwatched") {
        notes.push(poll.note);
        return false;
      }
      state.annotations = poll.cursor;
      if (poll.restarted)
        notes.push(
          "The Figma plugin was closed or reloaded since your last watch, so annotation changes made in between aren't reported.",
        );
      if (poll.overflowed)
        notes.push(
          "More annotations changed than the plugin keeps track of, so some changes were dropped. Re-read with flcm.find({ hasAnnotations: true }).",
        );
      if (poll.changes.length) {
        found.annotations = poll.changes;
        return true;
      }
    }
  }

  let failure: { error: unknown } | null = null;
  const settle = (run: () => Promise<boolean>) =>
    run().then(
      (foundSome) => {
        if (foundSome) stop.abort();
      },
      (error: unknown) => {
        // A source stopped by the other's find, or by the caller, isn't a failure of its own.
        if (!stop.signal.aborted) failure ??= { error };
        stop.abort();
      },
    );
  try {
    await Promise.all([settle(watchComments), settle(watchAnnotations)]);
  } finally {
    signal.removeEventListener("abort", abandon);
  }
  if (signal.aborted) throw signal.reason;
  if (failure) throw (failure as { error: unknown }).error;

  const result: WatchFigmaFeedbackResult = {
    status: found.comments || found.annotations ? "feedback" : "quiet",
    ...found,
    cursor: encodeFeedbackCursor(fileKey, state),
  };
  if (notes.length) result.notes = [...new Set(notes)];
  return result;
}

// Opaque to the agent: base64url JSON, bound to the file it was minted for.
function encodeFeedbackCursor(fileKey: FigmaFileKey, state: FeedbackCursor): string {
  return Buffer.from(
    JSON.stringify({ f: fileKey, c: state.comments, a: state.annotations }),
  ).toString("base64url");
}

function decodeFeedbackCursor(cursor: string | undefined, fileKey: FigmaFileKey): FeedbackCursor {
  if (cursor === undefined) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new FeedbackCursorError("cursor isn't one this tool returned");
  }
  if (typeof raw !== "object" || raw === null)
    throw new FeedbackCursorError("cursor isn't one this tool returned");
  const { f, c, a } = raw as Record<string, unknown>;
  if (f !== fileKey) throw new FeedbackCursorError("cursor was returned for a different file");
  const comments =
    c === undefined || c === null || (typeof c === "string" && !Number.isNaN(Date.parse(c)))
      ? c
      : false;
  const annotationsCursor = a === undefined ? undefined : readAnnotationCursor(a);
  if (comments === false || annotationsCursor === null)
    throw new FeedbackCursorError("cursor isn't one this tool returned");
  return { comments, annotations: annotationsCursor };
}

function readAnnotationCursor(value: unknown): AnnotationWatchCursor | null {
  if (typeof value !== "object" || value === null) return null;
  const { epoch, seq } = value as Record<string, unknown>;
  return typeof epoch === "string" &&
    typeof seq === "number" &&
    Number.isSafeInteger(seq) &&
    seq >= 0
    ? { epoch, seq }
    : null;
}

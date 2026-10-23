/**
 * Listening for new feedback on a Figma file: comment threads people added or replied to, and nodes
 * whose annotations changed. One listener (listenForFeedback) serves two ways to consume it: a
 * bounded watch, which returns at the first feedback or the timeout, for a tool call that can't
 * outlive the client's budget (~60s); and a follow, which listens until stopped.
 *
 * Every answer carries a cursor holding each source's position, and a source's position only moves
 * past what it has handed over, so nothing is lost between watches: a source stopped mid-read reads
 * again from where it was.
 *
 * Comments come over REST, polled (one Tier-2 call per poll; the anchor geometry only when a thread
 * is new). Annotations have no REST surface; they come from the Framelink plugin, through a source
 * the composition supplies, or not at all.
 */
import { setTimeout as delay } from "node:timers/promises";
import type { FigmaService } from "./figma.js";
import {
  commentsMark,
  shapeFigmaComments,
  type LocatedCommentThread,
} from "./get-figma-comments.js";
import type { FigmaFileKey } from "~/utils/figma-url.js";

/** The longest one watch waits, kept under the ~60s a client gives a tool call. */
export const WATCH_TIMEOUT_MAX_SECONDS = 40;

/** How often comments are read. Figma rate-limits the comments endpoint (Tier 2). */
export const COMMENT_POLL_MS = 15_000;

/**
 * How often the plugin is read without being told its log moved: how soon a closed plugin, a revoked
 * grant, or a plugin that has just become available is noticed. Local, so cheap.
 */
export const ANNOTATION_REREAD_MS = 15_000;

/** How long a source waits after a failed read before trying again (rate limits, a network drop). */
export const FEEDBACK_RETRY_MS = 60_000;

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

/** The annotation log of the plugin open in a file. */
export interface AnnotationChangeSource {
  /** The changes after `after` (null: none, only the cursor now), at once. */
  read(
    fileKey: FigmaFileKey,
    after: AnnotationWatchCursor | null,
    signal: AbortSignal,
  ): Promise<AnnotationPoll>;
  /**
   * Resolves once the plugin says its log moved past `after`: a hint to read, never proof, so it
   * may resolve early or not at all.
   */
  moved(fileKey: FigmaFileKey, after: AnnotationWatchCursor, signal: AbortSignal): Promise<void>;
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
 * The newest comment seen with every comment created at exactly its time (null: the file had none),
 * and when comments were last read.
 */
interface CommentsPosition {
  mark: { time: string; seen: string[] } | null;
  readAt: number;
}

/** Each source's position, absent until it was first read; a watch reports only what's past it. */
interface FeedbackPositions {
  comments?: CommentsPosition;
  annotations?: AnnotationWatchCursor;
}

type FeedbackFigma = FigmaService | { none: true; noCommentsNote: string };

/** What a listener hears. `annotationsUnwatched` comes when that changes; `note: null`, watched again. */
type FeedbackEvent =
  | { kind: "started" }
  | { kind: "comments"; threads: LocatedCommentThread[] }
  | { kind: "annotations"; changes: AnnotationNodeChange[]; notes: string[] }
  | { kind: "annotationsUnwatched"; note: string | null }
  | { kind: "failed"; error: unknown };

const NO_PLUGIN_SOURCE_NOTE =
  "Annotations aren't watched by this server: only comments are. Annotations reach the local Framelink server through its Figma plugin.";

/**
 * `figma` as `{ none }` watches annotations only, for the `watch` command run from a shell with no
 * Figma token; its `noCommentsNote` says why comments aren't watched and how to fix it.
 */
export async function watchFigmaFeedback(
  figma: FeedbackFigma,
  fileKey: FigmaFileKey,
  {
    cursor,
    timeoutMs,
    annotations,
    signal,
    commentPollMs,
  }: {
    cursor?: string;
    timeoutMs: number;
    annotations: AnnotationChangeSource | null;
    signal: AbortSignal;
    commentPollMs?: number;
  },
): Promise<WatchFigmaFeedbackResult> {
  const at = decodeFeedbackCursor(cursor, fileKey);
  const found: Pick<WatchFigmaFeedbackResult, "comments" | "annotations"> = {};
  const notes = new Set(sourceNotes(figma, annotations));
  let unwatched: string | null = null;
  let failure: { error: unknown } | null = null;
  const done = new AbortController();
  await listenForFeedback(figma, fileKey, at, annotations, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs), done.signal]),
    commentPollMs,
    hear: (event) => {
      if (event.kind === "comments") found.comments = event.threads;
      else if (event.kind === "annotations") {
        event.notes.forEach((note) => notes.add(note));
        if (event.changes.length) found.annotations = event.changes;
      } else if (event.kind === "annotationsUnwatched") unwatched = event.note;
      else if (event.kind === "failed") failure ??= { error: event.error };
      if (found.comments || found.annotations || failure) done.abort();
    },
  });
  if (signal.aborted) throw signal.reason;
  if (failure) throw (failure as { error: unknown }).error;

  if (unwatched) notes.add(unwatched);
  const result: WatchFigmaFeedbackResult = {
    status: found.comments || found.annotations ? "feedback" : "quiet",
    ...found,
    cursor: encodeFeedbackCursor(fileKey, at),
  };
  if (notes.size) result.notes = [...notes];
  return result;
}

/** One line of a follow: feedback, `watching` (started, or its notes changed), or `error` (it retries). */
export type FollowedFeedback =
  | (WatchFigmaFeedbackResult & { status: "feedback" })
  | { status: "watching"; cursor: string; notes?: string[] }
  | { status: "error"; message: string; cursor: string | null; retryInSeconds: number };

/**
 * Watch without end, for a caller that hears each emitted value as it happens (the `watch --follow`
 * command, whose lines Claude Code's Monitor turns into notifications). Emits `watching` once the
 * starting point is fixed, then only feedback, changed notes and errors, each carrying the cursor to
 * restart from. Ends only when `signal` aborts.
 */
export async function followFigmaFeedback(
  figma: FeedbackFigma,
  fileKey: FigmaFileKey,
  {
    cursor,
    annotations,
    signal,
    emit,
    commentPollMs,
    retryMs = FEEDBACK_RETRY_MS,
  }: {
    cursor?: string;
    annotations: AnnotationChangeSource | null;
    signal: AbortSignal;
    emit: (line: FollowedFeedback) => void;
    commentPollMs?: number;
    retryMs?: number;
  },
): Promise<void> {
  const at = decodeFeedbackCursor(cursor, fileKey);
  const fixedNotes = sourceNotes(figma, annotations);
  let unwatched: string | null = null;
  let started = false;
  const notesNow = (passing: string[] = []) => {
    const notes = [...fixedNotes, ...(unwatched ? [unwatched] : []), ...passing];
    return notes.length ? { notes } : {};
  };
  const cursorNow = () => encodeFeedbackCursor(fileKey, at);
  await listenForFeedback(figma, fileKey, at, annotations, {
    signal,
    commentPollMs,
    retryMs,
    hear: (event) => {
      if (event.kind === "started") {
        started = true;
        emit({ status: "watching", cursor: cursorNow(), ...notesNow() });
      } else if (event.kind === "comments")
        emit({ status: "feedback", comments: event.threads, cursor: cursorNow(), ...notesNow() });
      else if (event.kind === "annotations")
        emit(
          event.changes.length
            ? {
                status: "feedback",
                annotations: event.changes,
                cursor: cursorNow(),
                ...notesNow(event.notes),
              }
            : { status: "watching", cursor: cursorNow(), ...notesNow(event.notes) },
        );
      else if (event.kind === "annotationsUnwatched") {
        unwatched = event.note;
        if (started) emit({ status: "watching", cursor: cursorNow(), ...notesNow() });
      } else
        emit({
          status: "error",
          message: event.error instanceof Error ? event.error.message : String(event.error),
          cursor: at.comments || at.annotations ? cursorNow() : null,
          retryInSeconds: Math.round(retryMs / 1000),
        });
    },
  });
}

/** Why a source isn't watched at all, from how the watch was composed. */
function sourceNotes(figma: FeedbackFigma, annotations: AnnotationChangeSource | null): string[] {
  return [
    ...("none" in figma ? [figma.noCommentsNote] : []),
    ...(annotations ? [] : [NO_PLUGIN_SOURCE_NOTE]),
  ];
}

/**
 * Listens to every available source until `signal` aborts, advancing `at` past what each hands to
 * `hear`. Each source first fixes its starting position, and none listens until all have tried (then
 * `started`), so a find can't cut another source's start short. A failed read is heard, then retried
 * after `retryMs`; each source keeps its own pace, which nothing the other finds hastens.
 */
async function listenForFeedback(
  figma: FeedbackFigma,
  fileKey: FigmaFileKey,
  at: FeedbackPositions,
  annotations: AnnotationChangeSource | null,
  {
    signal,
    hear,
    commentPollMs = COMMENT_POLL_MS,
    retryMs = FEEDBACK_RETRY_MS,
  }: {
    signal: AbortSignal;
    hear: (event: FeedbackEvent) => void;
    commentPollMs?: number;
    retryMs?: number;
  },
): Promise<void> {
  const steps: (() => Promise<void>)[] = [];
  if (!("none" in figma)) steps.push(commentsStep(figma.withSignal(signal)));
  if (annotations) steps.push(annotationsStep(annotations));

  // Each step reads its source once, first waiting out the source's pace when it has a position.
  function commentsStep(figma: FigmaService) {
    return async () => {
      const from = at.comments;
      if (from)
        await delay(Math.max(0, from.readAt + commentPollMs - Date.now()), null, { signal });
      const readAt = Date.now();
      const { comments } = await figma.getComments(fileKey);
      // The first read only marks what already exists: a watch reports what's new from here on.
      const fresh =
        from &&
        (await shapeFigmaComments(figma, fileKey, comments, {
          include: "full",
          status: "all",
          since: from.mark?.time,
          seenAtSince: from.mark?.seen,
        }));
      at.comments = { mark: commentsMark(comments) ?? from?.mark ?? null, readAt };
      if (fresh && fresh.threads?.length) hear({ kind: "comments", threads: fresh.threads });
    };
  }

  function annotationsStep(source: AnnotationChangeSource) {
    let unwatched: string | null = null;
    let tried = false;
    return async () => {
      if (tried) await annotationsDue(source, fileKey, at.annotations, signal);
      tried = true;
      const poll = await source.read(fileKey, at.annotations ?? null, signal);
      const note = poll.kind === "unwatched" ? poll.note : null;
      if (note !== unwatched) hear({ kind: "annotationsUnwatched", note: (unwatched = note) });
      if (poll.kind === "unwatched") return;
      at.annotations = poll.cursor;
      const notes: string[] = [];
      if (poll.restarted)
        notes.push(
          "The Figma plugin was closed or reloaded since your last watch, so annotation changes made in between aren't reported.",
        );
      if (poll.overflowed)
        notes.push(
          "More annotations changed than the plugin keeps track of, so some changes were dropped. Re-read with flcm.find({ hasAnnotations: true }).",
        );
      if (poll.changes.length || notes.length)
        hear({ kind: "annotations", changes: poll.changes, notes });
    };
  }

  const aborted = new Promise<void>((resolve) =>
    signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true }),
  );
  let unstarted = steps.length;
  let start!: () => void;
  const allStarted = new Promise<void>((resolve) => (start = resolve));
  const arrive = () => {
    if (--unstarted > 0) return;
    hear({ kind: "started" });
    start();
  };
  if (!steps.length) arrive();
  await Promise.all([
    ...steps.map(async (step) => {
      for (let first = true; !signal.aborted; ) {
        try {
          await step();
        } catch (error) {
          if (signal.aborted) return;
          hear({ kind: "failed", error });
          await delay(retryMs, null, { signal }).catch(() => {});
        }
        if (first) {
          first = false;
          arrive();
          // A source whose start was cut short never arrives; the abort ends the wait instead.
          await Promise.race([allStarted, aborted]);
        }
      }
    }),
    aborted,
  ]);
}

/** Waits until the plugin says its log moved past `after`, or the periodic re-read is due. */
async function annotationsDue(
  source: AnnotationChangeSource,
  fileKey: FigmaFileKey,
  after: AnnotationWatchCursor | undefined,
  signal: AbortSignal,
): Promise<void> {
  const settled = new AbortController();
  const either = AbortSignal.any([signal, settled.signal]);
  try {
    await Promise.race([
      delay(ANNOTATION_REREAD_MS, null, { signal: either }),
      ...(after ? [source.moved(fileKey, after, either)] : []),
    ]);
  } finally {
    settled.abort();
  }
}

// Opaque to the agent: base64url JSON, bound to the file it was minted for.
function encodeFeedbackCursor(fileKey: FigmaFileKey, at: FeedbackPositions): string {
  return Buffer.from(JSON.stringify({ f: fileKey, c: at.comments, a: at.annotations })).toString(
    "base64url",
  );
}

function decodeFeedbackCursor(
  cursor: string | undefined,
  fileKey: FigmaFileKey,
): FeedbackPositions {
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
  const comments = c === undefined ? undefined : readCommentsPosition(c);
  const annotations = a === undefined ? undefined : readAnnotationCursor(a);
  if (comments === null || annotations === null)
    throw new FeedbackCursorError("cursor isn't one this tool returned");
  return { comments, annotations };
}

function readCommentsPosition(value: unknown): CommentsPosition | null {
  if (typeof value !== "object" || value === null) return null;
  const { mark, readAt } = value as Record<string, unknown>;
  if (typeof readAt !== "number" || !Number.isFinite(readAt)) return null;
  if (mark === null) return { mark, readAt };
  if (typeof mark !== "object" || mark === undefined) return null;
  const { time, seen } = mark as Record<string, unknown>;
  return typeof time === "string" &&
    !Number.isNaN(Date.parse(time)) &&
    Array.isArray(seen) &&
    seen.every((id) => typeof id === "string")
    ? { mark: { time, seen }, readAt }
    : null;
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

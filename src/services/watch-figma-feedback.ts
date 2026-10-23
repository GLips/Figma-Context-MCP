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

/** The newest comment seen (null: the file had none), and when comments were last read. */
interface CommentsPosition {
  watermark: string | null;
  readAt: number;
}

/** Each source's position, absent until it was first read; a watch reports only what's past it. */
interface FeedbackPositions {
  comments?: CommentsPosition;
  annotations?: AnnotationWatchCursor;
}

type FeedbackFigma = FigmaService | { none: true; noCommentsNote: string };

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
    commentPollMs = COMMENT_POLL_MS,
  }: {
    cursor?: string;
    timeoutMs: number;
    annotations: AnnotationChangeSource | null;
    signal: AbortSignal;
    commentPollMs?: number;
  },
): Promise<WatchFigmaFeedbackResult> {
  const at = decodeFeedbackCursor(cursor, fileKey);
  const notes = new Set(sourceNotes(figma, annotations));
  const untilDeadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  const unwatched = await fixFeedbackPositions(
    figma,
    fileKey,
    at,
    annotations,
    untilDeadline,
  ).catch((error: unknown) => {
    if (signal.aborted || !untilDeadline.aborted) throw error;
    return null;
  });
  if (unwatched) notes.add(unwatched);

  const found: Pick<WatchFigmaFeedbackResult, "comments" | "annotations"> = {};
  const done = new AbortController();
  const listening = AbortSignal.any([untilDeadline, done.signal]);
  let failure: { error: unknown } | null = null;
  // Every source has a position by now, so stopping one mid-read loses nothing: it reads again
  // from there next watch.
  const listen = (run: Promise<void>) =>
    run.catch((error: unknown) => {
      if (listening.aborted) return;
      failure ??= { error };
      done.abort();
    });
  await Promise.all([
    !("none" in figma) &&
      at.comments &&
      listen(
        listenForComments(figma, fileKey, at, commentPollMs, listening, (threads) => {
          found.comments = threads;
          done.abort();
        }),
      ),
    annotations &&
      at.annotations &&
      listen(
        listenForAnnotations(annotations, fileKey, at, null, listening, (heard) => {
          if ("note" in heard) {
            notes.add(heard.note);
            return;
          }
          heard.notes.forEach((note) => notes.add(note));
          if (!heard.changes.length) return;
          found.annotations = heard.changes;
          done.abort();
        }),
      ),
  ]);
  if (signal.aborted) throw signal.reason;
  if (failure) throw (failure as { error: unknown }).error;

  const result: WatchFigmaFeedbackResult = {
    status: found.comments || found.annotations ? "feedback" : "quiet",
    ...found,
    cursor: encodeFeedbackCursor(fileKey, at),
  };
  if (notes.size) result.notes = [...notes];
  return result;
}

/** One line of a follow: what a watch found, or `watching` (started, or its notes changed), or `error` (it retries). */
export type FollowedFeedback =
  | (WatchFigmaFeedbackResult & { status: "feedback" })
  | { status: "watching"; cursor: string; notes?: string[] }
  | { status: "error"; message: string; cursor: string | null; retryInSeconds: number };

/** How long a follow waits after a failed read before trying again (rate limits, a network drop). */
export const FOLLOW_RETRY_MS = 60_000;

/** How often a follow asks again after the plugin couldn't watch annotations. Local, so cheap. */
const UNWATCHED_RETRY_MS = 15_000;

/**
 * Watch without end, for a caller that hears each emitted value as it happens (the `watch --follow`
 * command, whose lines Claude Code's Monitor turns into notifications). Emits `watching` once the
 * starting point is fixed, then only feedback, changed notes and errors, each carrying the cursor to
 * restart from. Each source keeps its own pace, so a quiet hour costs one comment read per poll and
 * nothing else. Ends only when `signal` aborts.
 */
export async function followFigmaFeedback(
  figma: FeedbackFigma,
  fileKey: FigmaFileKey,
  {
    cursor,
    annotations,
    signal,
    emit,
    retryMs = FOLLOW_RETRY_MS,
    unwatchedRetryMs = UNWATCHED_RETRY_MS,
    commentPollMs = COMMENT_POLL_MS,
  }: {
    cursor?: string;
    annotations: AnnotationChangeSource | null;
    signal: AbortSignal;
    emit: (line: FollowedFeedback) => void;
    retryMs?: number;
    unwatchedRetryMs?: number;
    commentPollMs?: number;
  },
): Promise<void> {
  const at = decodeFeedbackCursor(cursor, fileKey);
  const fixedNotes = sourceNotes(figma, annotations);
  let unwatchedNote: string | null = null;
  const notesNow = (extra: string[] = []) => {
    const notes = [...fixedNotes, ...(unwatchedNote ? [unwatchedNote] : []), ...extra];
    return notes.length ? { notes } : {};
  };
  const cursorNow = () => encodeFeedbackCursor(fileKey, at);
  const retrying = async (listen: () => Promise<void>) => {
    for (;;) {
      try {
        return await listen();
      } catch (error) {
        if (signal.aborted) return;
        emit({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
          cursor: at.comments || at.annotations ? cursorNow() : null,
          retryInSeconds: Math.round(retryMs / 1000),
        });
        await delay(retryMs, undefined, { signal }).catch(() => {});
      }
    }
  };

  await retrying(async () => {
    unwatchedNote = await fixFeedbackPositions(figma, fileKey, at, annotations, signal);
  });
  if (signal.aborted) return;
  emit({ status: "watching", cursor: cursorNow(), ...notesNow() });

  await Promise.all([
    !("none" in figma) &&
      retrying(() =>
        listenForComments(figma, fileKey, at, commentPollMs, signal, (comments) =>
          emit({ status: "feedback", comments, cursor: cursorNow(), ...notesNow() }),
        ),
      ),
    annotations &&
      retrying(() =>
        listenForAnnotations(annotations, fileKey, at, unwatchedRetryMs, signal, (heard) => {
          const note = "note" in heard ? heard.note : null;
          const noteChanged = note !== unwatchedNote;
          unwatchedNote = note;
          if ("changes" in heard && heard.changes.length)
            emit({
              status: "feedback",
              annotations: heard.changes,
              cursor: cursorNow(),
              ...notesNow(heard.notes),
            });
          else if (noteChanged || ("notes" in heard && heard.notes.length))
            emit({
              status: "watching",
              cursor: cursorNow(),
              ...notesNow("notes" in heard ? heard.notes : []),
            });
        }),
      ),
  ]);
}

/** Why a source isn't watched at all, from how the watch was composed. */
function sourceNotes(figma: FeedbackFigma, annotations: AnnotationChangeSource | null): string[] {
  return [
    ...("none" in figma ? [figma.noCommentsNote] : []),
    ...(annotations ? [] : [NO_PLUGIN_SOURCE_NOTE]),
  ];
}

/**
 * Reads each available source's starting position where `at` has none, all before any watching
 * starts, so no source's find can cut another's start short. Returns why the plugin can't watch
 * annotations right now, if it can't.
 */
async function fixFeedbackPositions(
  figma: FeedbackFigma,
  fileKey: FigmaFileKey,
  at: FeedbackPositions,
  annotations: AnnotationChangeSource | null,
  signal: AbortSignal,
): Promise<string | null> {
  let unwatched: string | null = null;
  await Promise.all([
    !("none" in figma) &&
      !at.comments &&
      (async () => {
        const readAt = Date.now();
        const { comments } = await figma.withSignal(signal).getComments(fileKey);
        at.comments = { watermark: commentsWatermark(comments) ?? null, readAt };
      })(),
    annotations &&
      !at.annotations &&
      (async () => {
        const poll = await annotations.poll(fileKey, null, 0, signal);
        if (poll.kind === "unwatched") unwatched = poll.note;
        else at.annotations = poll.cursor;
      })(),
  ]);
  return unwatched;
}

/**
 * Reads comments every `pollMs`, advancing `at.comments` past each read, and hands `hear` every batch
 * of new threads, until `signal` aborts. The pace is kept from `readAt`, across watches, so feedback
 * from the plugin never hastens a read (Figma rate-limits this endpoint, Tier 2).
 */
async function listenForComments(
  figma: FigmaService,
  fileKey: FigmaFileKey,
  at: FeedbackPositions,
  pollMs: number,
  signal: AbortSignal,
  hear: (threads: LocatedCommentThread[]) => void,
): Promise<void> {
  const scoped = figma.withSignal(signal);
  for (;;) {
    const from = at.comments!;
    await delay(Math.max(0, from.readAt + pollMs - Date.now()), undefined, { signal });
    const readAt = Date.now();
    // `since` is inclusive (the newest thread repeats); one millisecond past the watermark makes it
    // exclusive, which Figma's millisecond timestamps make exact.
    const since =
      from.watermark === null ? undefined : new Date(Date.parse(from.watermark) + 1).toISOString();
    const result = await getFigmaComments(scoped, fileKey, {
      include: "full",
      status: "all",
      since,
    });
    at.comments = { watermark: result.watermark ?? from.watermark, readAt };
    if (result.threads?.length) hear(result.threads);
  }
}

type HeardAnnotations = { changes: AnnotationNodeChange[]; notes: string[] } | { note: string };

/**
 * Asks the plugin for annotation changes in held turns, advancing `at.annotations`, until `signal`
 * aborts. When it can't watch, `hear` gets the note, then the ask is repeated after `unwatchedRetryMs`,
 * or never (null), ending the listen.
 */
async function listenForAnnotations(
  source: AnnotationChangeSource,
  fileKey: FigmaFileKey,
  at: FeedbackPositions,
  unwatchedRetryMs: number | null,
  signal: AbortSignal,
  hear: (heard: HeardAnnotations) => void,
): Promise<void> {
  for (;;) {
    signal.throwIfAborted();
    const after = at.annotations ?? null;
    const poll = await source.poll(fileKey, after, after ? ANNOTATION_HOLD_MS : 0, signal);
    if (poll.kind === "unwatched") {
      hear({ note: poll.note });
      if (unwatchedRetryMs === null) return;
      await delay(unwatchedRetryMs, undefined, { signal });
      continue;
    }
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
    hear({ changes: poll.changes, notes });
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
  const { watermark, readAt } = value as Record<string, unknown>;
  return (watermark === null ||
    (typeof watermark === "string" && !Number.isNaN(Date.parse(watermark)))) &&
    typeof readAt === "number" &&
    Number.isFinite(readAt)
    ? { watermark, readAt }
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

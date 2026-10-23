import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import type { Comment, GetFileResponse, User } from "@figma/rest-api-spec";
import type { FigmaService } from "~/services/figma.js";
import {
  FeedbackCursorError,
  followFigmaFeedback,
  watchFigmaFeedback,
  type FollowedFeedback,
  type AnnotationChangeSource,
  type AnnotationPoll,
  type AnnotationWatchCursor,
} from "~/services/watch-figma-feedback.js";
import { figmaFileKey } from "~/utils/figma-url.js";

const designer: User = { id: "u-designer", handle: "Ana", img_url: "" };
const tokenUser: User = { id: "u-token", handle: "Graham", img_url: "" };
const fileKey = figmaFileKey("abc");

// An in-memory Figma comments API at the network boundary, stamping comments with the real clock as
// Figma does, in milliseconds.
function fakeFigma({ readMs = 0 } = {}) {
  const comments: Comment[] = [];
  let reads = 0;
  const add = (user: User, message: string, parent_id = ""): Comment => {
    const comment = {
      id: String(1000 + comments.length),
      parent_id,
      file_key: "abc",
      user,
      created_at: new Date().toISOString(),
      resolved_at: null,
      message,
      order_id: null,
      reactions: [],
      client_meta: parent_id ? null : { node_id: "1:1", node_offset: { x: 0, y: 0 } },
    } as unknown as Comment;
    comments.push(comment);
    return comment;
  };
  const scoped = (signal?: AbortSignal): FigmaService =>
    ({
      withSignal: scoped,
      getComments: async () => {
        reads++;
        const snapshot = structuredClone(comments);
        await delay(readMs, undefined, { signal });
        return { comments: snapshot };
      },
      getFileSlice: async () =>
        ({
          document: { children: [{ id: "1:1", name: "Home", type: "CANVAS", children: [] }] },
        }) as unknown as GetFileResponse,
    }) as unknown as FigmaService;
  const figma = scoped();
  return { figma, add, reads: () => reads };
}

const watch = (
  figma: FigmaService,
  options: { cursor?: string; timeoutMs?: number; annotations?: AnnotationChangeSource | null },
) =>
  watchFigmaFeedback(figma, fileKey, {
    timeoutMs: 300,
    annotations: null,
    signal: new AbortController().signal,
    commentPollMs: 20,
    ...options,
  });

const later = (ms: number, run: () => void) => setTimeout(run, ms);

// The plugin's annotation log at the bridge boundary: holds an ask until a change or the hold ends,
// and drops it when the server aborts the request.
function fakePlugin() {
  const asked: (AnnotationWatchCursor | null)[] = [];
  const position = { epoch: "run-1", seq: 0 };
  let pending = false;
  const source: AnnotationChangeSource = {
    poll: async (_key, after, holdMs, signal) => {
      asked.push(after);
      for (const until = Date.now() + holdMs; after !== null && !pending && Date.now() < until; ) {
        signal.throwIfAborted();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const changes =
        pending && after !== null
          ? [
              {
                id: "2:3",
                name: "CTA",
                type: "FRAME",
                path: "Home › Hero",
                annotations: [{ text: "Use the brand blue" }],
              },
            ]
          : [];
      if (changes.length) {
        position.seq++;
        pending = false;
      }
      return {
        kind: "watched",
        cursor: { ...position },
        changes,
        restarted: false,
        overflowed: false,
      } satisfies AnnotationPoll;
    },
  };
  return { source, asked, change: () => (pending = true) };
}

it("reports only what arrives after the watch starts, once, and never the agent's own reply", async () => {
  const { figma, add } = fakeFigma();
  const old = add(designer, "Old feedback, already known");

  later(50, () => add(designer, "Make the button bigger"));
  const first = await watch(figma, {});
  expect(first.status).toBe("feedback");
  expect(first.comments?.map((thread) => thread.message)).toEqual(["Make the button bigger"]);
  expect(first.notes?.[0]).toMatch(/only comments/);

  add(tokenUser, "[AGENT] Done, it's 48px now", first.comments![0].id);
  const quiet = await watch(figma, { cursor: first.cursor });
  expect(quiet.status).toBe("quiet");
  expect(quiet.comments).toBeUndefined();

  later(30, () => add(designer, "Still too small", old.id));
  const reply = await watch(figma, { cursor: quiet.cursor });
  expect(reply.comments?.map((thread) => thread.id)).toEqual([old.id]);
});

it("returns an annotation change at once, and resumes the plugin's log from the cursor it returned", async () => {
  const { figma } = fakeFigma();
  const plugin = fakePlugin();
  const annotations = plugin.source;
  const asked = plugin.asked;

  later(40, () => plugin.change());
  const startedAt = Date.now();
  const found = await watch(figma, { annotations, timeoutMs: 5_000 });
  expect(Date.now() - startedAt).toBeLessThan(2_000);
  expect(found.status).toBe("feedback");
  expect(found.annotations).toEqual([
    {
      id: "2:3",
      name: "CTA",
      type: "FRAME",
      path: "Home › Hero",
      annotations: [{ text: "Use the brand blue" }],
    },
  ]);

  asked.length = 0;
  await watch(figma, { annotations, cursor: found.cursor, timeoutMs: 50 });
  expect(asked[0]).toEqual({ epoch: "run-1", seq: 1 });
});

it("an annotation change found during the first comment read doesn't swallow comments posted meanwhile", async () => {
  const { figma, add } = fakeFigma({ readMs: 60 });
  const plugin = fakePlugin();
  plugin.change();
  const first = await watch(figma, { annotations: plugin.source, timeoutMs: 2_000 });
  expect(first.annotations?.map((change) => change.id)).toEqual(["2:3"]);

  add(designer, "Posted while the agent handled the annotation");
  const next = await watch(figma, { annotations: plugin.source, cursor: first.cursor });
  expect(next.comments?.map((thread) => thread.message)).toEqual([
    "Posted while the agent handled the annotation",
  ]);
});

it("refuses a cursor minted for another file", async () => {
  const { figma } = fakeFigma();
  const { cursor } = await watch(figma, { timeoutMs: 10 });
  await expect(
    watchFigmaFeedback(figma, figmaFileKey("other"), {
      cursor,
      timeoutMs: 10,
      annotations: null,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow(FeedbackCursorError);
});

it("a follow says once that it's watching, then emits only feedback, until stopped", async () => {
  const { figma, add, reads } = fakeFigma();
  const plugin = fakePlugin();
  const lines: FollowedFeedback[] = [];
  const stop = new AbortController();
  const following = followFigmaFeedback(figma, fileKey, {
    annotations: plugin.source,
    signal: stop.signal,
    emit: (line) => lines.push(line),
    commentPollMs: 200,
  });

  // A burst of annotation edits mustn't hasten comment reads, which Figma rate-limits.
  for (let i = 0; i < 5; i++) later(20 + i * 30, () => plugin.change());
  later(250, () => add(designer, "Swap the hero image"));
  await new Promise((resolve) => setTimeout(resolve, 500));
  stop.abort();
  await following;

  const comments = lines.filter((line) => line.status === "feedback" && line.comments);
  expect(lines[0].status).toBe("watching");
  expect(lines.slice(1).every((line) => line.status === "feedback")).toBe(true);
  expect(lines.filter((line) => line.status === "feedback" && line.annotations).length).toBe(5);
  expect(comments.map((line) => line.status === "feedback" && line.comments?.[0].message)).toEqual([
    "Swap the hero image",
  ]);
  expect(reads()).toBeLessThanOrEqual(4);
});

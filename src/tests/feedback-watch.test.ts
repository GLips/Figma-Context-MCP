import { expect, it } from "vitest";
import type { Comment, GetFileResponse, User } from "@figma/rest-api-spec";
import type { FigmaService } from "~/services/figma.js";
import {
  FeedbackCursorError,
  watchFigmaFeedback,
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
function fakeFigma() {
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
  const figma = {
    withSignal: () => figma,
    getComments: async () => {
      reads++;
      return { comments: structuredClone(comments) };
    },
    getFileSlice: async () =>
      ({
        document: { children: [{ id: "1:1", name: "Home", type: "CANVAS", children: [] }] },
      }) as unknown as GetFileResponse,
  } as unknown as FigmaService;
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
  const asked: (AnnotationWatchCursor | null)[] = [];
  const position = { epoch: "run-1", seq: 0 };
  let pending = false;
  const annotations: AnnotationChangeSource = {
    poll: async (_key, after, holdMs) => {
      asked.push(after);
      // Held like the plugin holds: until a change, or the hold ends.
      for (const until = Date.now() + holdMs; after !== null && !pending && Date.now() < until; )
        await new Promise((resolve) => setTimeout(resolve, 10));
      const changes = pending
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
      if (pending) position.seq++;
      pending = false;
      return {
        kind: "watched",
        cursor: { ...position },
        changes,
        restarted: false,
        overflowed: false,
      } satisfies AnnotationPoll;
    },
  };

  later(40, () => (pending = true));
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

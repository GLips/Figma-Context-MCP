import { expect, it } from "vitest";
import type { Comment, GetFileResponse, User } from "@figma/rest-api-spec";
import type { FigmaService } from "~/services/figma.js";
import { getFigmaComments } from "~/services/get-figma-comments.js";
import { replyToFigmaComment } from "~/services/reply-to-figma-comment.js";
import { figmaFileKey } from "~/utils/figma-url.js";

const designer: User = { id: "u-designer", handle: "Ana", img_url: "" };
// The token's own user: an agent's writes post as this account.
const tokenUser: User = { id: "u-token", handle: "Graham", img_url: "" };
const fileKey = figmaFileKey("abc");

// An in-memory Figma comments API, standing in at the network boundary. Reactions land on the
// comment they name, posted as `tokenUser`, the way Figma attributes a token's writes.
function fakeFigma() {
  let clock = 0;
  const comments: Comment[] = [];
  const add = (user: User, message: string, parent_id = ""): Comment => {
    const comment = {
      id: String(1000 + comments.length),
      parent_id,
      file_key: "abc",
      user,
      created_at: new Date(Date.UTC(2026, 9, 1, 0, clock++)).toISOString(),
      resolved_at: null,
      message,
      order_id: null,
      reactions: [],
      client_meta: parent_id ? null : { node_id: "1:1", node_offset: { x: 0, y: 0 } },
    } as unknown as Comment;
    comments.push(comment);
    return comment;
  };
  const byId = (id: string) => comments.find((comment) => comment.id === id)!;
  const figma = {
    getComments: async () => ({ comments: structuredClone(comments) }),
    getFileSlice: async () =>
      ({
        document: { children: [{ id: "1:1", name: "Home", type: "CANVAS", children: [] }] },
      }) as unknown as GetFileResponse,
    postCommentReply: async (_key: string, threadId: string, message: string) => {
      if (byId(threadId).parent_id) throw new Error("Figma refuses a reply to a reply");
      return add(tokenUser, message, threadId);
    },
    addCommentReaction: async (_key: string, id: string, emoji: string) => {
      byId(id).reactions.push({ user: tokenUser, emoji, created_at: "" });
    },
    removeCommentReaction: async (_key: string, id: string, emoji: string) => {
      const target = byId(id);
      target.reactions = target.reactions.filter(
        (r) => !(r.emoji === emoji && r.user.id === tokenUser.id),
      );
    },
  } as unknown as FigmaService;
  const open = async () =>
    (
      await getFigmaComments(figma, fileKey, { include: "full", status: "unresolved" })
    ).threads!.map((thread) => thread.id);
  return { figma, add, open };
}

it("a handled reply drops the thread from unresolved reads until a person replies after it", async () => {
  const { figma, add, open } = fakeFigma();
  const root = add(designer, "Make the header blue");
  const designerReply = add(designer, "Darker than the logo", root.id);

  // Naming a reply still answers the thread: Figma only accepts a root.
  const result = await replyToFigmaComment(figma, fileKey, {
    commentId: designerReply.id,
    message: "Changed the header fill to #1E3A8A.",
    handled: true,
  });
  expect(result).toMatchObject({
    kind: "posted",
    threadId: root.id,
    handled: true,
    reply: { message: "[AGENT] Changed the header fill to #1E3A8A.", author: { handle: "Graham" } },
  });
  expect(await open()).toEqual([]);

  const all = await getFigmaComments(figma, fileKey, { include: "full", status: "all" });
  expect(all.threads).toMatchObject([{ id: root.id, handled: true }]);

  add(designer, "Too dark now", root.id);
  expect(await open()).toEqual([root.id]);
});

it("refuses a reply written before someone's newer comment, then an open reply takes back the ✅", async () => {
  const { figma, add, open } = fakeFigma();
  const root = add(designer, "Fix the spacing");
  await replyToFigmaComment(figma, fileKey, { commentId: root.id, message: "Done", handled: true });
  const question = add(designer, "Which spacing token did you use?", root.id);

  // The agent names the root it read first, so it hasn't seen the question: nothing is posted.
  const stale = await replyToFigmaComment(figma, fileKey, {
    commentId: root.id,
    message: "Done again",
    handled: true,
  });
  expect(stale).toMatchObject({
    kind: "stale",
    unseen: [{ id: question.id }],
    newestCommentId: question.id,
  });

  const answer = await replyToFigmaComment(figma, fileKey, {
    commentId: question.id,
    message: "[AGENT] space-4. Should it be space-3?",
    handled: false,
  });
  expect(answer).toMatchObject({ kind: "posted", handled: false });
  expect(await open()).toEqual([root.id]);
  // Polling from its own reply, the agent isn't handed back the thread it just asked in.
  const since = await getFigmaComments(figma, fileKey, {
    include: "full",
    status: "unresolved",
    since: answer.kind === "posted" ? answer.reply.createdAt : "",
  });
  expect(since.total).toBe(0);
  const [thread] = (await getFigmaComments(figma, fileKey, { include: "full", status: "all" }))
    .threads!;
  // One "Done", no "Done again", and a marker the agent already wrote isn't doubled.
  expect(thread.replies!.map((reply) => reply.message)).toEqual([
    "[AGENT] Done",
    "Which spacing token did you use?",
    "[AGENT] space-4. Should it be space-3?",
  ]);
});

it("a post that fails without Figma refusing it warns that the reply may exist", async () => {
  const { figma, add } = fakeFigma();
  const root = add(designer, "Fix the spacing");
  figma.postCommentReply = async () => {
    throw new Error("socket hang up");
  };
  await expect(
    replyToFigmaComment(figma, fileKey, { commentId: root.id, message: "Done", handled: true }),
  ).rejects.toThrow(/may have been posted anyway/);
});

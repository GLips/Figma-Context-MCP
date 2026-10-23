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

it("an open reply takes back an earlier handled mark, and since ignores the agent's own reply", async () => {
  const { figma, add, open } = fakeFigma();
  const root = add(designer, "Fix the spacing");
  await replyToFigmaComment(figma, fileKey, {
    commentId: root.id,
    message: "Done",
    handled: true,
  });
  add(designer, "Which spacing token did you use?", root.id);

  const question = await replyToFigmaComment(figma, fileKey, {
    commentId: root.id,
    message: "[AGENT] space-4. Should it be space-3?",
    handled: false,
  });
  expect(await open()).toEqual([root.id]);
  // Polling from its own reply, the agent isn't handed back the thread it just asked in.
  const since = await getFigmaComments(figma, fileKey, {
    include: "full",
    status: "unresolved",
    since: question.reply.createdAt,
  });
  expect(since.total).toBe(0);
  const [thread] = (await getFigmaComments(figma, fileKey, { include: "full", status: "all" }))
    .threads!;
  // An agent that already wrote the marker doesn't get it twice.
  expect(thread.replies!.at(-1)!.message).toBe("[AGENT] space-4. Should it be space-3?");
});

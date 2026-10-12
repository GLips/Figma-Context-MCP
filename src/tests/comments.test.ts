import { expect, it } from "vitest";
import type { Comment, GetFileResponse } from "@figma/rest-api-spec";
import type { FigmaService } from "~/services/figma.js";
import { getFigmaComments, type GetFigmaCommentsOptions } from "~/services/get-figma-comments.js";
import { figmaFileKey } from "~/utils/figma-url.js";

// One screen on "Home": a clipping card holding a button instance (label inside), a hidden overlay
// painted above the card, and a non-clipping badge whose child overflows it. "Archive" is empty.
const box = (x: number, y: number, width: number, height: number) => ({
  absoluteBoundingBox: { x, y, width, height },
});
const screen = {
  id: "10:1",
  name: "Screen",
  type: "FRAME",
  ...box(0, 0, 400, 400),
  children: [
    {
      id: "10:2",
      name: "Card",
      type: "FRAME",
      clipsContent: true,
      ...box(0, 0, 200, 200),
      children: [
        {
          id: "10:3",
          name: "Button",
          type: "INSTANCE",
          ...box(20, 20, 100, 40),
          children: [{ id: "I10:3;1:1", name: "Label", type: "TEXT", ...box(30, 30, 50, 20) }],
        },
      ],
    },
    { id: "10:4", name: "Overlay", type: "RECTANGLE", visible: false, ...box(150, 150, 100, 100) },
    {
      id: "10:5",
      name: "Badge",
      type: "FRAME",
      clipsContent: false,
      ...box(300, 300, 50, 50),
      children: [{ id: "10:6", name: "Overflow", type: "RECTANGLE", ...box(360, 360, 20, 20) }],
    },
  ],
};
const file = (homeChildren: unknown[]) =>
  ({
    document: {
      id: "0:0",
      name: "Document",
      type: "DOCUMENT",
      children: [
        { id: "1:1", name: "Home", type: "CANVAS", children: homeChildren },
        { id: "2:1", name: "Archive", type: "CANVAS", children: [] },
      ],
    },
  }) as unknown as GetFileResponse;

// A hidden frame whose child is visible on its own, and an auto-layout frame that paints its first
// child on top — both share the point (5, 5) between two children.
const hiddenFrame = {
  id: "30:1",
  name: "Hidden frame",
  type: "FRAME",
  visible: false,
  ...box(1000, 0, 100, 100),
  children: [{ id: "30:2", name: "Visible child", type: "RECTANGLE", ...box(1000, 0, 50, 50) }],
};
const reversedStack = {
  id: "40:1",
  name: "Stack",
  type: "FRAME",
  layoutMode: "HORIZONTAL",
  itemReverseZIndex: true,
  ...box(2000, 0, 100, 100),
  children: [
    { id: "40:2", name: "First (on top)", type: "RECTANGLE", ...box(2000, 0, 50, 50) },
    { id: "40:3", name: "Second", type: "RECTANGLE", ...box(2000, 0, 50, 50) },
  ],
};
const frames = [screen, hiddenFrame, reversedStack];

let clock = 0;
function comment(id: string, client_meta: unknown, extra: Partial<Comment> = {}): Comment {
  clock++;
  return {
    id,
    client_meta,
    parent_id: "",
    file_key: "abc",
    user: { id: "u1", handle: "Ana", img_url: "" },
    created_at: `2026-10-0${clock}T00:00:00.000Z`,
    resolved_at: null,
    message: `message ${id}`,
    order_id: null,
    reactions: [],
    ...extra,
  } as Comment;
}
const onScreen = (x: number, y: number) => ({ node_id: "10:1", node_offset: { x, y } });
const comments = [
  comment("label", onScreen(35, 35)),
  comment("under-hidden-overlay", onScreen(160, 160)),
  comment("overflow", onScreen(365, 365)),
  comment("archive", { node_id: "2:1", node_offset: { x: -50, y: 900 } }),
  comment("canvas", { x: 5, y: 5 }),
  comment("resolved", onScreen(35, 35), { resolved_at: "2026-10-09T00:00:00.000Z" }),
  comment("reply", null, { parent_id: "under-hidden-overlay" }),
];

function run(options: Partial<GetFigmaCommentsOptions> = {}, fixture = comments) {
  const sliceCalls: string[][] = [];
  const figma = {
    getComments: async () => ({ comments: fixture }),
    getFileSlice: async (_key: string, ids: string[]) => {
      sliceCalls.push(ids);
      return file(frames.filter((frame) => ids.includes(frame.id)));
    },
  } as unknown as FigmaService;
  const result = getFigmaComments(figma, figmaFileKey("abc"), {
    include: "full",
    status: "unresolved",
    ...options,
  });
  return result.then((value) => ({ ...value, sliceCalls }));
}

it("places each pin on the deepest visible node under it and never fetches a page's subtree", async () => {
  const result = await run();
  const placed = Object.fromEntries(
    result.threads!.map((t) => [t.id, t.inferredTarget?.name ?? t.anchor]),
  );
  expect(placed).toEqual({
    label: "Label",
    "under-hidden-overlay": "Card",
    overflow: "Overflow",
    archive: { kind: "page", id: "2:1", name: "Archive", offset: { x: -50, y: 900 } },
    canvas: { kind: "canvas", offset: { x: 5, y: 5 } },
  });
  const label = result.threads!.find((t) => t.id === "label")!;
  expect(label.anchor).toMatchObject({ kind: "node", name: "Screen", path: "Home" });
  expect(label.inferredTarget).toEqual({
    id: "I10:3;1:1",
    name: "Label",
    type: "TEXT",
    path: "Home › Screen › Card › Button",
  });
  expect(result.threads!.find((t) => t.id === "under-hidden-overlay")!.replies).toHaveLength(1);
  expect(result.sliceCalls).toEqual([[], ["10:1"]]);
});

it("counts each thread once on its assigned node, and scope matches that node's ancestors", async () => {
  const counts = await run({ include: "counts" });
  expect(counts.total).toBe(5);
  expect(counts.unlocated).toBe(1);
  expect(Object.fromEntries(counts.targets!.map((t) => [t.name, t.threads]))).toEqual({
    Label: 1,
    Card: 1,
    Overflow: 1,
    Archive: 1,
  });

  const ids = async (scope: string[]) => (await run({ scope })).threads!.map((t) => t.id);
  expect(await ids(["10:3"])).toEqual(["label"]);
  expect((await ids(["10:2"])).sort()).toEqual(["label", "under-hidden-overlay"]);
  expect(await ids(["2:1"])).toEqual(["archive"]);
  expect(await ids(["10:4"])).toEqual([]);
});

it("since resurfaces a thread by its newest reply; the watermark ignores filters", async () => {
  const replyTime = comments.find((c) => c.id === "reply")!.created_at;
  const result = await run({ since: replyTime });
  expect(result.threads!.map((t) => t.id)).toEqual(["under-hidden-overlay"]);
  expect(result.watermark).toBe(replyTime);
});

it("makes no file calls when no thread survives the filters", async () => {
  const result = await run({}, [comments[5]]);
  expect(result).toMatchObject({ total: 0, threads: [], sliceCalls: [] });
});

it("leaves a pin on a hidden anchor, and honors an auto-layout frame's reversed paint order", async () => {
  const fixture = [
    comment("on-hidden", { node_id: "30:1", node_offset: { x: 5, y: 5 } }),
    comment("on-stack", { node_id: "40:1", node_offset: { x: 5, y: 5 } }),
  ];
  const result = await run({}, fixture);
  const placed = Object.fromEntries(result.threads!.map((t) => [t.id, t.inferredTarget?.name]));
  expect(placed).toEqual({ "on-hidden": undefined, "on-stack": "First (on top)" });
});

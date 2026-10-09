/**
 * The comments tool's work: fetch a file's comments, place each thread on the node it most likely
 * points at, filter, and shape the answer.
 *
 * Figma pins every comment to a top-level frame or a page. To name the node under the pin we need the
 * anchors' subtrees, but a page's "subtree" is the whole page — so the page list comes first (a tiny
 * call) and only frame anchors go into the geometry fetch. Worst case: one Tier-2 comments call plus two
 * Tier-1 file calls. A call with no matching threads stops after the comments call.
 */
import type { Node as FigmaNode, GetFileResponse } from "@figma/rest-api-spec";
import { hitTestCommentPin, type CommentPinGeometry } from "@framelink/core";
import type { FigmaService } from "./figma.js";
import {
  commentTimes,
  readCommentThreads,
  type CommentPoint,
  type CommentReply,
  type CommentThread,
} from "./figma-comments.js";

export interface GetFigmaCommentsOptions {
  /** Node ids; a thread matches when the node it is assigned to sits in one of their subtrees. */
  scope?: string[];
  include: "counts" | "full";
  status: "unresolved" | "all";
  /** ISO timestamp; keeps threads with any comment created at or after it. */
  since?: string;
}

/** A node named the way an agent orients: its name and the names above it, page first. */
export interface CommentNodeRef {
  id: string;
  name: string;
  type: string;
  path: string;
}

/** What Figma recorded. `missing` means the anchor id isn't in the file any more. */
export type CommentAnchor =
  | { kind: "node"; id: string; name: string; path: string; offset: CommentPoint }
  | { kind: "node"; id: string; missing: true; offset: CommentPoint }
  | { kind: "page"; id: string; name: string; offset: CommentPoint }
  /** No `offset` only when Figma sent the root without any pin at all. */
  | { kind: "canvas"; offset?: CommentPoint };

export interface LocatedCommentThread extends CommentReply {
  resolvedAt?: string;
  anchor: CommentAnchor;
  /** Our hit-test guess at the node under the pin — never proof of what the commenter meant. */
  inferredTarget?: CommentNodeRef;
  replies?: CommentReply[];
}

export interface CommentCountTarget {
  kind: "node" | "page";
  id: string;
  name?: string;
  path?: string;
  missing?: true;
  threads: number;
}

export interface GetFigmaCommentsResult {
  /** Matching threads. */
  total: number;
  /** Per assigned node (inferred target, else anchor), most threads first. `include: "counts"` only. */
  targets?: CommentCountTarget[];
  /** Threads on a bare canvas point, which name no page. Only without `scope`, which they can't match. */
  unlocated?: number;
  threads?: LocatedCommentThread[];
  /** Newest comment in the whole file, filters aside — pass it back as `since` next time. */
  watermark?: string;
}

const PATH_SEPARATOR = " › ";

export async function getFigmaComments(
  figma: FigmaService,
  fileKey: string,
  options: GetFigmaCommentsOptions,
): Promise<GetFigmaCommentsResult> {
  const { comments } = await figma.getComments(fileKey);
  const watermark = newestTime(comments.map((comment) => comment.created_at));
  const since = options.since === undefined ? undefined : Date.parse(options.since);
  const threads = readCommentThreads(comments).filter(
    (thread) =>
      (options.status === "all" || thread.resolvedAt === null) &&
      (since === undefined || commentTimes(thread).some((time) => Date.parse(time) >= since)),
  );

  const located = threads.length
    ? locateThreads(threads, await fetchAnchorTree(figma, fileKey, threads))
    : [];
  const scope = options.scope;
  const matching = scope
    ? located.filter(({ subtree }) => subtree.some((id) => scope.includes(id)))
    : located;

  const result: GetFigmaCommentsResult = { total: matching.length };
  if (options.include === "full") result.threads = matching.map(({ thread }) => thread);
  else {
    result.targets = countByTarget(matching);
    const unlocated = matching.filter(({ thread }) => thread.anchor.kind === "canvas").length;
    if (unlocated) result.unlocated = unlocated;
  }
  if (watermark) result.watermark = watermark;
  return result;
}

function newestTime(times: string[]): string | undefined {
  let newest: string | undefined;
  for (const time of times) if (!newest || Date.parse(time) > Date.parse(newest)) newest = time;
  return newest;
}

interface AnchorTree {
  /** Every page in the file, id → name. */
  pages: Map<string, string>;
  /** Each node in the fetched slice, with its page and the ancestors between the page and it. */
  nodes: Map<
    string,
    { node: FigmaNode; page: { id: string; name: string }; ancestors: FigmaNode[] }
  >;
}

async function fetchAnchorTree(
  figma: FigmaService,
  fileKey: string,
  threads: readonly CommentThread[],
): Promise<AnchorTree> {
  const tree: AnchorTree = { pages: new Map(), nodes: new Map() };
  const anchorIds = new Set<string>();
  for (const thread of threads) if (thread.pin?.nodeId) anchorIds.add(thread.pin.nodeId);
  if (!anchorIds.size) return tree;

  const outline = await figma.getFileSlice(fileKey, []);
  for (const page of outline.document.children) tree.pages.set(page.id, page.name);
  const frameIds = [...anchorIds].filter((id) => !tree.pages.has(id));
  if (frameIds.length) indexSlice(await figma.getFileSlice(fileKey, frameIds), tree);
  return tree;
}

function indexSlice(file: GetFileResponse, tree: AnchorTree): void {
  for (const page of file.document.children) {
    const visit = (node: FigmaNode, ancestors: FigmaNode[]): void => {
      tree.nodes.set(node.id, { node, page, ancestors });
      if ("children" in node) for (const child of node.children) visit(child, [...ancestors, node]);
    };
    for (const child of page.children) visit(child, []);
  }
}

// REST geometry for the shared hit-test. `absoluteBoundingBox` is the node's own box, not its render
// bounds — the same box the plugin reads, so both producers hit-test the same rectangles.
const restPinGeometry: CommentPinGeometry<FigmaNode> = {
  bounds: (node) => ("absoluteBoundingBox" in node ? (node.absoluteBoundingBox ?? null) : null),
  visible: (node) => node.visible !== false,
  clipsContent: (node) => "clipsContent" in node && node.clipsContent === true,
  children: (node) => {
    if (!("children" in node)) return [];
    const reversed =
      "itemReverseZIndex" in node &&
      node.itemReverseZIndex === true &&
      "layoutMode" in node &&
      node.layoutMode !== undefined &&
      node.layoutMode !== "NONE";
    return reversed ? [...node.children].reverse() : node.children;
  },
};

interface PlacedThread {
  thread: LocatedCommentThread;
  /** Ids from the page down to the assigned node — what `scope` matches against. */
  subtree: string[];
  /** The count bucket: the assigned node, or the page. Absent for canvas threads. */
  target?: Omit<CommentCountTarget, "threads">;
}

function locateThreads(threads: readonly CommentThread[], tree: AnchorTree): PlacedThread[] {
  return threads.map((thread) => {
    const { pin, replies, resolvedAt, ...root } = thread;
    const shaped = (
      anchor: CommentAnchor,
      inferredTarget?: CommentNodeRef,
    ): LocatedCommentThread => ({
      ...root,
      ...(resolvedAt ? { resolvedAt } : {}),
      anchor,
      ...(inferredTarget ? { inferredTarget } : {}),
      ...(replies.length ? { replies } : {}),
    });

    if (!pin) return { thread: shaped({ kind: "canvas" }), subtree: [] };
    if ("point" in pin)
      return { thread: shaped({ kind: "canvas", offset: pin.point }), subtree: [] };

    const pageName = tree.pages.get(pin.nodeId);
    if (pageName !== undefined) {
      const anchor: CommentAnchor = {
        kind: "page",
        id: pin.nodeId,
        name: pageName,
        offset: pin.offset,
      };
      return {
        thread: shaped(anchor),
        subtree: [pin.nodeId],
        target: { kind: "page", id: pin.nodeId, name: pageName },
      };
    }

    const entry = tree.nodes.get(pin.nodeId);
    if (!entry) {
      const anchor: CommentAnchor = {
        kind: "node",
        id: pin.nodeId,
        missing: true,
        offset: pin.offset,
      };
      return {
        thread: shaped(anchor),
        subtree: [pin.nodeId],
        target: { kind: "node", id: pin.nodeId, missing: true },
      };
    }

    const { node: anchorNode, page, ancestors } = entry;
    const anchorPath = [page.name, ...ancestors.map((node) => node.name)].join(PATH_SEPARATOR);
    const anchor: CommentAnchor = {
      kind: "node",
      id: anchorNode.id,
      name: anchorNode.name,
      path: anchorPath,
      offset: pin.offset,
    };
    const box = restPinGeometry.bounds(anchorNode);
    const below =
      box && ancestors.every(restPinGeometry.visible)
        ? hitTestCommentPin(
            anchorNode,
            { x: box.x + pin.offset.x, y: box.y + pin.offset.y },
            restPinGeometry,
          )
        : [];
    const chain = [...ancestors, anchorNode, ...below];
    const assigned = chain[chain.length - 1];
    const assignedPath = [page.name, ...chain.slice(0, -1).map((node) => node.name)].join(
      PATH_SEPARATOR,
    );
    const inferredTarget = below.length
      ? { id: assigned.id, name: assigned.name, type: assigned.type, path: assignedPath }
      : undefined;
    return {
      thread: shaped(anchor, inferredTarget),
      subtree: [page.id, ...chain.map((node) => node.id)],
      target: { kind: "node", id: assigned.id, name: assigned.name, path: assignedPath },
    };
  });
}

function countByTarget(placed: readonly PlacedThread[]): CommentCountTarget[] {
  const counts = new Map<string, CommentCountTarget>();
  for (const { target } of placed) {
    if (!target) continue;
    const entry = counts.get(target.id);
    if (entry) entry.threads++;
    else counts.set(target.id, { ...target, threads: 1 });
  }
  return [...counts.values()].sort((a, b) => b.threads - a.threads);
}

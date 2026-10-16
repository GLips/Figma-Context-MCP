/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { readCommentThreads } from "~/services/figma-comments.js";
import type { CapabilityHandler } from "./bridge.js";

/** One unresolved thread's pin, in the anchor's own frame — the preamble hit-tests it on live geometry. */
export interface CommentPinRecord {
  nodeId: string;
  x: number;
  y: number;
}

/**
 * `comments.pins`: the unresolved threads pinned to a node, for the plugin's read counts.
 *
 * Pins only — no bodies, authors or times cross to the sandbox, because the counts need none of them.
 * Nothing is cached: the fetch spends the run's own caller's token (ChannelRunContext), and its result
 * must not outlive that request. Canvas-point threads are dropped here; they land on no node.
 *
 * The file is the run's own document, never one the payload names: the sandbox may only read the
 * comments of the file it was admitted to.
 */
export function createCommentPinsCapability(): CapabilityHandler {
  return async (_payload, { signal, run }) => {
    const { fileKey } = run;
    if (fileKey === null)
      throw { code: "INVALID_INPUT", message: "comments.pins is only for a run on a document." };
    if (!run.figma)
      throw {
        code: "FIGMA_AUTH_UNAVAILABLE",
        message: "This run has no Figma credentials to read comments with.",
      };
    const { comments } = await run.figma.withSignal(signal).getComments(fileKey);
    const pins: CommentPinRecord[] = [];
    for (const thread of readCommentThreads(comments)) {
      if (thread.resolvedAt === null && thread.pin?.nodeId)
        pins.push({ nodeId: thread.pin.nodeId, x: thread.pin.offset.x, y: thread.pin.offset.y });
    }
    return { pins };
  };
}

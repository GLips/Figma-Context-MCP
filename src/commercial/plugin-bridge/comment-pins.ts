/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { readCommentThreads } from "~/services/figma-comments.js";
import type { CapabilityHandler } from "./bridge.js";
import { CapabilityFailure } from "./channel-failure.js";

/** One open thread's pin, in the anchor's own frame — the preamble hit-tests it on live geometry. */
export interface CommentPinRecord {
  nodeId: string;
  x: number;
  y: number;
}

/**
 * `comments.pins`: the open threads pinned to a node — unresolved and not handled by an agent — for
 * the plugin's read counts.
 *
 * Pins only — no bodies, authors or times cross to the sandbox, because the counts need none of them.
 * Nothing is cached: the fetch spends the run's own caller's token (ChannelRunContext), and its result
 * must not outlive that request. Canvas-point threads are dropped here; they land on no node.
 *
 * The file is the run's own document, never one the payload names: the sandbox may only read the
 * comments of the file it was admitted to. That needs the file key the plugin reported; a build that
 * reports none has no comments to read here, and the preamble takes the refusal as no counts.
 */
export function createCommentPinsCapability(): CapabilityHandler {
  return async (_payload, { signal, run }) => {
    const { fileKey } = run;
    // Kind "figma" for both: the call is fine, and this file's comments can't be read here. Neither fix
    // is in the agent's code, so each names the step that does fix it.
    if (fileKey === null)
      throw new CapabilityFailure(
        "figma",
        "Figma doesn't give this build of the Framelink plugin the file's key, so reads here carry no comment counts. " +
          "To read this file's comments, call get_figma_comments with the file's URL.",
      );
    if (!run.figma)
      throw new CapabilityFailure(
        "figma",
        "the server has no Figma token to read this file's comments with. Set FIGMA_API_KEY (a token with File comments: Read) " +
          "or pass --figma-api-key where the server runs, or send X-Figma-Token on the HTTP request.",
      );
    const { comments } = await run.figma.withSignal(signal).getComments(fileKey);
    const pins: CommentPinRecord[] = [];
    for (const thread of readCommentThreads(comments)) {
      if (thread.resolvedAt === null && !thread.handled && thread.pin?.nodeId)
        pins.push({ nodeId: thread.pin.nodeId, x: thread.pin.offset.x, y: thread.pin.offset.y });
    }
    return { pins };
  };
}

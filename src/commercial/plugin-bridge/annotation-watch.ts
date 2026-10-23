/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// watch_figma_feedback's annotation half: asks the plugin open in the watched file which annotations
// changed (ANNOTATION_CHANGES). The plugin keeps the change log and checks the grant on every ask;
// this server keeps nothing between asks but the cursor the agent hands back.
//
// Deliberately prompt-free and pairing-free, unlike a run: a watch is re-called every 40s for as long
// as the agent listens, and an Allow prompt or pairing code on each would be noise. A file not yet
// granted is reported as unwatched, with how to grant it.
import type { AnnotationChangeSource, AnnotationPoll } from "~/services/watch-figma-feedback.js";
import type { FigmaFileKey } from "~/utils/figma-url.js";
import { BridgeRequestError, type PluginBridge } from "./bridge.js";
import { quoteFigmaName } from "./blocked-call-guidance.js";

export function createBridgeAnnotationSource(bridge: PluginBridge): AnnotationChangeSource {
  return {
    async poll(fileKey, after, holdMs, signal) {
      const inFile = bridge.authenticatedLinks().flatMap((link) => {
        const document = bridge.documentOf(link);
        return document.kind === "identified" && document.fileKey === fileKey
          ? [{ link, document }]
          : [];
      });
      if (!inFile.length) return unwatched(noPluginInFileNote(bridge, fileKey));
      let refusedIn: string | null = null;
      for (const { link, document } of inFile) {
        let reply;
        try {
          reply = await bridge.request(
            link,
            { type: "ANNOTATION_CHANGES", documentId: document.documentId, after, holdMs },
            { signal },
          );
        } catch (error) {
          if (signal.aborted || !(error instanceof BridgeRequestError)) throw error;
          return unwatched(`Annotations weren't watched this time: ${error.message}`);
        }
        if (reply.type === "NOT_GRANTED") {
          refusedIn = document.fileName;
          continue;
        }
        const { cursor, changes, restarted, overflowed } = reply;
        return { kind: "watched", cursor, changes, restarted, overflowed };
      }
      return unwatched(
        `Annotations aren't watched: this project isn't allowed in ${quoteFigmaName(refusedIn!)} yet. ` +
          "Any figma_execute_code call naming that file asks the user to Allow it in the Framelink plugin; after that, watches include annotations.",
      );
    },
  };
}

function unwatched(note: string): AnnotationPoll {
  return { kind: "unwatched", note };
}

function noPluginInFileNote(bridge: PluginBridge, fileKey: FigmaFileKey): string {
  const open = bridge.authenticatedLinks().map((link) => bridge.documentOf(link));
  const keyless = open.some(
    (document) => document.kind === "identified" && document.fileKey === null,
  );
  return (
    "Annotations aren't watched: no Framelink plugin is open in this file" +
    (keyless
      ? `, or the open plugin doesn't report its file key (looked for ${fileKey}).`
      : ". Open the Framelink plugin in Figma, in this file, to include annotations.")
  );
}

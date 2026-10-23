/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// watch_figma_feedback's annotation half: reads the change log of the plugin open in the watched file
// (ANNOTATION_CHANGES) when it says the log moved (ANNOTATIONS_CHANGED). The plugin keeps the log and
// checks the grant on every read; this server keeps nothing between reads but the cursor the agent
// hands back.
//
// Deliberately prompt-free and pairing-free, unlike a run: a watcher reads on every notice for as long
// as the agent listens, and an Allow prompt or pairing code on each would be noise. A file not yet
// granted is reported as unwatched, with how to grant it.
import { setTimeout as delay } from "node:timers/promises";
import type { AnnotationChangeSource, AnnotationPoll } from "~/services/watch-figma-feedback.js";
import type { FigmaFileKey } from "~/utils/figma-url.js";
import { BridgeRequestError, type PluginBridge } from "./bridge.js";
import { quoteFigmaName } from "./blocked-call-guidance.js";

export function createBridgeAnnotationSource(bridge: PluginBridge): AnnotationChangeSource {
  const inFile = (fileKey: FigmaFileKey) =>
    bridge.authenticatedLinks().flatMap((link) => {
      const document = bridge.documentOf(link);
      return document.kind === "identified" && document.fileKey === fileKey
        ? [{ link, document }]
        : [];
    });

  // A plugin already open dials a relay that just started only on its next redial, so "no plugin in
  // this file" waits until one links or every open plugin has had its chance.
  async function linkedInFile(fileKey: FigmaFileKey, signal: AbortSignal) {
    const done = new AbortController();
    const settled = bridge.whenLinksSettled(AbortSignal.any([signal, done.signal])).then(
      () => true,
      () => true,
    );
    try {
      for (;;) {
        const found = inFile(fileKey);
        if (found.length || (await Promise.race([settled, delay(250, false, { signal })])))
          return found.length ? found : inFile(fileKey);
      }
    } finally {
      done.abort();
    }
  }

  return {
    async read(fileKey, after, signal) {
      const linked = await linkedInFile(fileKey, signal);
      if (!linked.length) return unwatched(noPluginInFileNote(bridge, fileKey));
      let refusedIn: string | null = null;
      for (const { link, document } of linked) {
        let reply;
        try {
          reply = await bridge.request(
            link,
            { type: "ANNOTATION_CHANGES", documentId: document.documentId, after },
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

    async moved(fileKey, after, signal) {
      // Only the plugin run `after` came from can say it moved past it; another run's notices count
      // from its own start, and a restart is found by the watcher's next periodic read.
      const past = () =>
        inFile(fileKey).some(({ link }) => {
          const log = bridge.annotationLogOf(link);
          return log?.epoch === after.epoch && log.seq > after.seq;
        });
      while (!past()) await bridge.whenAnnotationLogMoves(signal);
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

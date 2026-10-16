/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Which file this plugin run is in. The plugin never decides that itself — the Community build has
// no figma.fileKey, and a file's name proves nothing. A server proves it: the plugin writes the
// server's nonce into the file root's shared plugin data, and the server finds it there over REST.
// A proven key is kept in the root as a claim, so the next plugin run has something to prove; a
// duplicated file carries the claim too, fails the proof, and loses it.
import { reply, type ReplyTo } from "./outbound.js";
import type { ConnKey } from "./panel.js";
import {
  DOCUMENT_CLAIM_KEY,
  DOCUMENT_DATA_NAMESPACE,
  DOCUMENT_PROOF_KEY_PREFIX,
  isWireFileKey,
  type ProofOutcome,
} from "./protocol.js";

/** The document a server proved this plugin run to be in. */
export interface ProvenDocument {
  fileKey: string;
  fileName: string;
}

/** A file key off a pasted Figma link, or null when it isn't one. Hand-rolled: there is no URL class. */
export function fileKeyFromFigmaLink(text: string): string | null {
  const match = /^\s*(?:https?:\/\/)?(?:[\w-]+\.)?figma\.com\/(?:file|design|proto)\/([A-Za-z0-9]+)/i.exec(text);
  return match && isWireFileKey(match[1]) ? match[1] : null;
}

/** Where a pasted link stands: waiting for a server's proof, or refuted by one. */
export type PastedLink = { fileKey: string; refuted: boolean } | null;

export function createDocumentIdentity({
  show,
  onProven,
}: {
  show: () => void;
  /** The document is proven: grants on it can be read now. */
  onProven: (document: ProvenDocument) => void;
}) {
  let proven: ProvenDocument | null = null;
  let pasted: PastedLink = null;
  // Nonces still out, and the connection that asked for each, so a closed connection's are cleared.
  const nonces = new Map<string, ConnKey>();

  function readClaim(): string | null {
    const claim = figma.root.getSharedPluginData(DOCUMENT_DATA_NAMESPACE, DOCUMENT_CLAIM_KEY);
    return isWireFileKey(claim) ? claim : null;
  }

  function writeNonce(nonce: string, written: boolean): void {
    figma.root.setSharedPluginData(DOCUMENT_DATA_NAMESPACE, DOCUMENT_PROOF_KEY_PREFIX + nonce, written ? "1" : "");
  }

  function settle(outcome: ProofOutcome): void {
    if (outcome.kind === "proven") {
      // One run is in one file. A second, different answer is a confused server, not a move.
      if (proven && proven.fileKey !== outcome.fileKey) return;
      proven = { fileKey: outcome.fileKey, fileName: outcome.fileName };
      if (pasted?.fileKey === outcome.fileKey) pasted = null;
      if (readClaim() !== outcome.fileKey)
        figma.root.setSharedPluginData(DOCUMENT_DATA_NAMESPACE, DOCUMENT_CLAIM_KEY, outcome.fileKey);
      onProven(proven);
      return;
    }
    if (outcome.kind !== "refuted" || proven) return;
    if (readClaim() === outcome.fileKey)
      figma.root.setSharedPluginData(DOCUMENT_DATA_NAMESPACE, DOCUMENT_CLAIM_KEY, "");
    if (pasted?.fileKey === outcome.fileKey) pasted = { fileKey: outcome.fileKey, refuted: true };
  }

  return {
    get document(): ProvenDocument | null {
      return proven;
    },

    get pastedLink(): PastedLink {
      return pasted;
    },

    /** The file key a past proof left in this file's root, while this run hasn't been proven. */
    claim(): string | null {
      return proven ? proven.fileKey : (pasted?.refuted === false ? pasted.fileKey : readClaim());
    },

    writeProof(to: ReplyTo, nonce: string): void {
      try {
        writeNonce(nonce, true);
        nonces.set(nonce, to.connKey);
        reply(to, { type: "PROOF_WRITTEN" });
      } catch (error) {
        // A viewer can't write to the file, so it can't be proven — and couldn't be edited anyway.
        reply(to, { type: "ERROR", error: `This plugin couldn't mark the file to prove which one it is: ${String(error)}` });
      }
    },

    proofSettled(to: ReplyTo, nonce: string, outcome: ProofOutcome): void {
      if (nonces.delete(nonce)) clearNonce(nonce);
      settle(outcome);
      reply(to, { type: "PROOF_SETTLED_ACK" });
      show();
    },

    /** The human pasted a link: it is a claim until a server proves it. */
    paste(text: string): string | null {
      const fileKey = fileKeyFromFigmaLink(text);
      if (fileKey === null || proven) return null;
      pasted = { fileKey, refuted: false };
      show();
      return fileKey;
    },

    closed(key: ConnKey): void {
      for (const [nonce, owner] of nonces)
        if (owner === key) {
          nonces.delete(nonce);
          clearNonce(nonce);
        }
    },
  };

  function clearNonce(nonce: string): void {
    try {
      writeNonce(nonce, false);
    } catch {
      // Clearing a spent nonce is housekeeping: a viewer that couldn't write one can't clear one.
    }
  }
}

export type DocumentIdentity = ReturnType<typeof createDocumentIdentity>;

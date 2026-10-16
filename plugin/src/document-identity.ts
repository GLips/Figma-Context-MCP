/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Which file this plugin run is in: a document id this plugin stamps into the file root's private
// plugin data the first time it needs one. The stamp persists with the file, so every later run and
// every collaborator's plugin reads the same id, and a duplicate carries it too. It tells open files
// apart and keys grants; it proves nothing, and never says whether this user may edit the file.
//
// The stamp is written only when absent, and re-read before every admission and dequeue: two first
// opens can race, and a copy given its own identity in another instance changes it under this one.
import { DOCUMENT_ID_KEY, mintDocumentId, type DocumentReport } from "./protocol.js";

// How often names and the stamp are re-read for reporting. Figma has no event for a rename without
// loading every page, and a read of the root's names is cheap.
const DOCUMENT_REPORT_POLL_MS = 2_000;

function readStamp(): string {
  return figma.root.getPluginData(DOCUMENT_ID_KEY);
}

/** `figma.fileKey`, which only private and development builds get. */
function buildFileKey(): string | undefined {
  const fileKey = (figma as { fileKey?: unknown }).fileKey;
  return typeof fileKey === "string" && fileKey.length > 0 ? fileKey : undefined;
}

export function createDocumentIdentity({
  onChanged,
  onReport,
}: {
  /**
   * The stamp is no longer `previous` (null: there was none). Fires before the new report goes out,
   * so whatever was admitted under the old id is stopped first.
   */
  onChanged: (previous: string | null) => void;
  /** The report changed: send it to every server. */
  onReport: (report: DocumentReport) => void;
}) {
  let documentId: string | null = null;
  let problem: string | null = null;
  // Set while "Give this copy its own identity" waits for running executions: nothing is admitted.
  let restamping = false;
  let lastReport = "";

  /** Write a stamp when there is none, then read back what the file holds: a racing write may win. */
  function settleStamp(): void {
    let stamp = readStamp();
    problem = null;
    if (!stamp) {
      try {
        figma.root.setPluginData(DOCUMENT_ID_KEY, mintDocumentId());
        stamp = readStamp();
      } catch (error) {
        problem = `Figma refused to mark this file for Framelink (${String(error)}), so agents can't use it.`;
      }
    }
    const next = stamp || null;
    if (next === documentId) return;
    const previous = documentId;
    documentId = next;
    if (previous !== null) onChanged(previous);
  }

  function report(): DocumentReport {
    if (documentId === null)
      return { kind: "unidentified", problem: problem ?? "This file hasn't been marked for Framelink yet." };
    const fileKey = buildFileKey();
    return {
      kind: "identified",
      documentId,
      fileName: figma.root.name,
      pageNames: figma.root.children.map((page) => page.name),
      ...(fileKey ? { fileKey } : {}),
    };
  }

  function reportIfChanged(): void {
    const now = report();
    const serialized = JSON.stringify(now);
    if (serialized === lastReport) return;
    lastReport = serialized;
    onReport(now);
  }

  /**
   * The file's stamp now, re-read; null while unidentified or being given a new identity. A stamp
   * that changed fires onChanged and onReport before this returns.
   */
  function rereadDocumentId(): string | null {
    if (restamping) return null;
    settleStamp();
    reportIfChanged();
    return documentId;
  }

  function poll(): void {
    if (!restamping) settleStamp();
    reportIfChanged();
    setTimeout(poll, DOCUMENT_REPORT_POLL_MS);
  }

  return {
    /** Read or write the stamp, and start watching for changes worth reporting. */
    start(): void {
      settleStamp();
      lastReport = JSON.stringify(report());
      setTimeout(poll, DOCUMENT_REPORT_POLL_MS);
    },

    rereadDocumentId,

    /** The stamp as last read, for display and grant rows: never re-reads. */
    get documentId(): string | null {
      return restamping ? null : documentId;
    },

    /** The report as last read, for display: never re-reads. */
    report,

    /** The report after re-reading the stamp, for a server that asks which file this is. */
    rereadReport(): DocumentReport {
      rereadDocumentId();
      return report();
    },

    /**
     * Give this file its own identity: a fresh stamp, once `idle` says nothing admitted under the old
     * one is still running. Grants stay with the old id; this copy needs its own.
     */
    async restamp(idle: () => Promise<void>): Promise<void> {
      if (restamping || documentId === null) return;
      restamping = true;
      try {
        await idle();
        figma.root.setPluginData(DOCUMENT_ID_KEY, mintDocumentId());
      } catch (error) {
        figma.notify(`Framelink couldn't give this file its own identity: ${String(error)}`, { error: true });
      } finally {
        restamping = false;
      }
      // A fresh stamp fires onChanged here; a refused write leaves the old identity in force.
      settleStamp();
      reportIfChanged();
    },
  };
}

export type DocumentIdentity = ReturnType<typeof createDocumentIdentity>;

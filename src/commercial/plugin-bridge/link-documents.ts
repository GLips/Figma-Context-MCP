/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Which file each authenticated link is in, as its plugin reports it: the document id the plugin
// stamped into the file, the names an agent chooses by, and the file key where the plugin build has
// one. Nothing here is proof: the stamp tells open files apart, and grants key on it.
import type { DocumentReport, ReplyFor, ServerRequest } from "@framelink/plugin/protocol";
import { figmaFileKey, type FigmaFileKey } from "~/utils/figma-url.js";
import type { DocumentId } from "./document-id.js";
import type { RelayConnection } from "./relay-connection.js";

/** A file a plugin link is in, as the plugin reported it. */
export interface OpenFile {
  documentId: DocumentId;
  fileName: string;
  pageNames: readonly string[];
  /** Only from builds that expose `figma.fileKey`; never inferred. */
  fileKey: FigmaFileKey | null;
}

/**
 * Which file an authenticated link is in. `unknown`: its introduction hasn't answered. `unidentified`:
 * the plugin couldn't stamp the file, so the link executes nothing.
 */
export type LinkDocument =
  | { kind: "unknown" }
  | { kind: "unidentified"; problem: string }
  | ({ kind: "identified" } & OpenFile);

export interface LinkDocumentsOptions {
  send: (
    link: RelayConnection,
    payload: Extract<ServerRequest, { type: "INTRODUCE" }>,
  ) => Promise<ReplyFor<"INTRODUCE">>;
  project: string;
  framelinkOrigin: string;
}

const UNKNOWN_DOCUMENT: LinkDocument = { kind: "unknown" };

/** The plugin's report, its ids already admitted by the protocol's parser. */
function linkDocumentOf(report: DocumentReport): LinkDocument {
  if (report.kind === "unidentified") return report;
  return {
    kind: "identified",
    documentId: report.documentId as DocumentId,
    fileName: report.fileName,
    pageNames: report.pageNames,
    fileKey: report.fileKey === undefined ? null : figmaFileKey(report.fileKey),
  };
}

export class LinkDocuments {
  // The only record of which file each link is in. Weak: a dropped link takes its entry with it.
  private readonly documents = new WeakMap<RelayConnection, LinkDocument>();
  // Each link's introduction still in flight. A call waits these out rather than guess.
  private readonly busy = new Map<RelayConnection, Promise<void>>();

  constructor(private readonly options: LinkDocumentsOptions) {}

  documentOf(link: RelayConnection): LinkDocument {
    return this.documents.get(link) ?? UNKNOWN_DOCUMENT;
  }

  /** Tell a just-authenticated link who this server is, and learn which file it is in. */
  introduce(link: RelayConnection): void {
    const { project, framelinkOrigin } = this.options;
    const work = this.options
      .send(link, { type: "INTRODUCE", project, framelinkOrigin })
      .then(
        (reply) => {
          // A report that arrived while the introduction was in flight is newer: keep it.
          if (link.isOpen && !this.documents.has(link))
            this.documents.set(link, linkDocumentOf(reply.document));
        },
        () => {},
      )
      .finally(() => {
        if (this.busy.get(link) === work) this.busy.delete(link);
      });
    this.busy.set(link, work);
  }

  /** The plugin reported its file again: a new stamp, or new names. */
  reported(link: RelayConnection, report: DocumentReport): void {
    this.documents.set(link, linkDocumentOf(report));
  }

  /** Resolves once none of `links` is being introduced. Never rejects. */
  async settled(links: readonly RelayConnection[]): Promise<void> {
    await Promise.all(links.flatMap((link) => this.busy.get(link) ?? []));
  }
}

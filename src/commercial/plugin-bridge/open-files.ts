/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Which Figma files have the plugin open on this machine, read at call time: every linked plugin is
// asked OPEN_INSTANCES, which answers from the plugin's shared storage (plugin/src/presence.ts), so a
// file whose plugin hasn't linked to this server yet is still listed. A hidden Figma window can take
// several seconds to link (measured: up to ~6 s), so "not linked" never means "not open": only an
// entry gone stale (2 min) does, and the plugin drops those.
import type { OpenInstance } from "@framelink/plugin/protocol";
import { figmaFileKey, type FigmaFileKey } from "~/utils/figma-url.js";
import type { DocumentId } from "./document-id.js";
import type { LinkDocument } from "./link-documents.js";
import type { RelayConnection } from "./relay-connection.js";

// A plugin's main thread held by a long export still answers nothing: past this, its file is
// "not every open plugin answered" rather than a call stalled on it.
const OPEN_INSTANCES_ASK_MS = 2_000;

/** One open plugin instance's file, and the link it reached this server on, if it has. */
export interface OpenFileInstance {
  instance: string;
  documentId: DocumentId;
  fileName: string;
  fileKey: FigmaFileKey | null;
  currentPage: string;
  pageCount: number;
  selection: { count: number; names: readonly string[] };
  /** Its window or tab is the one showing. */
  active: boolean;
  /** This project may edit it. */
  granted: boolean;
  /** Null: open, but not linked to this server yet. */
  link: RelayConnection | null;
}

/**
 * One open document, as an agent chooses from: every instance with its stamp, described by the one
 * the human is most likely looking at.
 */
export interface OpenDocument {
  documentId: DocumentId;
  fileName: string;
  fileKey: FigmaFileKey | null;
  currentPage: string;
  pageCount: number;
  selection: { count: number; names: readonly string[] };
  active: boolean;
  granted: boolean;
  /** How many open files carry this stamp that nothing tells apart: above 1, a copy is open. */
  copies: number;
}

/**
 * Every open file, for a call to bind by and a refusal or the reference to show. `complete` is false
 * when a linked plugin hasn't said which file it is in, or couldn't be asked: then no call defaults.
 */
export interface OpenDocumentSnapshot {
  documents: OpenDocument[];
  instances: OpenFileInstance[];
  /** Why each plugin that couldn't stamp its file can't be used. */
  unidentified: string[];
  complete: boolean;
}

/** What a snapshot reads: the links, which file and instance each is, and its plugin's list. */
export interface OpenFilesLookup {
  links(): readonly RelayConnection[];
  documentOf(link: RelayConnection): LinkDocument;
  /** The plugin instance a link introduced itself as; undefined until its introduction answered. */
  instanceOf(link: RelayConnection): string | undefined;
  /** Rejects when the plugin couldn't be asked. */
  openInstances(link: RelayConnection, signal: AbortSignal): Promise<OpenInstance[]>;
}

/**
 * Instances one stamp covers that nothing tells apart: two collapse only when both reported the same
 * file key. One without a key is its own file — it may be a copy.
 */
export function distinctFileCount(instances: readonly { fileKey: FigmaFileKey | null }[]): number {
  const keyed = new Set(instances.flatMap((instance) => instance.fileKey ?? []));
  return keyed.size + instances.filter((instance) => instance.fileKey === null).length;
}

function boundedAsk(
  lookup: OpenFilesLookup,
  link: RelayConnection,
  signal: AbortSignal,
): Promise<OpenInstance[] | null> {
  const ask = AbortSignal.any([signal, AbortSignal.timeout(OPEN_INSTANCES_ASK_MS)]);
  return lookup.openInstances(link, ask).catch(() => null);
}

// The instance the human is most likely looking at, so the line describes their view of the file.
function representative(instances: readonly OpenFileInstance[]): OpenFileInstance {
  return instances.find((i) => i.active) ?? instances.find((i) => i.link) ?? instances[0];
}

export async function openDocumentSnapshot(
  lookup: OpenFilesLookup,
  signal: AbortSignal,
): Promise<OpenDocumentSnapshot> {
  const links = lookup.links();
  const documents = links.map((link) => lookup.documentOf(link));
  const asked = links.filter((_, index) => documents[index].kind !== "unknown");
  const replies = await Promise.all(asked.map((link) => boundedAsk(lookup, link, signal)));
  signal.throwIfAborted();
  const linkOf = new Map<string, RelayConnection>();
  for (const link of links) {
    const instance = lookup.instanceOf(link);
    if (instance !== undefined) linkOf.set(instance, link);
  }
  // Each instance's own word on itself wins: it describes itself live, the others from storage.
  const byInstance = new Map<string, OpenInstance>();
  asked.forEach((link, index) => {
    for (const open of replies[index] ?? [])
      if (!byInstance.has(open.instance) || open.instance === lookup.instanceOf(link))
        byInstance.set(open.instance, open);
  });
  const instances: OpenFileInstance[] = [...byInstance.values()].map((open) => ({
    instance: open.instance,
    documentId: open.documentId as DocumentId,
    fileName: open.fileName,
    fileKey: open.fileKey === undefined ? null : figmaFileKey(open.fileKey),
    currentPage: open.currentPage,
    pageCount: open.pageCount,
    selection: open.selection,
    active: open.active,
    granted: open.granted,
    link: linkOf.get(open.instance) ?? null,
  }));
  const byDocument = new Map<DocumentId, OpenFileInstance[]>();
  for (const instance of instances)
    byDocument.set(instance.documentId, [...(byDocument.get(instance.documentId) ?? []), instance]);
  return {
    documents: [...byDocument.values()].map((copies) => {
      const shown = representative(copies);
      return {
        documentId: shown.documentId,
        fileName: shown.fileName,
        fileKey: copies.find((copy) => copy.fileKey)?.fileKey ?? null,
        currentPage: shown.currentPage,
        pageCount: shown.pageCount,
        selection: shown.selection,
        active: copies.some((copy) => copy.active),
        granted: copies.some((copy) => copy.granted),
        copies: distinctFileCount(copies),
      };
    }),
    instances,
    unidentified: documents.flatMap((document) =>
      document.kind === "unidentified" ? [document.problem] : [],
    ),
    complete:
      documents.every((document) => document.kind !== "unknown") &&
      replies.every((reply) => reply !== null),
  };
}

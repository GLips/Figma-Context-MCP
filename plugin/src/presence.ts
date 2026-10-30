/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Which plugin instances are open on this machine, and what each one's file looks like, so a server
// can tell an agent which files it could run in: even files whose plugin hasn't linked to it yet. Each
// instance keeps one clientStorage entry; every file this plugin is open in shares that storage
// (measured: another file reads a write within 77 ms).
//
// Freshness is the only liveness signal. A tab closed outright never finishes a figma.on("close")
// write (measured), so a closed instance's entry just ages out.
import { grantKey } from "./grant-store.js";
import {
  MAX_SELECTION_NAMES,
  MAX_SUMMARY_NAME_LENGTH,
  mintDocumentId,
  type OpenInstance,
} from "./protocol.js";

const PRESENCE_KEY_PREFIX = "presence/";
// A hidden window's timers tick about once a minute: two ticks, so a live instance never reads as gone.
const PRESENCE_FRESH_MS = 120_000;
const PRESENCE_REFRESH_MS = 30_000;
// An entry this old is no open instance's: swept when the list is read, so storage doesn't grow.
const PRESENCE_SWEEP_MS = 24 * 60 * 60_000;
// Coalesces a burst of selection changes into one write.
const PRESENCE_CHANGE_DEBOUNCE_MS = 250;
// More grants than one document plausibly carries; keeps an entry bounded.
const MAX_ENTRY_GRANTS = 32;

export interface PresenceStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/** This instance's file now, as `describe` reads it. Bounded here before it is stored or sent. */
export interface PresenceFile {
  documentId: string;
  fileName: string;
  fileKey?: string;
  currentPage: string;
  pageCount: number;
  selection: { count: number; names: string[] };
  /** Its window or tab is showing (the panel iframe's visibility). */
  active: boolean;
}

/**
 * Whose grant an answer reports: the asking link's credential, the plugin's owner and the server's
 * project. Null (an owner not signed in, say) reports nothing granted.
 */
export type PresenceAsker = { credentialId: string; ownerId: string; project: string } | null;

// `grantKeys` are grant-store keys (digests), so an entry names no project path, and an answer can
// report only whether the asker's own key is among them.
interface PresenceEntry extends PresenceFile {
  seenAt: number;
  grantKeys: string[];
}

function isPresenceEntry(value: unknown): value is PresenceEntry {
  const entry = value as PresenceEntry | null;
  return (
    typeof entry?.documentId === "string" &&
    typeof entry.seenAt === "number" &&
    typeof entry.fileName === "string" &&
    typeof entry.currentPage === "string" &&
    typeof entry.pageCount === "number" &&
    typeof entry.selection?.count === "number" &&
    Array.isArray(entry.selection.names) &&
    typeof entry.active === "boolean" &&
    Array.isArray(entry.grantKeys)
  );
}

function bounded(file: PresenceFile): PresenceFile {
  const cut = (name: string) => name.slice(0, MAX_SUMMARY_NAME_LENGTH);
  return {
    documentId: file.documentId,
    fileName: cut(file.fileName),
    ...(file.fileKey ? { fileKey: file.fileKey } : {}),
    currentPage: cut(file.currentPage),
    pageCount: file.pageCount,
    selection: { count: file.selection.count, names: file.selection.names.slice(0, MAX_SELECTION_NAMES).map(cut) },
    active: file.active,
  };
}

function asOpenInstance(instance: string, file: PresenceFile, grantKeys: readonly string[], asker: PresenceAsker): OpenInstance {
  const { documentId } = file;
  return {
    instance,
    ...bounded(file),
    granted: asker !== null && grantKeys.includes(grantKey({ ...asker, documentId })),
  };
}

export function createPluginPresence({
  storage,
  describe,
  grantKeysOf,
}: {
  storage: PresenceStorage;
  /** This file now; null while it has no stamp, which removes this instance's entry. */
  describe: () => PresenceFile | null;
  /** The grant-store keys held on `documentId` by this plugin's owner, under any credential. */
  grantKeysOf: (documentId: string) => Promise<string[]>;
}) {
  // One per plugin run, in a document id's shape so the wire admits it with the same parser.
  const instance = mintDocumentId();
  const key = PRESENCE_KEY_PREFIX + instance;
  let writtenAt = 0;
  let dirty = true;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  // Writes run in order, so a slow earlier write never lands over a later one.
  let writing: Promise<void> = Promise.resolve();

  // A hint, not state: a failed write only leaves a server's list a step behind for this instance.
  const quietly = (write: Promise<void>) => write.catch(() => {});

  function write(): void {
    dirty = false;
    writtenAt = Date.now();
    writing = writing.then(() =>
      quietly(
        (async () => {
          const file = describe();
          if (file === null) return storage.delete(key);
          const grantKeys = (await grantKeysOf(file.documentId)).slice(0, MAX_ENTRY_GRANTS);
          const entry: PresenceEntry = { ...bounded(file), seenAt: Date.now(), grantKeys };
          return storage.set(key, entry);
        })(),
      ),
    );
  }

  function touch(): void {
    if (dirty || Date.now() - writtenAt >= PRESENCE_REFRESH_MS) write();
  }

  function refreshLoop(): void {
    touch();
    setTimeout(refreshLoop, PRESENCE_REFRESH_MS);
  }

  return {
    instance,

    /** Write this instance's entry and keep it fresh. Call after the file's stamp is settled. */
    start(): void {
      refreshLoop();
      figma.on("close", () => void quietly(storage.delete(key)));
    },

    /**
     * Refresh the entry if it is due or something changed. Called on every server frame too, which a
     * hidden window still handles promptly while its timers crawl.
     */
    touch,

    /** Something `describe` reads changed (page, selection, visibility, name, grant): write it soon. */
    changed(): void {
      dirty = true;
      if (debounce !== undefined) return;
      debounce = setTimeout(() => {
        debounce = undefined;
        touch();
      }, PRESENCE_CHANGE_DEBOUNCE_MS);
    },

    /**
     * Every instance whose entry is fresh, this one included while its file is stamped, with the
     * asker's grant on each.
     */
    async openInstances(asker: PresenceAsker): Promise<OpenInstance[]> {
      touch();
      const now = Date.now();
      // This instance's own entry is skipped: it is described live instead, as its write may lag.
      const keys = (await storage.keys()).filter((k) => k.startsWith(PRESENCE_KEY_PREFIX) && k !== key);
      const entries = await Promise.all(keys.map(async (k) => [k, await storage.get(k)] as const));
      const open: OpenInstance[] = [];
      for (const [k, entry] of entries) {
        if (!isPresenceEntry(entry) || now - entry.seenAt > PRESENCE_SWEEP_MS) quietly(storage.delete(k));
        else if (now - entry.seenAt <= PRESENCE_FRESH_MS)
          open.push(asOpenInstance(k.slice(PRESENCE_KEY_PREFIX.length), entry, entry.grantKeys, asker));
      }
      const self = describe();
      if (self !== null) open.push(asOpenInstance(instance, self, await grantKeysOf(self.documentId), asker));
      return open;
    },
  };
}

export type PluginPresence = ReturnType<typeof createPluginPresence>;

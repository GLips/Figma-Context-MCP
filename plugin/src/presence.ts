/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Which plugin instances are open on this machine, so a server that just started knows whom to expect
// before an unnamed call picks "the one granted document". Each instance keeps one clientStorage
// entry; every file this plugin is open in shares that storage (measured: another file reads a write
// within 77 ms).
//
// Freshness is the only signal. A tab closed outright never finishes a figma.on("close") write
// (measured), so a closed instance's entry just ages out, and the server's short grace absorbs it.
import { mintDocumentId, type OpenInstance } from "./protocol.js";

const PRESENCE_KEY_PREFIX = "presence/";
// A hidden window's timers tick about once a minute: two ticks, so a live instance never reads as gone.
const PRESENCE_FRESH_MS = 120_000;
const PRESENCE_REFRESH_MS = 30_000;
// An entry this old is no open instance's: swept when the list is read, so storage doesn't grow.
const PRESENCE_SWEEP_MS = 24 * 60 * 60_000;

export interface PresenceStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

interface PresenceEntry {
  documentId: string;
  seenAt: number;
}

function isPresenceEntry(value: unknown): value is PresenceEntry {
  const entry = value as PresenceEntry | null;
  return typeof entry?.documentId === "string" && typeof entry.seenAt === "number";
}

export function createPluginPresence({
  storage,
  documentId,
}: {
  storage: PresenceStorage;
  /** This file's stamp as last read; null while it has none, which removes this instance's entry. */
  documentId: () => string | null;
}) {
  // One per plugin run, in a document id's shape so the wire admits it with the same parser.
  const instance = mintDocumentId();
  const key = PRESENCE_KEY_PREFIX + instance;
  let writtenAt = 0;
  let written: string | null = null;

  // A hint, not state: a failed write only costs a server its short grace for this instance.
  const quietly = (write: Promise<void>) => write.catch(() => {});

  function touch(): void {
    const current = documentId();
    const now = Date.now();
    if (current === written && now - writtenAt < PRESENCE_REFRESH_MS) return;
    writtenAt = now;
    written = current;
    quietly(current === null ? storage.delete(key) : storage.set(key, { documentId: current, seenAt: now }));
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
     * Refresh the entry if it is due or the stamp changed. Called on every server frame too, which a
     * hidden window still handles promptly while its timers crawl.
     */
    touch,

    /** Every instance whose entry is fresh, this one included while its file is stamped. */
    async openInstances(): Promise<OpenInstance[]> {
      touch();
      const now = Date.now();
      // This instance's own entry is skipped: its write may still be in flight, so it is named from
      // the stamp instead.
      const keys = (await storage.keys()).filter((k) => k.startsWith(PRESENCE_KEY_PREFIX) && k !== key);
      const entries = await Promise.all(keys.map(async (k) => [k, await storage.get(k)] as const));
      const open: OpenInstance[] = [];
      for (const [k, entry] of entries) {
        if (!isPresenceEntry(entry) || now - entry.seenAt > PRESENCE_SWEEP_MS) quietly(storage.delete(k));
        else if (now - entry.seenAt <= PRESENCE_FRESH_MS)
          open.push({ instance: k.slice(PRESENCE_KEY_PREFIX.length), documentId: entry.documentId });
      }
      const current = documentId();
      if (current !== null) open.push({ instance, documentId: current });
      return open;
    },
  };
}

export type PluginPresence = ReturnType<typeof createPluginPresence>;

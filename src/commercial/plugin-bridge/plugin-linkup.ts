/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Which plugin instances this server still waits for before it may say a document isn't open, or
// pick the one granted document for an unnamed call. Every introduction names the instances the
// plugin's shared storage says are open; each is awaited until a link introduces it, or for a short
// grace, after which it counts as closed: a tab closed outright leaves a fresh-looking entry behind.
import { PLUGIN_LEAD_REDIAL_MS, type OpenInstance } from "@framelink/plugin/protocol";
import type { DocumentId } from "./document-id.js";
import type { RelayConnection } from "./relay-connection.js";

/** How long a plugin instance named open may take to link: one lead redial, then the handshake. */
export const PLUGIN_LINKUP_GRACE_MS = PLUGIN_LEAD_REDIAL_MS + 1_000;

export class PluginLinkup {
  // Instances named open, with when the wait for each ends. Kept once it has, so a later
  // introduction re-naming a closed tab's stale entry doesn't restart the wait.
  private readonly awaited = new Map<string, { documentId: DocumentId; until: number }>();
  private readonly instanceOf = new Map<RelayConnection, string>();
  // Before any introduction, nobody has said who is open: a plugin may yet be on its first redial.
  private unheardUntil: number;
  private readonly waiters = new Set<() => void>();

  constructor(private readonly graceMs = PLUGIN_LINKUP_GRACE_MS) {
    this.unheardUntil = Date.now() + graceMs;
  }

  /** The server just bound its port: every open plugin is on its way. */
  started(): void {
    this.unheardUntil = Date.now() + this.graceMs;
    this.moved();
  }

  introduced(
    link: RelayConnection,
    instance: string,
    openInstances: readonly OpenInstance[],
  ): void {
    this.instanceOf.set(link, instance);
    this.unheardUntil = 0;
    const until = Date.now() + this.graceMs;
    for (const open of openInstances)
      if (!this.awaited.has(open.instance))
        this.awaited.set(open.instance, { documentId: open.documentId as DocumentId, until });
    this.moved();
  }

  /** An introduced link closed. Its plugin, if still open, redials at once: wait for it again. */
  dropped(link: RelayConnection, documentId: DocumentId | null): void {
    const instance = this.instanceOf.get(link);
    if (instance === undefined) return;
    this.instanceOf.delete(link);
    if (documentId !== null)
      this.awaited.set(instance, { documentId, until: Date.now() + this.graceMs });
    this.moved();
  }

  /**
   * When the wait ends for every instance named open that no link has introduced: at or before now
   * when nothing is awaited. With `documentId`, only instances in that document are counted.
   */
  settlesAt(documentId?: DocumentId): number {
    const linked = new Set(this.instanceOf.values());
    let at = this.unheardUntil;
    for (const [instance, entry] of this.awaited)
      if (!linked.has(instance) && (documentId === undefined || entry.documentId === documentId))
        at = Math.max(at, entry.until);
    return at;
  }

  /** Resolves after `ms`, or sooner at the next introduction or drop. Rejects when `signal` aborts. */
  pause(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const finish = (settle: () => void) => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        signal.removeEventListener("abort", abort);
        settle();
      };
      const wake = () => finish(resolve);
      const abort = () => finish(() => reject(signal.reason));
      const timer = setTimeout(wake, Math.max(ms, 0));
      this.waiters.add(wake);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  /** Resolves once nothing is awaited (in `documentId` only, if named). Rejects when `signal` aborts. */
  async whenSettled(signal: AbortSignal, documentId?: DocumentId): Promise<void> {
    for (
      let wait = this.settlesAt(documentId) - Date.now();
      wait > 0;
      wait = this.settlesAt(documentId) - Date.now()
    )
      await this.pause(wait, signal);
  }

  private moved(): void {
    const waiting = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiting) wake();
  }
}

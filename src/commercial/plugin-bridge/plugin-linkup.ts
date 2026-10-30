/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Which plugin instance each link is, and a wake-up for a call waiting on one still linking. A call
// waits only for the file it names or picked (call-target.ts): there is no grace after which an
// instance named open counts as closed, since a hidden Figma window can take several seconds to dial.
import type { RelayConnection } from "./relay-connection.js";

export class PluginLinkup {
  private readonly instances = new Map<RelayConnection, string>();
  private readonly waiters = new Set<() => void>();

  introduced(link: RelayConnection, instance: string): void {
    this.instances.set(link, instance);
    this.moved();
  }

  dropped(link: RelayConnection): void {
    if (this.instances.delete(link)) this.moved();
  }

  /** The instance `link` introduced itself as; undefined until its introduction answered. */
  instanceOf(link: RelayConnection): string | undefined {
    return this.instances.get(link);
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

  private moved(): void {
    const waiting = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiting) wake();
  }
}

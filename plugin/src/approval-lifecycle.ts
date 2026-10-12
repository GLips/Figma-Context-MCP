/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */

/**
 * What the store can say about a token. "unknown" while the stored approvals are still loading or a
 * change is being written: the gate stays closed, but nothing may treat it as a "no" and prompt the
 * human — the caller waits for `settled` and asks again.
 */
export type ApprovalAnswer = "approved" | "unapproved" | "unknown";

/** Ordered durable approvals. Restoration and every change run in one chain, in order. */
export function createApprovalLifecycle(storage: {
  load(): Promise<unknown>;
  save(tokens: string[]): Promise<void>;
}, report: (error: unknown) => void) {
  const tokens = new Set<string>();
  let pending = 0;
  let loaded = false;
  let tail = storage.load().then((value) => {
    if (Array.isArray(value)) for (const token of value) {
      if (typeof token === "string") tokens.add(token);
    }
  }).catch(report).then(() => { loaded = true; });
  const ready = tail;

  function change(apply: () => void, rollback?: () => void): Promise<void> {
    pending++;
    const operation = tail.then(async () => {
      apply();
      try { await storage.save([...tokens]); }
      catch (error) {
        rollback?.();
        report(error);
        throw error;
      }
    }).finally(() => { pending--; });
    tail = operation.catch(() => {});
    return operation;
  }

  return {
    ready,
    /** Resolves once everything queued so far has landed. A change queued after may make it unknown again. */
    get settled(): Promise<void> { return tail; },
    approval(token: string): ApprovalAnswer {
      if (!loaded || pending > 0) return "unknown";
      return tokens.has(token) ? "approved" : "unapproved";
    },
    get size() { return tokens.size; },
    allow(token: string) { return change(() => { tokens.add(token); }, () => { tokens.delete(token); }); },
    revoke(token: string) { return change(() => { tokens.delete(token); }); },
    revokeAll() { return change(() => { tokens.clear(); }); },
  };
}

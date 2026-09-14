/** Ordered durable approvals. Gates stay closed during restoration and pending changes. */
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
    has: (token: string) => loaded && pending === 0 && tokens.has(token),
    get size() { return tokens.size; },
    allow(token: string) { return change(() => { tokens.add(token); }, () => { tokens.delete(token); }); },
    revoke(token: string) { return change(() => { tokens.delete(token); }); },
    revokeAll() { return change(() => { tokens.clear(); }); },
  };
}

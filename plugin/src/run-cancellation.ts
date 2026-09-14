// __connKey identifies one socket generation, assigned by ui.html. Ports are reusable;
// this identity is not. Old settlement can only release the old generation's run.
export interface RunRef {
  id: string;
  connKey: number | undefined;
}

function runKey(connKey: number | undefined, runId: string): string {
  return String(connKey) + ":" + runId;
}

export function createRunCancellationRegistry() {
  const cancelled = new Set<string>();
  const outstanding = new Set<string>();
  return {
    enqueue(ref: RunRef): void { outstanding.add(runKey(ref.connKey, ref.id)); },
    settle(ref: RunRef): void {
      const key = runKey(ref.connKey, ref.id);
      outstanding.delete(key);
      cancelled.delete(key);
    },
    recordCancellation(connKey: number | undefined, runId: string): void {
      const key = runKey(connKey, runId);
      // Transport delivery is ordered. A cancel follows enqueue, or names an already
      // settled/non-execution request. Retaining the latter would leak per generation.
      if (outstanding.has(key)) cancelled.add(key);
    },
    takeCancellation(ref: RunRef): boolean { return cancelled.delete(runKey(ref.connKey, ref.id)); },
    isCancelled(ref: RunRef): boolean { return cancelled.has(runKey(ref.connKey, ref.id)); },
    cancelConnection(connKey: number): void {
      const prefix = String(connKey) + ":";
      for (const key of outstanding) if (key.startsWith(prefix)) cancelled.add(key);
    },
  };
}

/** Wraps jobs so at most `max` run at once; unbounded when `max` is undefined. */
export function limitConcurrency(
  max: number | undefined,
): <T>(job: () => Promise<T>) => Promise<T> {
  if (max === undefined) return (job) => job();
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (job) => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await job();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

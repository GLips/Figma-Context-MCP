const DURATION_RE = /^(\d+)(ms|s|m|h)$/;

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

/**
 * Parse a duration like `30s`, `5m`, `1h`, or `500ms`.
 * Throws on anything else — callers decide how to present the failure.
 */
export function parseDuration(value: string): number {
  const match = DURATION_RE.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid duration '${value}'. Expected a value like 30s, 5m, or 1h.`);
  }
  return Number(match[1]) * UNIT_MS[match[2]];
}

/**
 * Compact form of a millisecond count: `500ms`, `42s`, `5m`, `2m 5s`, `1h`,
 * `1h 1m`. Above one second the remainder is dropped, not rounded.
 */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.floor(ms)}ms`;
  const totalSeconds = Math.floor(ms / 1_000);
  const parts: Array<[number, string]> = [
    [Math.floor(totalSeconds / 3_600), "h"],
    [Math.floor((totalSeconds % 3_600) / 60), "m"],
    [totalSeconds % 60, "s"],
  ];
  return parts
    .filter(([count]) => count > 0)
    .map(([count, unit]) => `${count}${unit}`)
    .join(" ");
}

/**
 * Age shown next to a cached design. Sub-second ages collapse so an entry
 * stored moments ago doesn't read as `0s`, which looks like a broken clock.
 */
export function formatCacheAge(ageMs: number): string {
  if (ageMs < 1_000) return "under 1s";
  return formatDuration(ageMs);
}

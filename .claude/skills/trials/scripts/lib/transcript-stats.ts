// Counts pulled from `sq tail --type tool_use,tool_result` output. The header
// shape is sq's: `#N  HH:MM:SS  <role> tool_use <name>` / `... tool_result ↳#M`,
// with the body indented beneath and error results prefixed `[error]`.

export interface TranscriptStats {
  toolCalls: Record<string, number>;
  toolErrors: number;
}

const TOOL_USE_RE = /^#\d+\s+\S+\s+\S+\s+tool_use\s+(\S+)/;
const TOOL_RESULT_RE = /^#\d+\s+\S+\s+\S+\s+tool_result/;
const ERROR_BODY_RE = /^\s+\[error\]/;

export function parseTranscriptStats(tailOutput: string): TranscriptStats {
  const stats: TranscriptStats = { toolCalls: {}, toolErrors: 0 };
  let inResult = false;
  for (const line of tailOutput.split("\n")) {
    const use = line.match(TOOL_USE_RE);
    if (use) {
      inResult = false;
      const name = use[1]!;
      stats.toolCalls[name] = (stats.toolCalls[name] ?? 0) + 1;
      continue;
    }
    if (TOOL_RESULT_RE.test(line)) {
      inResult = true;
      continue;
    }
    if (inResult && ERROR_BODY_RE.test(line)) {
      stats.toolErrors++;
      inResult = false;
    }
  }
  return stats;
}

export function formatStats(stats: TranscriptStats): string {
  const calls = Object.entries(stats.toolCalls)
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${name} ×${n}`)
    .join(", ");
  return `Tool calls: ${calls || "none"}. Tool errors: ${stats.toolErrors}.`;
}

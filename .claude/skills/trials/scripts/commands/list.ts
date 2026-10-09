import { defineCommand } from "citty";
import { listRuns } from "../lib/runs.ts";
import { listTrials, type TrialDefinition } from "../lib/trial.ts";

export default defineCommand({
  meta: {
    name: "list",
    description: "Trials with surface, source page, and last run",
  },
  run() {
    const lastRunOf = new Map<string, string>();
    for (const r of listRuns()) lastRunOf.set(r.trial, r.startedAt.slice(0, 10));

    const rows = listTrials().map((t) => [
      t.name,
      t.surface,
      sourceColumn(t),
      t.blocked
        ? `waiting on ${t.blocked}`
        : lastRunOf.has(t.name)
          ? `last run ${lastRunOf.get(t.name)}`
          : "never run",
    ]);
    const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
    for (const r of rows) {
      process.stdout.write(
        r
          .map((c, i) => c.padEnd(widths[i]!))
          .join("  ")
          .trimEnd() + "\n",
      );
    }
  },
});

// A trial that reads or edits an existing page says so through {source}; show
// where that page comes from, or that nobody has set it yet.
function sourceColumn(t: TrialDefinition): string {
  if (t.needs) return `needs ${t.needs}`;
  if (t.page) return `page ${JSON.stringify(t.page)}`;
  const usesSource = /\{source\}/.test(t.brief) || /\{source\}/.test(t.followUp ?? "");
  return usesSource ? "page: unset — add `page:` to the trial" : "";
}

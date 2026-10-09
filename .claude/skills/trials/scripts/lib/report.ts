import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPORTS_DIR } from "./paths.ts";
import type { RunRecord } from "./runs.ts";
import type { TrialDefinition } from "./trial.ts";
import { formatStats, type TranscriptStats } from "./transcript-stats.ts";

export function buildReport(params: {
  run: RunRecord;
  trial: TrialDefinition;
  stats: TranscriptStats;
}): string {
  const { run, trial, stats } = params;
  const lines: string[] = [];

  lines.push("---");
  lines.push(`trial: ${run.trial}`);
  lines.push(`track: ${run.track}`);
  lines.push(`surface: ${run.surface}`);
  lines.push(`model: ${run.model}`);
  lines.push(`page: ${JSON.stringify(run.page)}`);
  if (run.source) lines.push(`source: ${JSON.stringify(run.source)}`);
  lines.push(`slug: ${run.slug}`);
  lines.push(`session: ${run.sessionId ?? ""}`);
  lines.push(`started: ${run.startedAt}`);
  if (run.builtAt) lines.push(`build_minutes: ${minutesBetween(run.startedAt, run.builtAt)}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${run.trial} — ${run.startedAt.slice(0, 10)} (${run.track})`);
  lines.push("");
  lines.push(formatStats(stats));
  lines.push("");
  lines.push("## Prompt");
  lines.push("");
  lines.push(quote(run.prompt));
  if (run.followUp) {
    lines.push("");
    lines.push("## Follow-up");
    lines.push("");
    lines.push(quote(run.followUp));
  }
  lines.push("");
  lines.push("## Interview");
  lines.push("");
  lines.push(
    run.interview?.trim() || `_Not interviewed yet — run \`trials interview ${run.slug}\`._`,
  );
  if (run.track === "craft") {
    lines.push("");
    lines.push("## Verdict");
    lines.push("");
    lines.push(`_Graham, on page ${JSON.stringify(run.page)}, against the rubric:_`);
    lines.push("");
    lines.push(trial.rubric?.trim() || "_(trial has no rubric)_");
    lines.push("");
    lines.push("Verdict: ");
  }
  lines.push("");
  lines.push("## Triage");
  lines.push("");
  lines.push("### Fix now");
  lines.push("");
  lines.push("### File a ticket");
  lines.push("");
  return lines.join("\n");
}

// One file per run, keyed by start minute + trial. Re-running `report` on the
// same run overwrites it; two runs of one trial in the same minute isn't a
// case worth designing for.
export function reportPath(run: RunRecord): string {
  const d = run.startedAt;
  const dated = `${d.slice(0, 10)}-${d.slice(11, 13)}${d.slice(14, 16)}`;
  return join(REPORTS_DIR, `${dated}-${run.trial}.md`);
}

export function writeReport(run: RunRecord, markdown: string): string {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const path = reportPath(run);
  writeFileSync(path, markdown);
  return path;
}

function quote(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
}

function minutesBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
}

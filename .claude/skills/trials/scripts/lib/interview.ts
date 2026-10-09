import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REFERENCES_DIR } from "./paths.ts";
import { type RunRecord, saveRun } from "./runs.ts";
import { sqLastText, sqSendAndWait } from "./sq.ts";

// The interview text is the reference file verbatim, so the questions have one
// home and rounds stay comparable over months.
export function interviewPrompt(): string {
  return readFileSync(join(REFERENCES_DIR, "interview.md"), "utf8").trim();
}

export async function interviewRun(run: RunRecord): Promise<string> {
  await sqSendAndWait(run.slug, interviewPrompt());
  const answers = await sqLastText(run.slug);
  run.interview = answers;
  run.interviewedAt = new Date().toISOString();
  saveRun(run);
  return answers;
}

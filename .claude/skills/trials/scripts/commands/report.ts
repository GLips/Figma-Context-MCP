import { defineCommand } from "citty";
import { buildReport, writeReport } from "../lib/report.ts";
import { loadRun } from "../lib/runs.ts";
import { sq } from "../lib/sq.ts";
import { parseTranscriptStats } from "../lib/transcript-stats.ts";
import { loadTrial } from "../lib/trial.ts";

export default defineCommand({
  meta: {
    name: "report",
    description:
      "(Re)write a run's report from its record. Tool-call stats come from the session transcript when the session is still open; without it they read as none.",
  },
  args: {
    slug: { type: "positional", description: "Run slug (see trials/runs/)", required: true },
  },
  async run({ args }) {
    const run = loadRun(args.slug as string);
    const trial = loadTrial(run.trial);
    const tail = await sq(["tail", run.slug, "--type", "tool_use,tool_result", "--last", "100000"]);
    if (tail.code !== 0) {
      process.stderr.write(`Session ${run.slug} is closed; report carries no tool stats.\n`);
    }
    const stats = parseTranscriptStats(tail.code === 0 ? tail.stdout : "");
    const path = writeReport(run, buildReport({ run, trial, stats }));
    process.stdout.write(path + "\n");
  },
});

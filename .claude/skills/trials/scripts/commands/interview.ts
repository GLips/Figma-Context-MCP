import { defineCommand } from "citty";
import { interviewRun } from "../lib/interview.ts";
import { loadRun } from "../lib/runs.ts";

export default defineCommand({
  meta: {
    name: "interview",
    description:
      "Send the fixed interview to a run's session (which must still be open) and record the answers. Re-runnable; the newest answers win. Blocks until the agent answers — background it.",
  },
  args: {
    slug: { type: "positional", description: "Run slug (see trials/runs/)", required: true },
  },
  async run({ args }) {
    const run = loadRun(args.slug as string);
    const answers = await interviewRun(run);
    process.stdout.write(answers + "\n");
    process.stderr.write(`Recorded. Regenerate the report with \`trials report ${run.slug}\`.\n`);
  },
});

import { mkdirSync, writeFileSync } from "node:fs";
import { defineCommand } from "citty";
import { interviewRun } from "../lib/interview.ts";
import { listMcpTools } from "../lib/mcp.ts";
import { pageNameFor, slugFor } from "../lib/page-name.ts";
import { DEFAULT_MCP_URL, RENDERS_DIR, RUNS_DIR, SCRATCH_DIR } from "../lib/paths.ts";
import { buildTrialPrompt, renderPrompt } from "../lib/prompt.ts";
import { buildReport, writeReport } from "../lib/report.ts";
import { latestBuiltRunOf, loadLocalConfig, type RunRecord, saveRun } from "../lib/runs.ts";
import { scratchTrusted, TRUST_INSTRUCTIONS } from "../lib/scratch.ts";
import { sqSendAndWait, sqStart, sqToolBlocks } from "../lib/sq.ts";
import { parseTranscriptStats } from "../lib/transcript-stats.ts";
import { loadTrial, type Track, type TrialDefinition } from "../lib/trial.ts";

export default defineCommand({
  meta: {
    name: "run",
    description:
      "Run one trial end to end: spawn a naive agent in the scratch dir, wait for it to finish, send the interview, write the report. Blocks for the whole run (often 10–30 min) — background it.",
  },
  args: {
    trial: { type: "positional", description: "Trial name (see `list`)", required: true },
    model: {
      type: "string",
      description:
        "Model for the trial agent (passed to claude --model). Default: the session default.",
    },
    craft: {
      type: "boolean",
      description:
        "Craft track: best work, iterate, two or three variations, judged against the rubric. Default: ergo.",
      default: false,
    },
  },
  async run({ args }) {
    const trial = loadTrial(args.trial as string);
    if (trial.blocked) {
      fail(
        `${trial.name} is waiting on ${trial.blocked}; clear \`blocked:\` in its file when that lands.`,
      );
    }
    const track: Track = args.craft ? "craft" : "ergo";

    if (!scratchTrusted()) fail(`Run \`trials init\` first.\n${TRUST_INSTRUCTIONS}`);

    const tools = await listMcpTools(DEFAULT_MCP_URL);
    if (!tools.includes("figma_execute_code")) {
      fail(
        `The framelink server advertises [${tools.join(", ")}] but not figma_execute_code — open the Framelink plugin in the trials file so the write tools come online.`,
      );
    }

    const startedAt = new Date();
    const page = pageNameFor(trial.name, startedAt);
    const source = resolveSource(trial);
    const vars = {
      page,
      source,
      file: loadLocalConfig().figmaFileUrl,
      renders: RENDERS_DIR,
    };
    const prompt = buildTrialPrompt({ brief: trial.brief, track, vars });
    const followUp = trial.followUp ? renderPrompt(trial.followUp, vars) : undefined;

    const slug = slugFor(trial.name, startedAt);
    mkdirSync(RUNS_DIR, { recursive: true });
    const primePath = `${RUNS_DIR}/${slug}.prime.md`;
    writeFileSync(primePath, prompt + "\n");

    const run: RunRecord = {
      slug,
      trial: trial.name,
      track,
      surface: trial.surface,
      model: (args.model as string | undefined) ?? "default",
      page,
      source,
      prompt,
      followUp,
      cwd: SCRATCH_DIR,
      startedAt: startedAt.toISOString(),
    };
    saveRun(run);

    process.stderr.write(`Spawning ${slug} on page ${JSON.stringify(page)} …\n`);
    const started = await sqStart({
      slug,
      primePath,
      cwd: SCRATCH_DIR,
      model: args.model as string | undefined,
    });
    run.sessionId = started.session_id;
    saveRun(run);

    if (followUp) {
      process.stderr.write("Build turn settled; sending follow-up …\n");
      await sqSendAndWait(slug, followUp);
    }
    run.builtAt = new Date().toISOString();
    saveRun(run);

    process.stderr.write("Build settled; interviewing …\n");
    await interviewRun(run);

    const stats = parseTranscriptStats(await sqToolBlocks(slug));
    const reportPath = writeReport(run, buildReport({ run, trial, stats }));

    process.stdout.write(
      JSON.stringify({ slug, page, session_id: run.sessionId, report: reportPath }, null, 2) + "\n",
    );
    process.stderr.write(
      `Report: ${reportPath}\nSession left open for inspection — \`sq close ${slug}\` when done.\n`,
    );
  },
});

// A trial that edits or reads an existing page names it one of two ways: a
// literal `page:` (designer-made) or `needs: <trial>` (the newest built run of
// that trial). Neither → undefined, and a brief using {source} fails loudly.
function resolveSource(trial: TrialDefinition): string | undefined {
  if (trial.page) return trial.page;
  if (!trial.needs) return undefined;
  const prior = latestBuiltRunOf(trial.needs);
  if (!prior) fail(`${trial.name} needs a built run of ${trial.needs} — run that first.`);
  return prior.page;
}

function fail(message: string): never {
  process.stderr.write(message + "\n");
  process.exit(1);
}

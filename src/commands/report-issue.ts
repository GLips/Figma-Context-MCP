import { command } from "cleye";
import { UsageError } from "~/config.js";
import {
  REPORT_FRAMELINK_ISSUE_TOOL,
  reportFramelinkIssue,
  reportIssueParametersSchema,
} from "~/mcp/report-issue-tool.js";
import { captureObservedCall, ISSUE_REPORT_KINDS } from "~/telemetry/index.js";
import { buildCommandHelp } from "~/utils/cli-help.js";
import { defineCliCommand } from "./cli-command.js";
import type { CliCommandContext } from "./cli-context.js";

export const reportIssueCommand = defineCliCommand(
  command({
    name: "report-issue",
    strictFlags: true,
    help: buildCommandHelp({
      name: "report-issue",
      summary:
        "Report a problem with Framelink itself to the Framelink team, like report_framelink_issue",
      details:
        "For a Framelink command that failed unexpectedly or returned something wrong, a capability no\ncommand has, or a workaround the commands or docs should have spared you. Sent as usage\ntelemetry, so it needs telemetry on. Never include secrets, personal details or design content.",
      exampleArgs: [
        `--kind bug --summary "execute times out on large frames" --attempted "Restyle the pricing cards" --tool execute`,
      ],
    }),
    flags: {
      kind: {
        type: String,
        placeholder: `<${ISSUE_REPORT_KINDS.join("|")}>`,
        description: "What went wrong (required)",
      },
      summary: { type: String, placeholder: "<text>", description: "One line (required)" },
      attempted: {
        type: String,
        placeholder: "<text>",
        description: "What the user wanted, and what was tried (required)",
      },
      tool: { type: String, placeholder: "<name>", description: "The command or tool involved" },
      expected: { type: String, placeholder: "<text>", description: "What should have happened" },
      actual: {
        type: String,
        placeholder: "<text>",
        description: "What happened instead, error text verbatim",
      },
      workaround: { type: String, placeholder: "<text>", description: "How you got past it" },
      gist: {
        type: String,
        placeholder: "<text>",
        description: "The failing call's shape, names and content replaced by placeholders",
      },
      userWords: { type: String, placeholder: "<text>", description: "What the user said, quoted" },
    },
  }),
  (argv, context) => runReportIssue(argv.flags, context),
);

// The schema strips cleye's own `help` flag, so the CLI accepts exactly what the tool does.
// A token in the environment needs nothing here: the runner has already registered it for scrubbing,
// as the server does its own, and installed the proxy Figma requests use, so a report gets out the same way.
export async function runReportIssue(flags: unknown, context: CliCommandContext): Promise<number> {
  const parsed = reportIssueParametersSchema.safeParse(flags);
  if (!parsed.success)
    throw new UsageError(
      parsed.error.issues
        .map((issue) => `--${kebab(issue.path.join("."))}: ${issue.message}`)
        .join("\n"),
    );
  return context.observe(REPORT_FRAMELINK_ISSUE_TOOL, captureObservedCall, async (call) => {
    const { delivery, text } = await reportFramelinkIssue(parsed.data, {
      transport: "cli",
      authMode: "none",
    });
    call.record({ kind: parsed.data.kind, delivery: delivery.kind });
    console.log(text);
    return delivery.kind === "sent" ? 0 : 1;
  });
}

const kebab = (name: string) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

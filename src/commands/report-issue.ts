import { type Command, command } from "cleye";
import { resolveCredential, resolveProxy, resolveTelemetryEnabled, UsageError } from "~/config.js";
import { reportFramelinkIssue, reportIssueParametersSchema } from "~/mcp/report-issue-tool.js";
import { ISSUE_REPORT_KINDS, initTelemetry, shutdown } from "~/telemetry/index.js";
import { buildCommandHelp } from "~/utils/cli-help.js";
import { installFigmaProxyDispatcher } from "~/utils/figma-proxy-dispatcher.js";

export const reportIssueCommand: Command = command(
  {
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
      noTelemetry: {
        type: Boolean,
        description: "Turn off usage telemetry, which also means sending nothing",
      },
    },
  },
  (argv) => {
    runReportIssue(argv.flags)
      .then((code) => {
        process.exitCode = code;
      })
      .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      })
      .finally(() => shutdown());
  },
);

// The schema strips cleye's own `help` flag, so the CLI accepts exactly what the tool does.
export async function runReportIssue(flags: unknown): Promise<number> {
  const parsed = reportIssueParametersSchema.safeParse(flags);
  if (!parsed.success)
    throw new UsageError(
      parsed.error.issues
        .map((issue) => `--${kebab(issue.path.join("."))}: ${issue.message}`)
        .join("\n"),
    );
  const optOut = (flags as { noTelemetry?: boolean }).noTelemetry;
  // No token is needed to report, but one in the environment is scrubbed from the report, as the
  // server scrubs its own. The proxy is the one Figma requests use, so a report gets out the same way.
  const credential = resolveCredential({});
  installFigmaProxyDispatcher(resolveProxy({}).value);
  initTelemetry({
    enabled: resolveTelemetryEnabled(optOut),
    redactFromTelemetry: credential ? [credential.token] : [],
  });
  const { delivery, text } = await reportFramelinkIssue(parsed.data, {
    transport: "cli",
    authMode: "none",
  });
  console.log(text);
  return delivery.kind === "sent" ? 0 : 1;
}

const kebab = (name: string) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

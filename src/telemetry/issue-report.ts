import { sendEventConfirmed, type ConfirmedSend } from "./client.js";
import type { ToolCallContext } from "./types.js";

export const ISSUE_REPORT_KINDS = ["bug", "missing_capability", "friction"] as const;
export type IssueReportKind = (typeof ISSUE_REPORT_KINDS)[number];

/** What an agent reports about Framelink itself, in its own words. */
export type IssueReport = {
  kind: IssueReportKind;
  summary: string;
  attempted: string;
  tool?: string;
  expected?: string;
  actual?: string;
  workaround?: string;
  gist?: string;
  userWords?: string;
};

// The "Agent feedback" API survey in the Framelink MCP PostHog project. Its question ids key each
// answer (`$survey_response_<id>`), so a question deleted or recreated there orphans what this sends.
const AGENT_FEEDBACK_SURVEY_ID = "01a17f32-e539-0000-9b79-1ef7b4047015";
const AGENT_FEEDBACK_QUESTION_IDS = {
  kind: "2b6dbca0-18a6-453b-adf4-3794b972d6b7",
  summary: "fc148ead-14f8-403c-804f-12fb25bc7d50",
  attempted: "c6c3336f-de99-48c7-898e-2bb706155170",
  tool: "5d9c0d8c-4ff8-4df6-b185-588dc32d55dc",
  expected: "ad8fd283-4f55-44cd-8989-2000d358eb1a",
  actual: "1d151e1e-84ce-4de6-8a70-4e58982c5f49",
  workaround: "07b49fa9-add0-4abb-8b35-8d4e22b0edfe",
  gist: "5e89009a-7e19-4bef-8a73-1ea1a25b1d90",
  userWords: "7a5512bf-4758-4950-ab56-3be18cf006d2",
} as const satisfies Record<keyof IssueReport, string>;

/**
 * Send one report to PostHog, where it sits beside the session's `$mcp_tool_call` events. A
 * capability gap goes out as MCP Analytics' own `$mcp_missing_capability`, which its Missing
 * capabilities view reads from `$mcp_intent`; a bug or friction goes out as an Agent feedback
 * survey response. Strings are scrubbed like every telemetry string.
 */
export function sendIssueReport(
  report: IssueReport,
  context: ToolCallContext,
): Promise<ConfirmedSend> {
  const client = {
    $mcp_client_name: context.clientInfo?.name,
    $mcp_client_version: context.clientInfo?.version,
    transport: context.transport,
  };
  if (report.kind === "missing_capability")
    return sendEventConfirmed("$mcp_missing_capability", {
      ...client,
      $mcp_intent: missingCapabilityText(report),
      $mcp_tool_name: report.tool,
    });

  const responses: Record<string, string> = {};
  for (const [field, questionId] of Object.entries(AGENT_FEEDBACK_QUESTION_IDS)) {
    const answer = report[field as keyof IssueReport];
    if (answer !== undefined) responses[`$survey_response_${questionId}`] = answer;
  }
  return sendEventConfirmed("survey sent", {
    ...client,
    $survey_id: AGENT_FEEDBACK_SURVEY_ID,
    ...responses,
  });
}

// The Missing capabilities view shows one text per report, so the structured fields fold into it.
function missingCapabilityText(report: IssueReport): string {
  return [
    report.summary,
    `Attempted: ${report.attempted}`,
    report.expected && `Expected: ${report.expected}`,
    report.actual && `Actual: ${report.actual}`,
    report.workaround && `Workaround: ${report.workaround}`,
    report.gist && `Gist: ${report.gist}`,
    report.userWords && `User said: ${report.userWords}`,
  ]
    .filter(Boolean)
    .join("\n");
}

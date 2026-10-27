// report_framelink_issue: an agent tells Framelink what broke or what was missing, as it happens.
// Registered only while telemetry is on: a report IS a telemetry event, sent to the same PostHog
// project under the same consent. Never part of the embeddable read entry.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ISSUE_REPORT_KINDS,
  sendIssueReport,
  type ConfirmedSend,
  type IssueReport,
  type ToolCallContext,
} from "~/telemetry/index.js";
import { registerFramelinkTool, type ObserveToolCall } from "./framelink-tool.js";

export const REPORT_FRAMELINK_ISSUE_TOOL = "report_framelink_issue";

const reportIssueParameters = {
  kind: z
    .enum(ISSUE_REPORT_KINDS)
    .describe(
      "bug: a Framelink tool failed or returned something wrong. missing_capability: the task " +
        "needs something no Framelink tool offers. friction: it worked, but only after a detour " +
        "the tools or their docs should have spared you.",
    ),
  summary: z.string().min(1).max(200).describe("One line naming the problem."),
  attempted: z
    .string()
    .min(1)
    .max(4000)
    .describe("What the user wanted, and what you did toward it with Framelink's tools."),
  tool: z.string().max(100).optional().describe("The Framelink tool involved, if one was."),
  expected: z.string().max(4000).optional().describe("What you expected to happen."),
  actual: z
    .string()
    .max(4000)
    .optional()
    .describe("What happened instead, with any error text verbatim."),
  workaround: z.string().max(4000).optional().describe("How you got past it, if you did."),
  gist: z
    .string()
    .max(8000)
    .optional()
    .describe(
      "The shape of the failing call, written from what you already sent: for " +
        "figma_execute_code, the script with layer names, text content and ids replaced by " +
        'placeholders like "<frame>". Don\'t re-run anything or inspect the file to produce it.',
    ),
  userWords: z
    .string()
    .max(2000)
    .optional()
    .describe("What the user said about it, quoted, if they said anything."),
};

export const reportIssueParametersSchema = z.object(reportIssueParameters);

const REPORT_ISSUE_DESCRIPTION =
  "Report a problem with Framelink itself to the Framelink team, who read every report and fix " +
  "what they can. Call it when a Framelink tool fails unexpectedly or returns something wrong, " +
  "when the task needs a capability no Framelink tool has, or when you needed a workaround the " +
  "tools or their docs should have made unnecessary. Don't report expected errors you can fix " +
  "yourself (a bad argument, a missing token), a retry that then worked, or problems outside " +
  "Framelink. One report per distinct problem, filed once. Never include secrets, personal " +
  "details or design content; describe the design with placeholders. Sends without asking the " +
  "user; tell them afterwards that you reported it.";

// Enough for every distinct problem one agent session should hit; past it, a loop is reporting.
const MAX_REPORTS_PER_PROCESS = 5;
let reportsSent = 0;

/** Sends one report under the per-process cap, and words the outcome for an agent or a shell. */
export async function reportFramelinkIssue(
  report: IssueReport,
  context: ToolCallContext,
): Promise<{ delivery: ConfirmedSend | { kind: "capped" }; text: string }> {
  if (reportsSent >= MAX_REPORTS_PER_PROCESS)
    return {
      delivery: { kind: "capped" },
      text: `Not sent: this server has already sent ${MAX_REPORTS_PER_PROCESS} reports, its limit per run.`,
    };
  const delivery = await sendIssueReport(report, context);
  switch (delivery.kind) {
    case "sent":
      reportsSent++;
      return { delivery, text: "Reported to the Framelink team. Thanks." };
    case "off":
      return {
        delivery,
        text: "Not sent: usage telemetry is off, and reports go out as telemetry.",
      };
    case "failed":
      return {
        delivery,
        text: `Not sent: the report couldn't reach Framelink (${delivery.reason}).`,
      };
  }
}

type ReportIssueFacts = { kind: IssueReport["kind"]; delivery: string };

export function registerReportIssueTool(
  server: McpServer,
  context: ToolCallContext,
  observe: ObserveToolCall<typeof REPORT_FRAMELINK_ISSUE_TOOL, ReportIssueFacts>,
): void {
  registerFramelinkTool<
    typeof REPORT_FRAMELINK_ISSUE_TOOL,
    typeof reportIssueParameters,
    ReportIssueFacts
  >(
    server,
    {
      name: REPORT_FRAMELINK_ISSUE_TOOL,
      title: "Report Framelink Issue",
      description: REPORT_ISSUE_DESCRIPTION,
      inputSchema: reportIssueParameters,
      unknownParams: "fail-loud",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      handler: async (params, call) => {
        const { delivery, text } = await reportFramelinkIssue(params, context);
        call.record({ kind: params.kind, delivery: delivery.kind });
        return { content: [{ type: "text", text }], isError: delivery.kind !== "sent" };
      },
    },
    observe,
  );
}

/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { randomUUID } from "node:crypto";
import type { ExecuteCodeResult, PendingApprovalReply } from "@framelink/plugin/protocol";
import type { PluginBridgeRuntime } from "./index.js";
import { BridgeRequestError, type ChannelRunContext } from "./bridge.js";
import { requestUntilApproved, isPendingApproval } from "./await-approval.js";
import type { ApprovedSession } from "./approval-session.js";
import { flcmSandboxPreamble } from "./sandbox-preamble.js";
import { uploadHandlesNamedIn } from "./image-intake.js";
import { LATE_CHANGE_WINDOW_MS } from "../entitlement/write-access.js";
import {
  writeRefusalText,
  type WriteAuthorization,
  type WriteRefusal,
} from "../entitlement/write-authorization.js";

// A script executes exactly once — images arrive mid-run (PluginBridge.serveChannelRequest) — and
// its reply is the whole story. `documentChanged` is the server's to meter, never the agent's to
// read, so it never reaches the tool result.

export type ApprovalOptions = NonNullable<Parameters<typeof requestUntilApproved>[2]>;
export type ExecutionOutcome =
  | {
      kind: "executed";
      reply: Omit<ExecuteCodeResult, "type" | "documentChanged">;
      settlementRunId: string | null;
    }
  | { kind: "pending" }
  | { kind: "refused"; message: string };

/** Shared MCP/CLI submission and accounting boundary. Approval polls never submit code. */
export async function executePluginCode(
  { bridge, writeAccess }: Pick<PluginBridgeRuntime, "bridge" | "writeAccess">,
  code: string,
  options?: ApprovalOptions,
  { figma }: Pick<ChannelRunContext, "figma"> = { figma: null },
): Promise<ExecutionOutcome> {
  // The upload grant comes from the code as submitted here, by the trusted caller — never from the
  // plugin, which executes the code and so could otherwise name any handle it has seen.
  const runContext: ChannelRunContext = { figma, uploadHandles: uploadHandlesNamedIn(code) };
  const executionId = randomUUID();
  // What the granting poll admitted, and what was decided under it: one session from admission to
  // attribution to the TTL slide, never re-read from the bridge.
  const gate: {
    session: ApprovedSession | null;
    authorization: WriteAuthorization | null;
    runId: string | null;
  } = { session: null, authorization: null, runId: null };
  try {
    let raw:
      | { kind: "refused"; refusal: WriteRefusal }
      | { kind: "replied"; reply: ExecuteCodeResult }
      | PendingApprovalReply;
    try {
      raw = await requestUntilApproved(
        (signal) => bridge.approvalStatus(signal),
        async (signal, session) => {
          gate.session = session;
          gate.authorization = await writeAccess.authorizeWriteExecution(
            session?.authorizingUser ?? null,
            executionId,
          );
          if (gate.authorization.kind === "refused")
            return { kind: "refused", refusal: gate.authorization };
          const reply = await bridge.request(
            {
              type: "EXECUTE_CODE",
              code,
              preamble: flcmSandboxPreamble(),
              lateChangeWindowMs: LATE_CHANGE_WINDOW_MS,
            },
            signal,
            (runId) => {
              gate.runId = runId;
              writeAccess.trackLateRun(executionId, runId);
            },
            runContext,
          );
          // The plugin gates consent again on the submit itself, so it too may answer PENDING_APPROVAL.
          return isPendingApproval(reply) ? reply : { kind: "replied", reply };
        },
        options,
      );
    } catch (error) {
      if (
        gate.authorization &&
        error instanceof BridgeRequestError &&
        error.outcome === "unconfirmed" &&
        error.phase !== "queued"
      )
        writeAccess.recordWriteExecution(gate.authorization, executionId);
      throw error;
    }
    if (isPendingApproval(raw)) return { kind: "pending" };
    if (raw.kind === "refused")
      return {
        kind: "refused",
        message: writeRefusalText(raw.refusal, writeAccess.framelinkApiUrl),
      };
    const { documentChanged, console, errors } = raw.reply;
    // `result` stays absent when the run returned nothing: undefined isn't JSON.
    const reply =
      "result" in raw.reply ? { result: raw.reply.result, console, errors } : { console, errors };
    if (documentChanged && gate.authorization)
      writeAccess.recordWriteExecution(gate.authorization, executionId);
    if (gate.session) bridge.touchApproval(gate.session);
    return {
      kind: "executed",
      reply,
      settlementRunId:
        !documentChanged &&
        gate.authorization?.kind === "authorized" &&
        gate.authorization.via === "allowance"
          ? gate.runId
          : null,
    };
  } finally {
    writeAccess.releaseWriteExecution(executionId);
  }
}

export async function capturePluginScreenshot(
  bridge: PluginBridgeRuntime["bridge"],
  target: { nodeId?: string; key?: string; scale?: number; context?: boolean; margin?: number },
  options?: ApprovalOptions,
) {
  const raw = await requestUntilApproved(
    (signal) => bridge.approvalStatus(signal),
    (signal) => bridge.request({ type: "SCREENSHOT", ...target }, signal),
    options,
  );
  if (isPendingApproval(raw)) return { kind: "pending" as const };
  return { kind: "captured" as const, reply: raw };
}

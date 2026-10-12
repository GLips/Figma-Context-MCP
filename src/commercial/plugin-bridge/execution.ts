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
import { LATE_CHANGE_WINDOW_MS, type ExecutionCharge } from "../entitlement/write-meter.js";
import { writeRefusalText, type WriteRefusal } from "../entitlement/write-authorization.js";

// A script executes exactly once — images arrive mid-run (PluginBridge.serveChannelRequest) — and
// its reply is the whole story. `documentChanged` is the server's to meter, never the agent's to
// read, so it never reaches the tool result.

export type ApprovalOptions = NonNullable<Parameters<typeof requestUntilApproved>[2]>;
export type ExecutionOutcome =
  | {
      kind: "executed";
      reply: Omit<ExecuteCodeResult, "type" | "documentChanged">;
      /** The Allow that admitted the run — who it is attributed to. */
      session: ApprovedSession | null;
    }
  | { kind: "pending" }
  | { kind: "refused"; refusal: WriteRefusal; message: string };

/** Shared MCP/CLI submission and accounting boundary. Approval polls never submit code. */
export async function executePluginCode(
  { bridge, writeMeter }: Pick<PluginBridgeRuntime, "bridge" | "writeMeter">,
  code: string,
  options?: ApprovalOptions,
  { figma }: Pick<ChannelRunContext, "figma"> = { figma: null },
): Promise<ExecutionOutcome> {
  // The upload grant comes from the code as submitted here, by the trusted caller — never from the
  // plugin, which executes the code and so could otherwise name any handle it has seen.
  const runContext: ChannelRunContext = { figma, uploadHandles: uploadHandlesNamedIn(code) };
  const executionId = randomUUID();
  // What the granting poll admitted, and the charge decided under it: one session from admission
  // to attribution to the TTL slide, never re-read from the bridge.
  const gate: { session: ApprovedSession | null; charge: ExecutionCharge | null } = {
    session: null,
    charge: null,
  };
  let raw:
    | { kind: "refused"; refusal: WriteRefusal }
    | { kind: "replied"; reply: ExecuteCodeResult }
    | PendingApprovalReply;
  try {
    raw = await requestUntilApproved(
      (signal) => bridge.approvalStatus(signal),
      async (signal, session) => {
        gate.session = session;
        const admission = await writeMeter.authorize(session?.authorizingUser ?? null, executionId);
        if (admission.kind === "refused") return admission;
        const charge = (gate.charge = admission.charge);
        const reply = await bridge.request(
          {
            type: "EXECUTE_CODE",
            code,
            preamble: flcmSandboxPreamble(),
            lateChangeWindowMs: LATE_CHANGE_WINDOW_MS,
          },
          signal,
          (runId) => charge.submitted(runId),
          runContext,
        );
        // The plugin gates consent again on the submit itself, so it too may answer PENDING_APPROVAL.
        return isPendingApproval(reply) ? reply : { kind: "replied", reply };
      },
      options,
    );
  } catch (error) {
    gate.charge?.lost({ mayHaveRun: mayHaveRun(error) });
    throw error;
  }
  if (isPendingApproval(raw)) {
    gate.charge?.lost({ mayHaveRun: false });
    return { kind: "pending" };
  }
  if (raw.kind === "refused")
    return {
      kind: "refused",
      refusal: raw.refusal,
      message: writeRefusalText(raw.refusal, writeMeter.framelinkApiUrl),
    };
  const { documentChanged, console, errors } = raw.reply;
  gate.charge?.replied(documentChanged);
  if (gate.session) bridge.touchApproval(gate.session);
  // `result` stays absent when the run returned nothing: undefined isn't JSON.
  const reply =
    "result" in raw.reply ? { result: raw.reply.result, console, errors } : { console, errors };
  return { kind: "executed", reply, session: gate.session };
}

/** A failed submission may have touched the document unless the bridge proved it never started. */
function mayHaveRun(error: unknown): boolean {
  return (
    error instanceof BridgeRequestError &&
    error.outcome === "unconfirmed" &&
    error.phase !== "queued"
  );
}

export async function capturePluginScreenshot(
  bridge: PluginBridgeRuntime["bridge"],
  target: { nodeId?: string; key?: string; scale?: number; context?: boolean; margin?: number },
  options?: ApprovalOptions,
) {
  let admitted: ApprovedSession | null = null;
  const raw = await requestUntilApproved(
    (signal) => bridge.approvalStatus(signal),
    (signal, session) => {
      admitted = session;
      return bridge.request({ type: "SCREENSHOT", ...target }, signal);
    },
    options,
  );
  if (isPendingApproval(raw)) return { kind: "pending" as const };
  return { kind: "captured" as const, reply: raw, session: admitted as ApprovedSession | null };
}

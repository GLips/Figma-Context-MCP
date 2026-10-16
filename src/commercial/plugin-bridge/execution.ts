/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { randomUUID } from "node:crypto";
import type { ExecuteCodeResult } from "@framelink/plugin/protocol";
import type { PluginBridgeRuntime } from "./index.js";
import { BridgeRequestError, type ChannelRunContext, type PluginLink } from "./bridge.js";
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
      /** The Allow that admitted the run, whose approval it keeps fresh. */
      session: ApprovedSession | null;
    }
  | { kind: "pending" }
  | { kind: "refused"; refusal: WriteRefusal; message: string };

/** Shared MCP/CLI submission and accounting boundary. Approval polls never submit code. */
export async function executePluginCode(
  {
    bridge,
    writeMeter,
    readLocalImage,
  }: Pick<PluginBridgeRuntime, "bridge" | "writeMeter" | "readLocalImage">,
  link: PluginLink,
  code: string,
  options?: ApprovalOptions,
  { figma }: Pick<ChannelRunContext, "figma"> = { figma: null },
): Promise<ExecutionOutcome> {
  // The upload grant comes from the code as submitted here, by the trusted caller — never from the
  // plugin, which executes the code and so could otherwise name any handle it has seen.
  const runContext: ChannelRunContext = {
    figma,
    uploadHandles: uploadHandlesNamedIn(code),
    readLocalImage,
  };
  const executionId = randomUUID();
  // The charge decided at submit, held in an object because TS can't see the closure assign it. The
  // run is metered to the link's owner — the Figma user the authenticated plugin is signed in as.
  const gate: { charge: ExecutionCharge | null } = { charge: null };
  async function submitUnderApproval(signal: AbortSignal) {
    const admission = await writeMeter.authorize(link.owner, executionId);
    if (admission.kind === "refused") return admission;
    const charge = (gate.charge = admission.charge);
    const reply = await bridge.request(
      link,
      {
        type: "EXECUTE_CODE",
        code,
        preamble: flcmSandboxPreamble(),
        lateChangeWindowMs: LATE_CHANGE_WINDOW_MS,
      },
      { signal, onSubmitted: (runId) => charge.submitted(runId), runContext },
    );
    // The plugin gates consent again on the submit itself, so it too may answer PENDING_APPROVAL.
    return isPendingApproval(reply) ? reply : { kind: "replied" as const, reply };
  }
  const waited = await requestUntilApproved(
    (signal) => bridge.approvalStatus(link, signal),
    submitUnderApproval,
    options,
  ).catch((error: unknown) => {
    gate.charge?.lost({ mayHaveRun: mayHaveRun(error) });
    throw error;
  });
  if (isPendingApproval(waited) || isPendingApproval(waited.result)) {
    gate.charge?.lost({ mayHaveRun: false });
    return { kind: "pending" };
  }
  const { session, result } = waited;
  if (result.kind === "refused")
    return {
      kind: "refused",
      refusal: result.refusal,
      message: writeRefusalText(result.refusal, writeMeter.framelinkApiUrl),
    };
  const { documentChanged, console, errors } = result.reply;
  gate.charge?.replied(documentChanged);
  if (session) bridge.touchApproval(session);
  // `result` stays absent when the run returned nothing: undefined isn't JSON.
  const reply =
    "result" in result.reply
      ? { result: result.reply.result, console, errors }
      : { console, errors };
  return { kind: "executed", reply, session };
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
  link: PluginLink,
  target: { nodeId?: string; key?: string; scale?: number; context?: boolean; margin?: number },
  options?: ApprovalOptions,
) {
  const waited = await requestUntilApproved(
    (signal) => bridge.approvalStatus(link, signal),
    (signal) => bridge.request(link, { type: "SCREENSHOT", ...target }, { signal }),
    options,
  );
  // As with code, the plugin gates the capture itself and may still answer PENDING_APPROVAL.
  if (isPendingApproval(waited) || isPendingApproval(waited.result))
    return { kind: "pending" as const };
  return { kind: "captured" as const, reply: waited.result, session: waited.session };
}

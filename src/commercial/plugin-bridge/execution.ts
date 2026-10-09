/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PluginBridgeRuntime } from "./index.js";
import { BridgeRequestError, type ChannelRunContext } from "./bridge.js";
import { requestUntilApproved, isPendingApproval } from "./await-approval.js";
import { flcmSandboxPreamble } from "./sandbox-preamble.js";
import { writeRefusalText, type WriteAuthorization } from "../entitlement/write-authorization.js";

// The plugin always replies to EXECUTE_CODE with this exact shape; parse it once so the handler
// trusts the type instead of re-checking each field. `result` is absent when the code returns
// nothing or throws: undefined isn't JSON, so it's dropped crossing the WS — optional, not
// required (a missing key is the error/void path). Since protocol 2, images are fetched MID-RUN
// (PluginBridge.serveChannelRequest), so a script executes exactly once and this reply is the
// whole story — no re-run signals, no second pass.
//
// `documentChanged` is whether the document changed while the run executed — raw figma.* writes
// included, and writes that landed after the agent's code returned. True is one Write against the
// free allowance. False is provisional: a change Figma reports later arrives as RUN_CHANGED. It is
// the server's to read, not the agent's, so it never reaches the tool result.
const ExecuteCodeReply = z.object({
  result: z.unknown().optional(),
  console: z.array(z.string()),
  errors: z.string().nullable(),
  documentChanged: z.boolean(),
});

// The sandbox posts exactly one of these (see screenshot() in code.ts): `image`
// (base64 PNG) on success, `errors` on the failure path — never both, never neither.
const ScreenshotReply = z.union([
  z.object({ image: z.string(), capture: z.literal("contextual").optional() }),
  z.object({ errors: z.string() }),
]);

export type ApprovalOptions = NonNullable<Parameters<typeof requestUntilApproved>[2]>;
export type ExecutionOutcome =
  | {
      kind: "executed";
      reply: Omit<z.infer<typeof ExecuteCodeReply>, "documentChanged">;
      settlementRunId: string | null;
    }
  | { kind: "pending" }
  | { kind: "refused"; message: string };

/** Shared MCP/CLI submission and accounting boundary. Approval polls never submit code. */
export async function executePluginCode(
  { bridge, writeAccess }: Pick<PluginBridgeRuntime, "bridge" | "writeAccess">,
  code: string,
  options?: ApprovalOptions,
  runContext?: ChannelRunContext,
): Promise<ExecutionOutcome> {
  const executionId = randomUUID();
  const gate: { authorization: WriteAuthorization | null; runId: string | null } = {
    authorization: null,
    runId: null,
  };
  try {
    let raw: unknown;
    try {
      raw = await requestUntilApproved(
        (signal) => bridge.request({ type: "APPROVAL_STATUS" }, signal),
        async (signal) => {
          gate.authorization = await writeAccess.authorizeWriteExecution(
            bridge.getAuthorizingUser(),
            executionId,
          );
          if (gate.authorization.kind === "refused") return null;
          return bridge.request(
            { type: "EXECUTE_CODE", code, preamble: flcmSandboxPreamble() },
            signal,
            (runId) => {
              gate.runId = runId;
            },
            runContext,
          );
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
    if (gate.authorization?.kind === "refused")
      return {
        kind: "refused",
        message: writeRefusalText(gate.authorization, writeAccess.framelinkApiUrl),
      };
    if (isPendingApproval(raw)) return { kind: "pending" };
    const { documentChanged, ...reply } = ExecuteCodeReply.parse(raw);
    if (documentChanged && gate.authorization)
      writeAccess.recordWriteExecution(gate.authorization, executionId);
    bridge.touchApproval();
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
    writeAccess.releaseWriteExecution(executionId, gate.runId);
  }
}

export async function capturePluginScreenshot(
  bridge: PluginBridgeRuntime["bridge"],
  target: { nodeId?: string; key?: string; scale?: number; context?: boolean; margin?: number },
  options?: ApprovalOptions,
) {
  const raw = await requestUntilApproved(
    (signal) => bridge.request({ type: "APPROVAL_STATUS" }, signal),
    (signal) => bridge.request({ type: "SCREENSHOT", ...target }, signal),
    options,
  );
  if (isPendingApproval(raw)) return { kind: "pending" as const };
  return { kind: "captured" as const, reply: ScreenshotReply.parse(raw) };
}

/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import type { ApprovalStatusReply } from "@framelink/plugin/protocol";
import { approvalGuidance, type ApprovalGuidanceState } from "./blocked-call-guidance.js";

/**
 * The note get_flcm_reference leads with: one bounded, read-only status lookup. Reference delivery
 * never enters the human approval wait and never submits code.
 */
export async function referenceSessionGuidance({
  pairingCode,
  protocolRefusal,
  status,
  timeoutMs = 1500,
}: {
  pairingCode: string | null;
  protocolRefusal: string | null;
  status: (signal: AbortSignal) => Promise<ApprovalStatusReply>;
  timeoutMs?: number;
}): Promise<string | undefined> {
  const state = await referenceState({ pairingCode, protocolRefusal, status, timeoutMs });
  return state ? approvalGuidance(state, "reference") : undefined;
}

async function referenceState({
  pairingCode,
  protocolRefusal,
  status,
  timeoutMs,
}: {
  pairingCode: string | null;
  protocolRefusal: string | null;
  status: (signal: AbortSignal) => Promise<ApprovalStatusReply>;
  timeoutMs: number;
}): Promise<ApprovalGuidanceState | null> {
  if (protocolRefusal) return { kind: "incompatible", refusal: protocolRefusal };
  if (!pairingCode) return { kind: "disconnected", elapsedMs: null };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([
      status(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Approval status timed out"));
        }, timeoutMs);
      }),
    ]);
    if (reply.type === "APPROVAL_GRANTED") return null;
    if (reply.type === "APPROVAL_REJECTED") return { kind: "rejected", pairingCode };
    return { kind: "pending", pairingCode };
  } catch {
    return { kind: "status-unknown" };
  } finally {
    clearTimeout(timer);
  }
}

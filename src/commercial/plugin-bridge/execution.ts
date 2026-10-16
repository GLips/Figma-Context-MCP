/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import type {
  ExecuteCodeResult,
  NotGrantedReason,
  ScreenshotResult,
} from "@framelink/plugin/protocol";
import type { PluginBridgeRuntime } from "./index.js";
import {
  BridgeRequestError,
  type CallDocument,
  type ChannelRunContext,
  type PluginLink,
} from "./bridge.js";
import type { ExecutionId } from "~/commercial/execution-id.js";
import { flcmSandboxPreamble } from "./sandbox-preamble.js";
import { mintSessionHandle, type SessionHandle } from "./session-handle.js";
import { uploadHandlesNamedIn } from "./image-intake.js";
import { LATE_CHANGE_WINDOW_MS } from "../entitlement/write-meter.js";
import { writeRefusalText, type WriteRefusal } from "../entitlement/write-authorization.js";

// A script executes exactly once — images arrive mid-run (PluginBridge.serveChannelRequest) — and
// its reply is the whole story. `documentChanged` is the server's to meter, never the agent's to
// read, so it never reaches the tool result.

/**
 * Where a call runs: the document it was bound to, the link that is in it, the session the call
 * named (null: the run gets a fresh one), and the execution id it was targeted and will run under.
 */
export interface PluginCallTarget {
  executionId: ExecutionId;
  link: PluginLink;
  document: CallDocument;
  session: SessionHandle | null;
}

export type ExecutionOutcome =
  | {
      kind: "executed";
      reply: Omit<ExecuteCodeResult, "type" | "documentChanged">;
      /** The session the run used, for the agent to pass back. */
      session: SessionHandle;
    }
  | { kind: "not-granted"; reason: NotGrantedReason }
  // The plugin no longer holds the named session: it closed, or evicted it, since the call was bound.
  | { kind: "session-not-found"; session: SessionHandle }
  | { kind: "refused"; refusal: WriteRefusal; message: string };

/**
 * A run's reply lost after the plugin may have admitted it, naming the session it was admitted
 * under: a fresh one exists nowhere else, and its session.last is how the agent learns what ran.
 */
export class ExecutionReplyLostError extends BridgeRequestError {
  constructor(
    lost: BridgeRequestError,
    readonly session: SessionHandle,
  ) {
    super(
      `${lost.message} The run was submitted in session ${session}: continue that session to read ` +
        `its session.last and see what the run did.`,
      lost.outcome,
      lost.phase,
    );
    this.name = "ExecutionReplyLostError";
  }
}

// A freshly minted handle collides with one the plugin holds about once in 2^44 mints; a few retries
// are already beyond any real collision, so running out means a plugin that refuses every handle.
const SESSION_MINT_ATTEMPTS = 4;

/**
 * Shared MCP/CLI submission and accounting boundary: one call is one execution, under one execution
 * id, metered to the link's owner. The call was bound to its document and grant before this; the
 * plugin checks the grant again on arrival and may still refuse.
 */
export async function executePluginCode(
  {
    bridge,
    writeMeter,
    readLocalImage,
  }: Pick<PluginBridgeRuntime, "bridge" | "writeMeter" | "readLocalImage">,
  { executionId, link, document, session: namedSession }: PluginCallTarget,
  code: string,
  { figma, signal }: Pick<ChannelRunContext, "figma"> & { signal?: AbortSignal } = { figma: null },
): Promise<ExecutionOutcome> {
  // The upload grant comes from the code as submitted here, by the trusted caller — never from the
  // plugin, which executes the code and so could otherwise name any handle it has seen.
  const runContext: ChannelRunContext = {
    figma,
    fileKey: document.fileKey,
    uploadHandles: uploadHandlesNamedIn(code),
    readLocalImage,
  };
  const admission = await writeMeter.authorize(link, executionId);
  if (admission.kind === "refused")
    return {
      kind: "refused",
      refusal: admission.refusal,
      message: writeRefusalText(admission.refusal, writeMeter.framelinkApiUrl),
    };
  const { charge } = admission;
  // A taken handle is refused before the plugin admits the run, so resubmitting this execution id
  // with a fresh handle never runs the code twice. Every other refusal is final: NOT_GRANTED can
  // arrive after the plugin queued the run.
  for (let attempt = 1; ; attempt++) {
    const session = namedSession
      ? { handle: namedSession, create: false }
      : { handle: mintSessionHandle(), create: true };
    const reply = await bridge
      .submitRun(
        link,
        {
          type: "EXECUTE_CODE",
          code,
          documentId: document.documentId,
          session,
          preamble: flcmSandboxPreamble(),
          lateChangeWindowMs: LATE_CHANGE_WINDOW_MS,
        },
        executionId,
        { signal, runContext },
      )
      .catch((error: unknown) => {
        charge.lost({ mayHaveRun: mayHaveRun(error) });
        if (error instanceof BridgeRequestError && error.outcome === "unconfirmed")
          throw new ExecutionReplyLostError(error, session.handle);
        throw error;
      });
    if (reply.type === "EXECUTE_CODE_RESULT") {
      const { documentChanged, console, errors } = reply;
      charge.replied(documentChanged);
      // `result` stays absent when the run returned nothing: undefined isn't JSON.
      return {
        kind: "executed",
        reply: "result" in reply ? { result: reply.result, console, errors } : { console, errors },
        session: session.handle,
      };
    }
    if (reply.type === "SESSION_HANDLE_TAKEN" && attempt < SESSION_MINT_ATTEMPTS) continue;
    charge.lost({ mayHaveRun: false });
    if (reply.type === "NOT_GRANTED") return { kind: "not-granted", reason: reply.reason };
    if (reply.type === "SESSION_NOT_FOUND")
      return { kind: "session-not-found", session: session.handle };
    throw new Error(
      `The Figma plugin refused ${SESSION_MINT_ATTEMPTS} fresh session handles in a row as already taken, so nothing ran. Reopen the Framelink plugin, then retry.`,
    );
  }
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
  { executionId, link, document }: PluginCallTarget,
  target: { nodeId?: string; key?: string; scale?: number; context?: boolean; margin?: number },
  signal?: AbortSignal,
): Promise<
  { kind: "captured"; reply: ScreenshotResult } | { kind: "not-granted"; reason: NotGrantedReason }
> {
  const reply = await bridge.submitRun(
    link,
    { type: "SCREENSHOT", documentId: document.documentId, ...target },
    executionId,
    { signal },
  );
  return reply.type === "NOT_GRANTED"
    ? { kind: "not-granted", reason: reply.reason }
    : { kind: "captured", reply };
}

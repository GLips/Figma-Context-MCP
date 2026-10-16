/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { randomUUID } from "node:crypto";
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
import { flcmSandboxPreamble } from "./sandbox-preamble.js";
import { mintSessionHandle, type SessionHandle } from "./session-handle.js";
import { uploadHandlesNamedIn } from "./image-intake.js";
import { LATE_CHANGE_WINDOW_MS } from "../entitlement/write-meter.js";
import { writeRefusalText, type WriteRefusal } from "../entitlement/write-authorization.js";

// A script executes exactly once — images arrive mid-run (PluginBridge.serveChannelRequest) — and
// its reply is the whole story. `documentChanged` is the server's to meter, never the agent's to
// read, so it never reaches the tool result.

/**
 * Where a call runs: the document it was bound to, the link that is in it, and the session the call
 * named (null: the run gets a fresh one).
 */
export interface PluginCallTarget {
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

// A freshly minted handle collides with one the plugin holds about once in 2^44 mints; a few retries
// are already beyond any real collision, so running out means a plugin that refuses every handle.
const SESSION_MINT_ATTEMPTS = 4;

/**
 * Shared MCP/CLI submission and accounting boundary. The call was bound to its document and grant
 * before this; the plugin checks the grant again on arrival and may still refuse.
 */
export async function executePluginCode(
  runtime: Pick<PluginBridgeRuntime, "bridge" | "writeMeter" | "readLocalImage">,
  target: PluginCallTarget,
  code: string,
  context: Pick<ChannelRunContext, "figma"> & { signal?: AbortSignal } = { figma: null },
): Promise<ExecutionOutcome> {
  // A taken handle is refused before the plugin admits the run, so minting another and resubmitting
  // never runs the code twice.
  for (let attempt = 1; ; attempt++) {
    const session = target.session
      ? { handle: target.session, create: false }
      : { handle: mintSessionHandle(), create: true };
    const outcome = await submitPluginCode(runtime, target, code, session, context);
    if (outcome !== "handle-taken") return outcome;
    if (attempt === SESSION_MINT_ATTEMPTS)
      throw new Error(
        `The Figma plugin refused ${SESSION_MINT_ATTEMPTS} fresh session handles in a row as already taken, so nothing ran. Reopen the Framelink plugin, then retry.`,
      );
  }
}

async function submitPluginCode(
  {
    bridge,
    writeMeter,
    readLocalImage,
  }: Pick<PluginBridgeRuntime, "bridge" | "writeMeter" | "readLocalImage">,
  { link, document }: PluginCallTarget,
  code: string,
  session: { handle: SessionHandle; create: boolean },
  { figma, signal }: Pick<ChannelRunContext, "figma"> & { signal?: AbortSignal },
): Promise<ExecutionOutcome | "handle-taken"> {
  // The upload grant comes from the code as submitted here, by the trusted caller — never from the
  // plugin, which executes the code and so could otherwise name any handle it has seen.
  const runContext: ChannelRunContext = {
    figma,
    fileKey: document.fileKey,
    uploadHandles: uploadHandlesNamedIn(code),
    readLocalImage,
  };
  // The run is metered to the link's owner — the Figma user the authenticated plugin is signed in as.
  const admission = await writeMeter.authorize(link.owner, randomUUID());
  if (admission.kind === "refused")
    return {
      kind: "refused",
      refusal: admission.refusal,
      message: writeRefusalText(admission.refusal, writeMeter.framelinkApiUrl),
    };
  const { charge } = admission;
  const reply = await bridge
    .request(
      link,
      {
        type: "EXECUTE_CODE",
        code,
        fileKey: document.fileKey,
        session,
        preamble: flcmSandboxPreamble(),
        lateChangeWindowMs: LATE_CHANGE_WINDOW_MS,
      },
      { signal, onSubmitted: (runId) => charge.submitted(runId), runContext },
    )
    .catch((error: unknown) => {
      charge.lost({ mayHaveRun: mayHaveRun(error) });
      throw error;
    });
  if (reply.type !== "EXECUTE_CODE_RESULT") {
    charge.lost({ mayHaveRun: false });
    if (reply.type === "NOT_GRANTED") return { kind: "not-granted", reason: reply.reason };
    if (reply.type === "SESSION_NOT_FOUND")
      return { kind: "session-not-found", session: session.handle };
    return "handle-taken";
  }
  const { documentChanged, console, errors } = reply;
  charge.replied(documentChanged);
  // `result` stays absent when the run returned nothing: undefined isn't JSON.
  return {
    kind: "executed",
    reply: "result" in reply ? { result: reply.result, console, errors } : { console, errors },
    session: session.handle,
  };
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
  { link, document }: PluginCallTarget,
  target: { nodeId?: string; key?: string; scale?: number; context?: boolean; margin?: number },
  signal?: AbortSignal,
): Promise<
  { kind: "captured"; reply: ScreenshotResult } | { kind: "not-granted"; reason: NotGrantedReason }
> {
  const reply = await bridge.request(
    link,
    { type: "SCREENSHOT", fileKey: document.fileKey, ...target },
    { signal },
  );
  return reply.type === "NOT_GRANTED"
    ? { kind: "not-granted", reason: reply.reason }
    : { kind: "captured", reply };
}

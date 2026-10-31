/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// How an MCP call waits on its plugin run. A client abandons a call at about 60 s, so a call checks
// in before then: a run not yet sent is never sent, a run still queued is withdrawn, and a run under
// way is left running, its outcome handed to the detached-run registry. Nothing here ever cancels a
// run for taking long; only the agent decides that.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ExecutionId } from "~/commercial/execution-id.js";
import type { CallDocument, PluginBridge } from "~/commercial/plugin-bridge/bridge.js";
import { unsubmittedWaitText } from "~/commercial/plugin-bridge/call-wait.js";
import { PLUGIN_ANSWER_MS } from "~/commercial/plugin-bridge/run-ledger.js";
import { runCheckInText } from "~/commercial/plugin-bridge/run-outcome-text.js";
import type { DetachedRunKind, DetachedRunOutcome, RunHandle } from "./detached-runs.js";

/**
 * How long after it started an MCP call answers without its run's reply. Clients give up at about
 * 60 s, and the reply needs the rest: a queued run's withdrawal waits up to PLUGIN_ANSWER_MS.
 */
export const MCP_CHECK_IN_MS = 45_000;

/** A run's end as its tool answers it, with the facts its telemetry records once, at that end. */
export type PluginRunEnd<Facts> = DetachedRunOutcome & { facts: Facts };

/** The reason a run is stopped before it is sent: its call checked in first. */
export const CHECKED_IN_BEFORE_SENDING = Symbol("checked in before sending");

/** One plugin run as an MCP tool holds it: it runs to its end whatever becomes of the call waiting. */
export interface PluginRun<Facts> {
  executionId: ExecutionId;
  kind: DetachedRunKind;
  bridge: PluginBridge;
  document: CallDocument;
  /** When the tool call that started it began: the first check-in counts from here. */
  startedAt: number;
  ended: Promise<PluginRunEnd<Facts>>;
  /** Stop the run from being sent, if it hasn't been. A run already sent is unaffected. */
  preventSending(): void;
  /** Stop the starting call's cancellation from reaching the run: no call waits on it any more. */
  detachCaller(): void;
}

/**
 * Start a run under its own lifetime. The starting call's signal cancels it only until that call
 * detaches; after that only an explicit cancel ends it early. `start` answers every expected failure
 * itself; a rejection of `ended` is a bug.
 */
export function launchPluginRun<Facts>(
  {
    executionId,
    kind,
    bridge,
    document,
    startedAt,
  }: Pick<PluginRun<Facts>, "executionId" | "kind" | "bridge" | "document" | "startedAt">,
  callerSignal: AbortSignal,
  start: (signal: AbortSignal) => Promise<PluginRunEnd<Facts>>,
): PluginRun<Facts> {
  const lifetime = new AbortController();
  const cancelForCaller = () => lifetime.abort(callerSignal.reason);
  // An abort event doesn't replay: a caller already gone must not start a live run.
  if (callerSignal.aborted) cancelForCaller();
  callerSignal.addEventListener("abort", cancelForCaller, { once: true });
  const detachCaller = () => callerSignal.removeEventListener("abort", cancelForCaller);
  const ended = start(lifetime.signal).finally(detachCaller);
  // Whoever waits sees a bug; a call that checked in and left must not make it an unhandled one.
  ended.catch(() => {});
  return {
    executionId,
    kind,
    bridge,
    document,
    startedAt,
    ended,
    preventSending: () => {
      // Only a run not yet in the ledger: aborting a live one would cancel it.
      if (!bridge.runState(executionId)) lifetime.abort(CHECKED_IN_BEFORE_SENDING);
    },
    detachCaller,
  };
}

/** How a wait on a run ended. */
export type PluginRunWait<Facts> =
  | { kind: "ended"; end: PluginRunEnd<Facts> }
  /** The first check-in caught the run before it was sent; it never will be now. */
  | { kind: "never-sent" }
  /** Still under way, or its state unknown: the waiter answers without its reply. */
  | { kind: "checked-in" }
  /** The waiting call itself was cancelled. */
  | { kind: "abandoned" };

/**
 * Wait on `run` until it ends, or until `checkInAt`. At the starting call's check-in (`first`), a run
 * not yet sent is stopped from being sent, and one still queued is withdrawn: either way it never
 * runs, and only the plugin's own `withdrawn` answer says so. Later check-ins only report.
 */
export async function waitOnPluginRun<Facts>(
  run: PluginRun<Facts>,
  { checkInAt, signal, first }: { checkInAt: number; signal: AbortSignal; first: boolean },
): Promise<PluginRunWait<Facts>> {
  // The first check-in starts early enough for the plugin's withdraw answer to land by checkInAt.
  const due = await endedWithin(run, checkInAt - (first ? PLUGIN_ANSWER_MS : 0), signal);
  if (due !== "due") return due;
  const state = run.bridge.runState(run.executionId);
  if (!state) {
    if (first) run.preventSending();
    // Not in the ledger: not yet sent (and now never will be), or its reply is landing.
    const landing = await endedWithin(run, Date.now() + PLUGIN_ANSWER_MS, signal);
    if (landing !== "due") return landing;
    return first ? { kind: "never-sent" } : { kind: "checked-in" };
  }
  if (first && state.phase !== "running") {
    // `withdrawn` rejects the submission synchronously, so `ended` settles with the not-run reply.
    if ((await run.bridge.withdrawRun(run.executionId)) === "withdrawn")
      return { kind: "ended", end: await run.ended };
  }
  return { kind: "checked-in" };
}

/** `ended` if the run ends by `at`, `due` if it doesn't, `abandoned` if the waiter is cancelled. */
async function endedWithin<Facts>(
  run: PluginRun<Facts>,
  at: number,
  signal: AbortSignal,
): Promise<{ kind: "ended"; end: PluginRunEnd<Facts> } | { kind: "abandoned" } | "due"> {
  if (signal.aborted) return { kind: "abandoned" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      run.ended.then((end) => ({ kind: "ended" as const, end })),
      new Promise<"due">((resolve) => {
        timer = setTimeout(() => resolve("due"), Math.max(at - Date.now(), 0));
      }),
      new Promise<{ kind: "abandoned" }>((resolve) => {
        onAbort = () => resolve({ kind: "abandoned" });
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** The reply for a call that checked in before its run was sent: nothing ran. */
export function neverSentReply(
  kind: DetachedRunKind,
  document: CallDocument,
  elapsedMs: number,
): CallToolResult {
  const wait = { kind: "sending", fileName: document.fileName, subject: kind } as const;
  return {
    content: [
      {
        type: "text",
        text: unsubmittedWaitText(wait, { surface: "mcp", elapsedMs, now: Date.now() }),
      },
    ],
  };
}

/**
 * The reply for a run left running when its waiter checked in: where it stands, and the handle to
 * await or cancel it by. `lead` names the file it runs in.
 */
export function checkedInReply<Facts>(
  run: PluginRun<Facts>,
  handle: RunHandle,
  { lead, resultTtlMs }: { lead: string; resultTtlMs: number },
): CallToolResult {
  const now = Date.now();
  const status = runCheckInText({
    payloadType: run.kind === "screenshot" ? "SCREENSHOT" : "EXECUTE_CODE",
    elapsedMs: now - run.startedAt,
    state: run.bridge.runState(run.executionId),
    now,
  });
  return {
    content: [
      {
        type: "text",
        text: [
          lead,
          `${status} It has not been cancelled.`,
          `Run: ${handle} (status: working). Call await_figma_execution with this run to wait ` +
            `for its result, or with cancel: true to stop it. Its result is kept ` +
            `${Math.round(resultTtlMs / 60_000)} minutes after it finishes.`,
        ].join("\n"),
      },
    ],
  };
}

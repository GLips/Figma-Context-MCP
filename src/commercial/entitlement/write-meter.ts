/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// One owner for a Write's settlement lifecycle. The invariant it holds: every allowance-authorized
// execution ends recorded, or released into a late window in which a change the plugin reports later
// is still charged to it — and a short-lived runtime stays up (drain) until every window closes.
//
// Everything is keyed by the execution id the caller minted, which is also the run's id on the wire,
// and pinned to the plugin link the run went out on. Callers see only an ExecutionCharge; the plugin's
// run events arrive through runEvent. Seats get a charge that does nothing — they carry no counters.
import type { PluginOwner, ExecuteCodeResult, WriteAccessNotice } from "@framelink/plugin/protocol";
import type { ExecutionId } from "~/commercial/execution-id.js";
import type { WriteAccess } from "./write-access.js";
import {
  allowanceExhaustedNotice,
  type WriteAuthorization,
  type WriteRefusal,
} from "./write-authorization.js";

/**
 * How long past a "no change" reply the plugin keeps watching the document for a change it would
 * charge to that run. Sent with every EXECUTE_CODE: the plugin obeys it, so it can't drift from here.
 */
export const LATE_CHANGE_WINDOW_MS = 60_000;
// The plugin reports the window's end itself (RUN_SETTLED). This ceiling only covers a socket that
// dropped before it could: the window plus slack for the relay, then the run is settled regardless.
const LATE_DOCUMENT_CHANGE_MS = LATE_CHANGE_WINDOW_MS + 30_000;

/**
 * The plugin link a run was pinned to, as the meter sees it: compared by identity, and charged to its
 * owner. An authenticated link's owner is fixed when it authenticates, so the link alone pins both.
 */
export interface MeteredLink {
  readonly owner: PluginOwner | null;
}

/**
 * What a plugin link says about a run after its caller may have stopped listening. The bridge
 * forwards these as they come, with the link that said them; whether they settle or charge anything
 * is decided here. `orphanReply` is a run's result that arrived after its caller gave up on it.
 */
export type RunEvent =
  | { type: "changed"; executionId: string; link: MeteredLink }
  | { type: "settled"; executionId: string; link: MeteredLink }
  | { type: "orphanReply"; executionId: string; link: MeteredLink; reply: ExecuteCodeResult };

/**
 * What became of one authorized execution, reported by the caller that runs it. End it with replied
 * or lost on every path — an unended allowance charge holds its reservation for good. Only the first
 * end counts.
 */
export interface ExecutionCharge {
  /** The plugin answered. `documentChanged: false` stays provisional until the run settles. */
  replied(documentChanged: boolean): void;
  /** No answer. `mayHaveRun`: the run may have touched the document, so it is charged. */
  lost(outcome: { mayHaveRun: boolean }): void;
}

export type ExecutionAdmission =
  | {
      kind: "authorized";
      authorization: Extract<WriteAuthorization, { kind: "authorized" }>;
      charge: ExecutionCharge;
    }
  | { kind: "refused"; refusal: WriteRefusal };

const SEAT_CHARGE: ExecutionCharge = { replied() {}, lost() {} };

/** An allowance-authorized execution not yet known to be a Write or not. */
interface UnsettledExecution {
  figmaUserId: string;
  link: MeteredLink;
  /**
   * Infinity while the caller still waits on it: a reservation, counted as spent so parallel calls
   * can't all pass the gate on the same last Write. Then the end of its late window.
   */
  lateWindowEndsAt: number;
}

export class WriteMeter {
  private readonly unsettled = new Map<string, UnsettledExecution>();
  private readonly settleWaiters = new Set<() => void>();
  private readonly notifyOwnerPanels: (figmaUserId: string, notice: WriteAccessNotice) => void;
  private readonly now: () => Date;

  constructor(
    private readonly access: WriteAccess,
    {
      notifyOwnerPanels = () => {},
      now = () => new Date(),
    }: {
      /** Show a notice in the panels of the plugin owner it concerns, and no one else's. */
      notifyOwnerPanels?: (figmaUserId: string, notice: WriteAccessNotice) => void;
      now?: () => Date;
    } = {},
  ) {
    this.notifyOwnerPanels = notifyOwnerPanels;
    this.now = now;
  }

  get framelinkApiUrl(): string {
    return this.access.framelinkApiUrl;
  }

  /**
   * May an execution through `link` start? It is attributed to the link's owner, and pinned to the
   * link: only events from it can settle or charge `executionId`. An allowance authorization reserves
   * a Write until its charge ends. Allowance refusals also go to that owner's panels.
   */
  async authorize(link: MeteredLink, executionId: ExecutionId): Promise<ExecutionAdmission> {
    let decision = this.decide(link.owner);
    if (
      decision.kind === "refused" &&
      decision.reason === "allowance-exhausted" &&
      decision.signedIn
    ) {
      await this.access.recheckRefusedSeat(decision.figmaUserId);
      decision = this.decide(link.owner);
    }
    // Synchronous with the decision above, so no other call can decide in between.
    if (decision.kind === "refused") {
      if (decision.reason === "allowance-exhausted")
        this.notifyOwnerPanels(decision.figmaUserId, allowanceExhaustedNotice(decision));
      return { kind: "refused", refusal: decision };
    }
    if (decision.via === "seat")
      return { kind: "authorized", authorization: decision, charge: SEAT_CHARGE };
    this.unsettled.set(executionId, {
      figmaUserId: decision.figmaUserId,
      link,
      lateWindowEndsAt: Infinity,
    });
    return {
      kind: "authorized",
      authorization: decision,
      charge: {
        replied: (documentChanged) => this.callerFinished(executionId, documentChanged),
        lost: ({ mayHaveRun }) => this.callerFinished(executionId, mayHaveRun),
      },
    };
  }

  /**
   * The bridge's one wiring point for the plugin's run events. Heard only from the link the execution
   * was pinned to; any other link naming its id is ignored. Each execution settles once: whatever
   * arrives after that, from the caller or the plugin, changes nothing.
   */
  runEvent(event: RunEvent): void {
    const execution = this.unsettled.get(event.executionId);
    if (!execution || execution.link !== event.link) return;
    if (event.type === "orphanReply" && !event.reply.documentChanged) return;
    // A change seen during the run, after its reply, or after its caller gave up: all one Write.
    this.settle(
      event.executionId,
      event.type !== "settled" && execution.lateWindowEndsAt > this.now().getTime(),
    );
  }

  /**
   * Resolve once every finished execution's late window has closed: RUN_SETTLED, a late change, or
   * the ceiling. A short-lived runtime calls it before stopping, or a late change goes uncharged.
   * Executions still in flight are not waited on — their callers haven't released them yet.
   */
  async drain(signal: AbortSignal, onWaiting?: (remainingMs: number) => void): Promise<void> {
    let announced = false;
    for (;;) {
      signal.throwIfAborted();
      const remaining = this.longestOpenWindowMs();
      if (!remaining) return;
      if (!announced) onWaiting?.(remaining);
      announced = true;
      await this.nextSettlement(remaining, signal);
    }
  }

  private decide(owner: PluginOwner | null): WriteAuthorization {
    const figmaUserId = owner?.figmaUserId;
    let reserved = 0;
    for (const execution of this.unsettled.values())
      if (execution.figmaUserId === figmaUserId && execution.lateWindowEndsAt === Infinity)
        reserved++;
    return this.access.decide(owner, reserved);
  }

  /**
   * The caller is done with the execution. A Write is recorded now; otherwise its reservation ends
   * and the late window opens, for a change the plugin reports after the reply.
   */
  private callerFinished(executionId: ExecutionId, wrote: boolean): void {
    const execution = this.unsettled.get(executionId);
    if (!execution || execution.lateWindowEndsAt !== Infinity) return;
    if (wrote) return this.settle(executionId, true);
    execution.lateWindowEndsAt = this.now().getTime() + LATE_DOCUMENT_CHANGE_MS;
    this.closeExpiredWindows();
  }

  private settle(executionId: string, wrote: boolean): void {
    const execution = this.unsettled.get(executionId);
    if (!execution) return;
    this.unsettled.delete(executionId);
    if (wrote) this.access.recordWrite(execution.figmaUserId, executionId);
    this.closeExpiredWindows();
    this.wakeSettleWaiters();
  }

  private closeExpiredWindows(): void {
    const now = this.now().getTime();
    let closed = false;
    for (const [executionId, execution] of this.unsettled)
      if (execution.lateWindowEndsAt <= now) {
        this.unsettled.delete(executionId);
        closed = true;
      }
    if (closed) this.wakeSettleWaiters();
  }

  private longestOpenWindowMs(): number {
    const now = this.now().getTime();
    let longest = 0;
    for (const execution of this.unsettled.values())
      if (Number.isFinite(execution.lateWindowEndsAt))
        longest = Math.max(longest, execution.lateWindowEndsAt - now);
    return longest;
  }

  private nextSettlement(timeoutMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.settleWaiters.delete(wake);
        if (error) reject(error);
        else resolve();
      };
      const wake = () => finish();
      const abort = () => finish(signal.reason);
      const timer = setTimeout(wake, timeoutMs);
      this.settleWaiters.add(wake);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  private wakeSettleWaiters(): void {
    for (const wake of [...this.settleWaiters]) wake();
  }
}

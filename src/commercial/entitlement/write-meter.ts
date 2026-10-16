/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// One owner for a Write's settlement lifecycle. The invariant it holds: every allowance-authorized
// execution ends recorded, or released into a late window in which a change the plugin reports later
// is still charged to it — and a short-lived runtime stays up (drain) until every window closes.
//
// Callers see only an ExecutionCharge: authorize hands one out, the caller reports what became of the
// run through it, and the plugin's run events arrive through runEvent. Seats get a charge that does
// nothing — seats carry no usage counters.
import type { PluginOwner, ExecuteCodeResult, WriteAccessNotice } from "@framelink/plugin/protocol";
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
 * What the plugin says about a run after its caller may have stopped listening. The bridge forwards
 * these as they come, without judging them; what they cost is decided here.
 * `orphanReply` is a run's result that arrived after its caller gave up on it.
 */
export type RunEvent =
  | { type: "changed"; runId: string }
  | { type: "settled"; runId: string }
  | { type: "orphanReply"; runId: string; reply: ExecuteCodeResult };

/**
 * What became of one authorized execution, reported by the caller that runs it. End it exactly once,
 * with replied or lost, on every path — an unended allowance charge holds its reservation for good.
 */
export interface ExecutionCharge {
  /** The execution reached the plugin as `runId`. Call on submission: run events can beat the reply. */
  submitted(runId: string): void;
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

const SEAT_CHARGE: ExecutionCharge = { submitted() {}, replied() {}, lost() {} };

type LateRun = { figmaUserId: string; executionId: string; expiresAt: number };

export class WriteMeter {
  // executionId → figmaUserId: allowance-authorized executions not yet known to be a Write or not.
  // Counted as spent, so parallel calls can't all pass the gate on the same last Write.
  private readonly reservations = new Map<string, string>();
  // runId (the plugin's name for an execution) → the execution a late change is charged to.
  // expiresAt is Infinity while the caller still waits on the run.
  private readonly lateRuns = new Map<string, LateRun>();
  private readonly lateRunWaiters = new Set<() => void>();
  private readonly notifyPanel: (notice: WriteAccessNotice) => void;
  private readonly now: () => Date;

  constructor(
    private readonly access: WriteAccess,
    {
      notifyPanel = () => {},
      now = () => new Date(),
    }: { notifyPanel?: (notice: WriteAccessNotice) => void; now?: () => Date } = {},
  ) {
    this.notifyPanel = notifyPanel;
    this.now = now;
  }

  get framelinkApiUrl(): string {
    return this.access.framelinkApiUrl;
  }

  /**
   * May an execution attributed to this Plugin Owner start? An allowance authorization reserves
   * a Write until its charge ends. Allowance refusals also go to the plugin panel.
   */
  async authorize(owner: PluginOwner | null, executionId: string): Promise<ExecutionAdmission> {
    let decision = this.decide(owner);
    if (
      decision.kind === "refused" &&
      decision.reason === "allowance-exhausted" &&
      decision.signedIn
    ) {
      await this.access.recheckRefusedSeat(decision.figmaUserId);
      decision = this.decide(owner);
    }
    // Synchronous with the decision above, so no other call can decide in between.
    if (decision.kind === "refused") {
      if (decision.reason === "allowance-exhausted")
        this.notifyPanel(allowanceExhaustedNotice(decision));
      return { kind: "refused", refusal: decision };
    }
    if (decision.via === "seat")
      return { kind: "authorized", authorization: decision, charge: SEAT_CHARGE };
    this.reservations.set(executionId, decision.figmaUserId);
    return {
      kind: "authorized",
      authorization: decision,
      charge: this.allowanceCharge(decision.figmaUserId, executionId),
    };
  }

  /** The bridge's one wiring point for the plugin's run events. */
  runEvent(event: RunEvent): void {
    if (event.type === "settled") {
      if (this.lateRuns.delete(event.runId)) this.wakeLateRunWaiters();
      return;
    }
    if (event.type === "orphanReply" && !event.reply.documentChanged) return;
    // A change after the caller finished with the run, or one it gave up waiting for: recorded under
    // the run's own execution, so a second report — or one for a run already counted — changes nothing.
    const late = this.lateRuns.get(event.runId);
    if (!late) return;
    this.lateRuns.delete(event.runId);
    if (late.expiresAt > this.now().getTime())
      this.access.recordWrite(late.figmaUserId, late.executionId);
    this.wakeLateRunWaiters();
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
      await this.nextLateRunChange(remaining, signal);
    }
  }

  private decide(owner: PluginOwner | null): WriteAuthorization {
    const figmaUserId = owner?.figmaUserId;
    let reserved = 0;
    for (const reservedFor of this.reservations.values())
      if (reservedFor === figmaUserId) reserved++;
    return this.access.decide(owner, reserved);
  }

  private allowanceCharge(figmaUserId: string, executionId: string): ExecutionCharge {
    let ended = false;
    const end = (wrote: boolean) => {
      if (ended) return;
      ended = true;
      if (wrote) this.access.recordWrite(figmaUserId, executionId);
      this.release(executionId, { charged: wrote });
    };
    return {
      submitted: (runId) => {
        if (!ended) this.lateRuns.set(runId, { figmaUserId, executionId, expiresAt: Infinity });
      },
      replied: (documentChanged) => end(documentChanged),
      lost: ({ mayHaveRun }) => end(mayHaveRun),
    };
  }

  /**
   * The caller is done with the execution. Frees its reservation; unless it was charged, its run
   * stays watched until the ceiling for a change reported late. Also prunes expired windows.
   */
  private release(executionId: string, { charged }: { charged: boolean }): void {
    this.reservations.delete(executionId);
    const now = this.now().getTime();
    let closed = false;
    for (const [runId, late] of this.lateRuns) {
      if (late.executionId === executionId) {
        if (charged) {
          this.lateRuns.delete(runId);
          closed = true;
        } else this.lateRuns.set(runId, { ...late, expiresAt: now + LATE_DOCUMENT_CHANGE_MS });
      } else if (late.expiresAt <= now) {
        this.lateRuns.delete(runId);
        closed = true;
      }
    }
    if (closed) this.wakeLateRunWaiters();
  }

  private longestOpenWindowMs(): number {
    const now = this.now().getTime();
    let longest = 0;
    for (const late of this.lateRuns.values())
      if (Number.isFinite(late.expiresAt)) longest = Math.max(longest, late.expiresAt - now);
    return longest;
  }

  private nextLateRunChange(timeoutMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.lateRunWaiters.delete(wake);
        if (error) reject(error);
        else resolve();
      };
      const wake = () => finish();
      const abort = () => finish(signal.reason);
      const timer = setTimeout(wake, timeoutMs);
      this.lateRunWaiters.add(wake);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  private wakeLateRunWaiters(): void {
    for (const wake of [...this.lateRunWaiters]) wake();
  }
}

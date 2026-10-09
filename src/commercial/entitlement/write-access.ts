/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The imperative shell around write authorization: reads and writes the state file, talks to the
// Framelink app, and pushes notices to the plugin panel. Every decision it acts on comes from the
// pure modules (write-authorization.ts, write-ledger.ts).
//
// Network is NEVER on the path that says yes: the gate decides from the cached seat and the counts
// on disk, so an outage can't stop a validated seat or an unspent allowance from writing. The only
// awaited request is a seat re-check for a signed-in Authorizing User who would otherwise be refused.
//
// What the gate counts is more than the file: executions it authorized that haven't finished (a
// Write they may still become) and Writes the file couldn't take (a failed save). Both live in this
// process's memory only, so they hold against its own parallel calls, not another server's.
import { setTimeout as pause } from "node:timers/promises";
import type { AuthorizingUser } from "~/commercial/plugin-bridge/approval.js";
import { Logger } from "~/utils/logger.js";
import { FramelinkApiUnavailableError, type FramelinkApiClient } from "./framelink-api.js";
import type { WriteAccessState, WriteAccessStore } from "./write-access-store.js";
import {
  allowanceExhaustedNotice,
  authorizeWriteExecution,
  isSeatRevalidationDue,
  type CachedSeat,
  type WriteAccessNotice,
  type WriteAuthorization,
} from "./write-authorization.js";
import {
  applyUsageReportResponse,
  mergeWriteLedgers,
  nextUsageReport,
  recordWriteExecution,
  utcMonthOf,
  writesUsedThisMonth,
  type WriteLedger,
} from "./write-ledger.js";

// Batching: at most one usage report per Authorizing User per this interval (the app rate-limits installs).
const USAGE_REPORT_INTERVAL_MS = 10_000;
// How stale the server's count may get before a connected server asks again, pending writes or not.
const USAGE_RECONCILE_MS = 30 * 60 * 1000;
// A refused, signed-in Authorizing User may have just bought a seat; re-check at most this often while refused.
const REFUSAL_SEAT_RECHECK_MS = 30_000;
// RFC 8628 §3.5: each slow_down adds five seconds to the polling interval.
const SLOW_DOWN_STEP_MS = 5_000;
// How often to retry saving Writes the state file refused.
const PERSIST_RETRY_MS = 30_000;
// How long after its caller finished a run can still be charged for a late change. At least the
// plugin's own watch (LATE_CHANGE_WINDOW_MS in plugin/src/code.ts), plus slack for the relay.
const LATE_DOCUMENT_CHANGE_MS = 90_000;

export class WriteAccess {
  private readonly settlementWaiters = new Map<string, Set<() => void>>();
  private readonly lifetime = new AbortController();

  /** Stop device polling when a short-lived runtime exits; recorded writes stay persisted. */
  stop(): void {
    this.lifetime.abort();
  }
  private readonly now: () => Date;
  private readonly notifyPanel: (notice: WriteAccessNotice) => void;
  // Keyed by figmaUserId. One device flow per Authorizing User; a second click re-shows the live code.
  private readonly signIns = new Map<
    string,
    { notice: WriteAccessNotice | null; done: Promise<void> }
  >();
  private readonly reportTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly reportsInFlight = new Map<string, Promise<void>>();
  private readonly lastReportAt = new Map<string, number>();
  private readonly lastSeatCheckAt = new Map<string, number>();
  // executionId → figmaUserId: allowance-authorized executions not yet known to be a Write or not.
  // Counted as spent, so parallel calls can't all pass the gate on the same last Write.
  private readonly reservations = new Map<string, string>();
  // Writes recorded here that the state file hasn't taken yet. Folded into every read and every
  // successful save, so they count and get reported until one lands.
  private unpersistedWrites: WriteLedger = {};
  private persistRetry: ReturnType<typeof setTimeout> | undefined;
  // runId (the plugin's name for an execution) → the execution a late change is charged to.
  private readonly lateRuns = new Map<
    string,
    { figmaUserId: string; executionId: string; expiresAt: number }
  >();

  constructor(
    private readonly api: FramelinkApiClient,
    private readonly store: WriteAccessStore,
    {
      notifyPanel = () => {},
      now = () => new Date(),
    }: { notifyPanel?: (notice: WriteAccessNotice) => void; now?: () => Date } = {},
  ) {
    this.notifyPanel = notifyPanel;
    this.now = now;
  }

  get framelinkApiUrl(): string {
    return this.api.baseUrl;
  }

  /**
   * May this execution, attributed to this Authorizing User, start? Refusals also go to the plugin
   * panel. An allowance authorization reserves a Write until recordWriteExecution or
   * releaseWriteExecution settles it — every authorized execution must reach one of the two.
   */
  async authorizeWriteExecution(
    authorizingUser: AuthorizingUser | null,
    executionId: string,
  ): Promise<WriteAuthorization> {
    let decision = this.decide(authorizingUser);
    if (
      decision.kind === "refused" &&
      decision.reason === "allowance-exhausted" &&
      decision.signedIn
    ) {
      const checkedAt = this.lastSeatCheckAt.get(decision.figmaUserId) ?? 0;
      if (this.now().getTime() - checkedAt >= REFUSAL_SEAT_RECHECK_MS) {
        await this.validateSeat(decision.figmaUserId);
        decision = this.decide(authorizingUser);
      }
    }
    // Synchronous with the decision above, so no other call can decide in between.
    if (decision.kind === "authorized" && decision.via === "allowance")
      this.reservations.set(executionId, decision.figmaUserId);
    if (decision.kind === "refused" && decision.reason === "allowance-exhausted")
      this.notifyPanel(allowanceExhaustedNotice(decision));
    return decision;
  }

  /**
   * Count a Write — call once per execution that changed the document (or may have: a run lost
   * mid-execution). Seat-authorized executions aren't counted; seats carry no usage counters.
   */
  recordWriteExecution(authorization: WriteAuthorization, executionId: string): void {
    if (authorization.kind !== "authorized" || authorization.via !== "allowance") return;
    this.recordWrite(authorization.figmaUserId, executionId);
  }

  /**
   * The execution ended without a Write — as far as its caller knows. Frees its reservation; if it
   * reached the plugin as `runId`, a change reported late under that id is still charged to it
   * (recordLateDocumentChange). A no-op for an execution already recorded, or never reserved.
   */
  releaseWriteExecution(executionId: string, runId: string | null): void {
    const figmaUserId = this.reservations.get(executionId);
    if (figmaUserId === undefined) return;
    this.reservations.delete(executionId);
    const now = this.now().getTime();
    for (const [id, late] of this.lateRuns) if (late.expiresAt <= now) this.lateRuns.delete(id);
    if (runId !== null)
      this.lateRuns.set(runId, {
        figmaUserId,
        executionId,
        expiresAt: now + LATE_DOCUMENT_CHANGE_MS,
      });
  }

  /** Keep a short-lived relay alive for the existing late-change accounting window. */
  waitForWriteSettlement(
    runId: string,
    signal: AbortSignal,
    onWaiting?: (remainingMs: number) => void,
  ): Promise<void> {
    signal.throwIfAborted();
    const late = this.lateRuns.get(runId);
    if (!late) return Promise.resolve();
    const remaining = Math.max(0, late.expiresAt - this.now().getTime());
    if (!remaining) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        const waiting = this.settlementWaiters.get(runId);
        waiting?.delete(done);
        if (!waiting?.size) this.settlementWaiters.delete(runId);
        if (error) reject(error);
        else resolve();
      };
      const done = () => finish();
      const abort = () => finish(signal.reason);
      const timer = setTimeout(done, remaining);
      const waiting = this.settlementWaiters.get(runId) ?? new Set<() => void>();
      waiting.add(done);
      this.settlementWaiters.set(runId, waiting);
      signal.addEventListener("abort", abort, { once: true });
      onWaiting?.(remaining);
    });
  }

  /**
   * The plugin saw a run change the document after its caller finished with it. Recorded under the
   * run's own execution, so a second report — or one for a run already counted — changes nothing.
   */
  recordLateDocumentChange(runId: string): void {
    const late = this.lateRuns.get(runId);
    if (!late) return;
    this.lateRuns.delete(runId);
    if (late.expiresAt <= this.now().getTime()) return;
    this.recordWrite(late.figmaUserId, late.executionId);
    for (const done of this.settlementWaiters.get(runId) ?? []) done();
  }

  /**
   * Re-check a signed-in Authorizing User's seat. Only a successful answer changes it: seat:false revokes,
   * 401 (or a token bound to someone else) drops the token, and an outage leaves it exactly as it was.
   */
  async validateSeat(figmaUserId: string): Promise<void> {
    const cached = this.readState().seats[figmaUserId];
    if (!cached) return;
    this.lastSeatCheckAt.set(figmaUserId, this.now().getTime());
    let result;
    try {
      result = await this.api.getWriteEntitlement(cached.token);
    } catch (err) {
      if (!(err instanceof FramelinkApiUnavailableError)) throw err;
      Logger.log(`Seat check unavailable, keeping the last validated seat: ${err.message}`);
      return;
    }
    this.updateState((state) => {
      const seats = { ...state.seats };
      // A sign-in that finished while this request was out owns the slot now.
      if (seats[figmaUserId]?.token !== cached.token) return state;
      if (result.kind === "invalid-token" || result.figmaUserId !== figmaUserId)
        delete seats[figmaUserId];
      else
        seats[figmaUserId] = {
          token: cached.token,
          seat: result.seat,
          validatedAt: result.validatedAt,
        };
      return { ...state, seats };
    });
  }

  /**
   * Report unreported Writes and take the server's count back. Paid Authorizing Users don't report. Also
   * used with an empty batch to reconcile: the server's count covers the Authorizing User's other devices.
   */
  reportWriteUsage(figmaUserId: string): Promise<void> {
    const inFlight = this.reportsInFlight.get(figmaUserId);
    if (inFlight) return inFlight;
    const report = this.sendUsageReport(figmaUserId).finally(() =>
      this.reportsInFlight.delete(figmaUserId),
    );
    this.reportsInFlight.set(figmaUserId, report);
    return report;
  }

  /**
   * Bring an Authorizing User's seat and counts up to date with the server. `force` is session approval,
   * which checks unconditionally; otherwise each half runs only once it is stale.
   */
  async syncWriteAccess(authorizingUser: AuthorizingUser, { force = false } = {}): Promise<void> {
    const { figmaUserId } = authorizingUser;
    const now = this.now();
    const state = this.readState();
    const seat = state.seats[figmaUserId];
    if (seat && (force || isSeatRevalidationDue(seat, now))) await this.validateSeat(figmaUserId);
    const ledger = state.ledger[figmaUserId];
    const reconciled = ledger?.serverReported;
    const stale =
      !reconciled ||
      reconciled.month !== utcMonthOf(now) ||
      now.getTime() - Date.parse(reconciled.reportedAt) >= USAGE_RECONCILE_MS;
    if (force || stale || nextUsageReport(state.ledger, figmaUserId).length > 0)
      await this.reportWriteUsage(figmaUserId);
  }

  /**
   * Start (or re-show) the device sign-in for this Authorizing User. The panel gets the code and
   * verification URL, then the outcome. Resolves when the flow ends, for callers that wait.
   */
  startDeviceSignIn(authorizingUser: AuthorizingUser | null): Promise<void> {
    if (!authorizingUser) {
      this.notifyPanel({
        kind: "sign-in-failed",
        message: "Allow this session first — the sign-in is for the Figma user who approves it.",
      });
      return Promise.resolve();
    }
    const live = this.signIns.get(authorizingUser.figmaUserId);
    if (live) {
      if (live.notice) this.notifyPanel(live.notice);
      return live.done;
    }
    const flow: { notice: WriteAccessNotice | null; done: Promise<void> } = {
      notice: null,
      done: Promise.resolve(),
    };
    flow.done = this.runDeviceSignIn(authorizingUser.figmaUserId, (notice) => {
      flow.notice = notice;
      this.notifyPanel(notice);
    }).finally(() => this.signIns.delete(authorizingUser.figmaUserId));
    this.signIns.set(authorizingUser.figmaUserId, flow);
    return flow.done;
  }

  private decide(authorizingUser: AuthorizingUser | null): WriteAuthorization {
    const now = this.now();
    const state = this.readState();
    const figmaUserId = authorizingUser?.figmaUserId ?? null;
    let reserved = 0;
    for (const owner of this.reservations.values()) if (owner === figmaUserId) reserved++;
    return authorizeWriteExecution({
      figmaUserId,
      seat: figmaUserId === null ? null : (state.seats[figmaUserId] ?? null),
      usedThisMonth:
        figmaUserId === null ? 0 : writesUsedThisMonth(state.ledger, figmaUserId, now) + reserved,
      now,
    });
  }

  private recordWrite(figmaUserId: string, executionId: string): void {
    this.reservations.delete(executionId);
    this.unpersistedWrites = recordWriteExecution(
      this.unpersistedWrites,
      figmaUserId,
      executionId,
      this.now(),
    );
    this.persistRecordedWrites();
    this.scheduleUsageReport(figmaUserId);
  }

  /** The file's state with this process's unsaved Writes folded in — what every decision reads. */
  private readState(): WriteAccessState {
    const state = this.store.read();
    return { ...state, ledger: mergeWriteLedgers(state.ledger, this.unpersistedWrites) };
  }

  /** Every save carries the unsaved Writes along; they're dropped from memory only once one lands. */
  private updateState(transform: (state: WriteAccessState) => WriteAccessState): WriteAccessState {
    const unsaved = this.unpersistedWrites;
    const saved = this.store.update((state) =>
      transform({ ...state, ledger: mergeWriteLedgers(state.ledger, unsaved) }),
    );
    this.unpersistedWrites = {};
    return saved;
  }

  // Never throws: the canvas already changed, and failing the tool call now would tell the agent
  // otherwise. The Writes stay counted from memory and are retried until a save lands.
  private persistRecordedWrites(): void {
    clearTimeout(this.persistRetry);
    this.persistRetry = undefined;
    try {
      this.updateState((state) => state);
    } catch (err) {
      Logger.log(
        `Could not save Writes to ${this.store.file}; counting them from memory and retrying: ${(err as Error).message}`,
      );
      this.persistRetry = setTimeout(() => this.persistRecordedWrites(), PERSIST_RETRY_MS);
      this.persistRetry.unref();
    }
  }

  private async sendUsageReport(figmaUserId: string): Promise<void> {
    const state = this.readState();
    if (state.seats[figmaUserId]?.seat === true) return;
    const executions = nextUsageReport(state.ledger, figmaUserId);
    this.lastReportAt.set(figmaUserId, this.now().getTime());
    let response;
    try {
      response = await this.api.reportWriteUsage({
        installId: state.installId,
        figmaUserId,
        executions,
      });
    } catch (err) {
      if (!(err instanceof FramelinkApiUnavailableError)) throw err;
      Logger.log(`Write usage report deferred: ${err.message}`);
      return;
    }
    const updated = this.updateState((current) => ({
      ...current,
      ledger: applyUsageReportResponse(
        current.ledger,
        figmaUserId,
        executions.map((e) => e.executionId),
        response,
        this.now(),
      ),
    }));
    if (nextUsageReport(updated.ledger, figmaUserId).length > 0)
      this.scheduleUsageReport(figmaUserId);
  }

  // Trailing throttle: Writes landing in a burst ride one report.
  private scheduleUsageReport(figmaUserId: string): void {
    if (this.reportTimers.has(figmaUserId)) return;
    const since = this.now().getTime() - (this.lastReportAt.get(figmaUserId) ?? 0);
    const timer = setTimeout(
      () => {
        this.reportTimers.delete(figmaUserId);
        this.reportWriteUsage(figmaUserId).catch((err: Error) =>
          Logger.log(`Write usage report failed: ${err.message}`),
        );
      },
      Math.max(0, USAGE_REPORT_INTERVAL_MS - since),
    );
    timer.unref();
    this.reportTimers.set(figmaUserId, timer);
  }

  private async runDeviceSignIn(
    figmaUserId: string,
    notify: (notice: WriteAccessNotice) => void,
  ): Promise<void> {
    let signIn;
    try {
      signIn = await this.api.requestDeviceSignIn(figmaUserId);
    } catch (err) {
      if (!(err instanceof FramelinkApiUnavailableError)) throw err;
      notify({ kind: "sign-in-failed", message: "Couldn't reach Framelink. Try again shortly." });
      return;
    }
    if (this.lifetime.signal.aborted) return;
    notify({
      kind: "sign-in-pending",
      userCode: signIn.userCode,
      verificationUri: signIn.verificationUri,
    });
    const deadline = this.now().getTime() + signIn.expiresInMs;
    let intervalMs = signIn.intervalMs;
    while (this.now().getTime() < deadline) {
      try {
        await pause(intervalMs, undefined, { signal: this.lifetime.signal });
      } catch {
        return;
      }
      let poll;
      try {
        poll = await this.api.pollDeviceToken(signIn.deviceCode);
      } catch (err) {
        if (!(err instanceof FramelinkApiUnavailableError)) throw err;
        continue; // a dropped poll is not an answer; the code is still good until it expires
      }
      if (this.lifetime.signal.aborted) return;
      if (poll.kind === "pending") continue;
      if (poll.kind === "slow-down") {
        intervalMs += SLOW_DOWN_STEP_MS;
        continue;
      }
      if (poll.kind === "denied") {
        notify({ kind: "sign-in-failed", message: "The sign-in was declined." });
        return;
      }
      if (poll.kind === "expired") break;
      const seat = await this.adoptSignInToken(figmaUserId, poll.accessToken);
      if (!seat) {
        notify({
          kind: "sign-in-failed",
          message: "Framelink didn't accept that sign-in for this Figma user. Try again.",
        });
        return;
      }
      notify({ kind: "signed-in", seat: seat.seat });
      return;
    }
    notify({ kind: "sign-in-failed", message: "The sign-in code expired. Start again." });
  }

  /**
   * Swap a freshly issued token in — only once it checks out, so a seat already validated survives
   * a sign-in whose token Framelink rejects (null: nothing changed). If the check can't be made (an
   * outage), the new token keeps the old seat's standing until the next check answers.
   */
  private async adoptSignInToken(figmaUserId: string, token: string): Promise<CachedSeat | null> {
    this.lastSeatCheckAt.set(figmaUserId, this.now().getTime());
    let result;
    try {
      result = await this.api.getWriteEntitlement(token);
    } catch (err) {
      if (!(err instanceof FramelinkApiUnavailableError)) throw err;
      Logger.log(`Seat check unavailable after sign-in, will re-check: ${err.message}`);
      result = null;
    }
    if (result && (result.kind === "invalid-token" || result.figmaUserId !== figmaUserId))
      return null;
    const updated = this.updateState((state) => {
      const previous = state.seats[figmaUserId];
      const seat: CachedSeat = result
        ? { token, seat: result.seat, validatedAt: result.validatedAt }
        : { token, seat: previous?.seat ?? null, validatedAt: previous?.validatedAt ?? null };
      return { ...state, seats: { ...state.seats, [figmaUserId]: seat } };
    });
    return updated.seats[figmaUserId] ?? null;
  }
}

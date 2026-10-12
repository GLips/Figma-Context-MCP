/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The imperative shell around write-access state: reads and writes the state file and keeps seats
// and counts in step with the Framelink app. Every decision it acts on comes from the pure modules
// (write-authorization.ts, write-ledger.ts); a single execution's lifecycle is WriteMeter's, and the
// device sign-in is DeviceSignIn's.
//
// Network is NEVER on the path that says yes: the gate decides from the cached seat and the counts
// on disk, so an outage can't stop a validated seat or an unspent allowance from writing. The only
// awaited request is a seat re-check for a signed-in Authorizing User who would otherwise be refused.
//
// What the gate counts is more than the file: executions authorized but not finished (WriteMeter's
// reservations) and Writes the file couldn't take (a failed save, kept here). Both live in this
// process's memory only, so they hold against its own parallel calls, not another server's.
import type { AuthorizingUser } from "@framelink/plugin/protocol";
import { Logger } from "~/utils/logger.js";
import { FramelinkApiError, type FramelinkApiClient } from "./framelink-api.js";
import type {
  PersistedWriteAccessState,
  WriteAccessState,
  WriteAccessStore,
} from "./write-access-store.js";
import {
  authorizeWriteExecution,
  isSeatRevalidationDue,
  type CachedSeat,
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
// How often to retry saving Writes the state file refused.
const PERSIST_RETRY_MS = 30_000;

export class WriteAccess {
  private readonly now: () => Date;
  private readonly reportTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly reportsInFlight = new Map<string, Promise<void>>();
  private readonly lastReportAt = new Map<string, number>();
  private readonly lastSeatCheckAt = new Map<string, number>();
  // Writes recorded here that the state file hasn't taken yet. Folded into every read and every
  // successful save, so they count and get reported until one lands.
  private unpersistedWrites: WriteLedger = {};
  private persistRetry: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly api: FramelinkApiClient,
    private readonly store: WriteAccessStore,
    { now = () => new Date() }: { now?: () => Date } = {},
  ) {
    this.now = now;
  }

  get framelinkApiUrl(): string {
    return this.api.baseUrl;
  }

  /**
   * The gate's answer from the cached seat and the month's counts, plus `inFlightWrites` the caller
   * has authorized and not yet settled (WriteMeter's reservations). Synchronous, so the caller can
   * reserve on the same tick it decides.
   */
  decide(authorizingUser: AuthorizingUser | null, inFlightWrites: number): WriteAuthorization {
    const now = this.now();
    const state = this.readState();
    const figmaUserId = authorizingUser?.figmaUserId ?? null;
    return authorizeWriteExecution({
      figmaUserId,
      seat: figmaUserId === null ? null : (state.seats[figmaUserId] ?? null),
      usedThisMonth:
        figmaUserId === null
          ? 0
          : writesUsedThisMonth(state.ledger, figmaUserId, now) + inFlightWrites,
      now,
    });
  }

  /** A signed-in Authorizing User refused for the allowance may have just bought a seat: re-check, throttled. */
  async recheckRefusedSeat(figmaUserId: string): Promise<void> {
    const checkedAt = this.lastSeatCheckAt.get(figmaUserId) ?? 0;
    if (this.now().getTime() - checkedAt >= REFUSAL_SEAT_RECHECK_MS)
      await this.validateSeat(figmaUserId);
  }

  /**
   * Count a Write: one execution that changed the document (or may have). Idempotent on
   * executionId. Never throws — the canvas already changed; an unsaved Write counts from memory.
   */
  recordWrite(figmaUserId: string, executionId: string): void {
    this.unpersistedWrites = recordWriteExecution(
      this.unpersistedWrites,
      figmaUserId,
      executionId,
      this.now(),
    );
    this.persistRecordedWrites();
    this.scheduleUsageReport(figmaUserId);
  }

  /**
   * Re-check a signed-in Authorizing User's seat. Only a successful answer changes it: seat:false revokes,
   * 401 (or a token bound to someone else) drops the token, and an outage or any other refusal leaves
   * it exactly as it was.
   */
  async validateSeat(figmaUserId: string): Promise<void> {
    const cached = this.readState().seats[figmaUserId];
    if (!cached) return;
    this.lastSeatCheckAt.set(figmaUserId, this.now().getTime());
    let result;
    try {
      result = await this.api.getWriteEntitlement(cached.token);
    } catch (err) {
      if (!(err instanceof FramelinkApiError)) throw err;
      Logger.log(`Seat check ${err.kind}, keeping the last validated seat: ${err.message}`);
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

  /** The file's state with this process's unsaved Writes folded in — what every decision reads. */
  private readState(): WriteAccessState {
    const state = this.store.read();
    return { ...state, ledger: mergeWriteLedgers(state.ledger, this.unpersistedWrites) };
  }

  /** Every save carries the unsaved Writes along; they're dropped from memory only once one lands. */
  private updateState(
    transform: (state: WriteAccessState) => WriteAccessState,
  ): PersistedWriteAccessState {
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
    // The first report is what needs an installId, so it's minted here, not on a read.
    const installId = this.store.ensureInstallId();
    this.lastReportAt.set(figmaUserId, this.now().getTime());
    let response;
    try {
      response = await this.api.reportWriteUsage({
        installId,
        figmaUserId,
        executions,
      });
    } catch (err) {
      if (!(err instanceof FramelinkApiError)) throw err;
      Logger.log(
        `Write usage report ${err.kind === "rejected" ? "rejected" : "deferred"}: ${err.message}`,
      );
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

  /**
   * Swap a freshly issued token in — only once it checks out, so a seat already validated survives
   * a sign-in whose token Framelink rejects (null: nothing changed). If the check can't be made (an
   * outage), the new token keeps the old seat's standing until the next check answers.
   */
  async adoptSignInToken(figmaUserId: string, token: string): Promise<CachedSeat | null> {
    this.lastSeatCheckAt.set(figmaUserId, this.now().getTime());
    let result;
    try {
      result = await this.api.getWriteEntitlement(token);
    } catch (err) {
      if (!(err instanceof FramelinkApiError)) throw err;
      Logger.log(`Seat check ${err.kind} after sign-in, will re-check: ${err.message}`);
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

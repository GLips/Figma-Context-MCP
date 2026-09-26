/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The free-allowance ledger: which Writes each Authorizing User has spent, per UTC calendar month. Pure —
// every function returns a new ledger; write-access-store.ts persists it.
//
// The counting rules are licensing/LICENSE-Framelink-Commercial.md "Limit of the grant", fixed for
// the release: one execution that changed the document is one Write; an executionId counts once however
// often it is recorded or reported; months reset at 00:00 UTC on the 1st with no rollover.

/** Writes per Authorizing User per UTC calendar month. Shipped with the release; no server response lowers or raises it. */
export const FREE_WRITE_ALLOWANCE = 100;

/** The report endpoint's batch ceiling. */
export const MAX_EXECUTIONS_PER_USAGE_REPORT = 500;

/** A UTC calendar month as `YYYY-MM`. */
export type UtcMonth = string;

export interface LedgerExecution {
  executionId: string;
  /** ISO timestamp of the execution. The month it falls in is the month it is spent from. */
  at: string;
  /** Whether a usage report carrying it has been accepted by the server. */
  reported: boolean;
}

export interface AuthorizingUserLedger {
  executions: LedgerExecution[];
  /**
   * The server's last answer for this Authorizing User: its count covers every device and install, so it can
   * exceed the local one. Only ever used to RAISE the effective count (writesUsedThisMonth).
   */
  serverReported: { month: UtcMonth; usedThisMonth: number; reportedAt: string } | null;
}

/** Keyed by figmaUserId. */
export type WriteLedger = Record<string, AuthorizingUserLedger>;

export function utcMonthOf(at: Date): UtcMonth {
  return at.toISOString().slice(0, 7);
}

/** The instant the month containing `at` ends and its allowance resets. */
export function allowanceResetsAt(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
}

function ledgerFor(ledger: WriteLedger, figmaUserId: string): AuthorizingUserLedger {
  return ledger[figmaUserId] ?? { executions: [], serverReported: null };
}

/**
 * Record one Write. Idempotent on executionId: a retried execution, or the same one recorded twice,
 * counts once.
 */
export function recordWriteExecution(
  ledger: WriteLedger,
  figmaUserId: string,
  executionId: string,
  at: Date,
): WriteLedger {
  const current = ledgerFor(ledger, figmaUserId);
  if (current.executions.some((e) => e.executionId === executionId)) return ledger;
  return {
    ...ledger,
    [figmaUserId]: {
      ...current,
      executions: [...current.executions, { executionId, at: at.toISOString(), reported: false }],
    },
  };
}

/**
 * Fold recorded Writes into a ledger, each at its own timestamp. Idempotent on executionId like
 * recordWriteExecution, so folding the same Writes in twice changes nothing.
 */
export function mergeWriteLedgers(ledger: WriteLedger, recorded: WriteLedger): WriteLedger {
  let merged = ledger;
  for (const [figmaUserId, { executions }] of Object.entries(recorded))
    for (const { executionId, at } of executions)
      merged = recordWriteExecution(merged, figmaUserId, executionId, new Date(at));
  return merged;
}

/** The effective count: max(local Writes this month, the server's last count for this month). */
export function writesUsedThisMonth(ledger: WriteLedger, figmaUserId: string, now: Date): number {
  const current = ledgerFor(ledger, figmaUserId);
  const month = utcMonthOf(now);
  const local = current.executions.filter((e) => utcMonthOf(new Date(e.at)) === month).length;
  const server = current.serverReported?.month === month ? current.serverReported.usedThisMonth : 0;
  return Math.max(local, server);
}

/** The next batch to report: executions the server hasn't accepted yet, oldest first. */
export function nextUsageReport(
  ledger: WriteLedger,
  figmaUserId: string,
): { executionId: string; at: string }[] {
  return ledgerFor(ledger, figmaUserId)
    .executions.filter((e) => !e.reported)
    .slice(0, MAX_EXECUTIONS_PER_USAGE_REPORT)
    .map(({ executionId, at }) => ({ executionId, at }));
}

/**
 * Fold an accepted report back in: mark its executions reported, take the server's count, and drop
 * reported executions from past months — they can no longer affect any count.
 */
export function applyUsageReportResponse(
  ledger: WriteLedger,
  figmaUserId: string,
  reportedExecutionIds: readonly string[],
  response: { usedThisMonth: number; resetsAt: string },
  now: Date,
): WriteLedger {
  const current = ledgerFor(ledger, figmaUserId);
  const reported = new Set(reportedExecutionIds);
  const month = utcMonthOf(now);
  // `resetsAt` is the exclusive end of the server's month, so the month it counted is the one a
  // millisecond earlier — named from the server's clock, not ours.
  const serverMonth = utcMonthOf(new Date(Date.parse(response.resetsAt) - 1));
  const executions = current.executions
    .map((e) => (reported.has(e.executionId) ? { ...e, reported: true } : e))
    .filter((e) => !e.reported || utcMonthOf(new Date(e.at)) >= month);
  return {
    ...ledger,
    [figmaUserId]: {
      executions,
      serverReported: {
        month: serverMonth,
        usedThisMonth: response.usedThisMonth,
        reportedAt: now.toISOString(),
      },
    },
  };
}
